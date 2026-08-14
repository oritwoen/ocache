// HTTP response caching: wires this directory's modules onto `cache.ts`'s `cachedFunction`.
// Holds only the wiring — the `CacheOptions` hooks, the resolver, the serve path and the
// revalidation helpers.

import { hash } from "../hash.ts";
import { cachedFunction, expireCache, invalidateCache, resolveCacheKeys } from "../cache.ts";
import { resolveStorage } from "../storage.ts";

import { requiresRevalidation } from "./cache-control.ts";
import { integrityOpts, resolveHandlerConfig } from "./config.ts";
import { defaultHandleCacheHeaders, notModifiedHeaders } from "./conditional.ts";
import { deserializeEntry, serializeResponse } from "./entry.ts";
import { cacheableMethods, methodKey, resolveKey } from "./key.ts";
import { narrowRequest, resolveBypass } from "./request.ts";
import { validateEntry } from "./validate.ts";

import type {
  HTTPEvent,
  EventHandler,
  CachedEventHandler,
  CacheOptions,
  CachedEventHandlerOptions,
  ResponseCacheEntry,
} from "../types.ts";

/**
 * Wraps an HTTP event handler with response caching: keys by request origin, path, varied
 * headers and method, synthesizes `cache-control`/`etag`/`last-modified`, and answers `304`.
 *
 * Only `GET`/`HEAD` without a `Range` header is cacheable (everything else passes through
 * untouched), only `200`/`203`/`301`/`308` is stored, and a response opting itself out
 * (`no-store`, `private`, `no-cache`, zero shared lifetime, `Vary: *`) is served but never
 * stored — nor is one whose own `Vary` names a header outside `varies`, which a single entry
 * cannot honor. `must-revalidate` is not an opt-out — stored, served fresh, never served stale.
 *
 * @param handler - The event handler to cache.
 * @param opts - Cache and HTTP-specific configuration options.
 * @returns A cached event handler, also exposing `.resolveKeys(event)`, `.invalidate(event)`
 *   and `.expire(event)` — keyed exactly as it caches, covering every method variant.
 */
export function defineCachedHandler<E extends HTTPEvent = HTTPEvent>(
  handler: EventHandler<E>,
  opts: CachedEventHandlerOptions<E> = {},
): CachedEventHandler<E> {
  // `name` resolved before defaults merge (config.ts). `opts` rebound to a shared object —
  // caller's own object never written to (.agents/http/key.md).
  const config = resolveHandlerConfig(handler, opts);
  opts = config.opts;
  const { statusHeader } = config;

  const toResponse =
    opts.toResponse ||
    ((rawValue: unknown) =>
      rawValue instanceof Response ? rawValue : new Response(String(rawValue)));

  const createResponse =
    opts.createResponse ||
    ((body: string | Uint8Array | null, init: ResponseInit) =>
      new Response(body as BodyInit | null, init));

  const handleCacheHeaders = opts.handleCacheHeaders || defaultHandleCacheHeaders;

  // `entry.value` holds the serialized `ResponseCacheEntry` once stored, not the live `Response`.
  const _opts: CacheOptions<Response> = {
    ...opts,
    // Injects the cache-status header into a cloned value — never mutates the stored entry.
    transform: statusHeader
      ? (entry) => {
          const value = entry.value as unknown as ResponseCacheEntry | undefined;
          if (!value) {
            return;
          }
          return {
            ...value,
            headers: {
              ...value.headers,
              [statusHeader]: String(entry.status).toUpperCase(),
            },
          };
        }
      : undefined,
    // `must-revalidate` constrains stale, not storage (RFC 9111 §5.2.2.2) — persist
    // `staleMaxAge: 0`, computed first; caller's hook isolated in its own `try` (throw can't drop it).
    getMaxAge: async (entry) => {
      const res = entry.value;
      // Headers only — the body is read exactly once, by `serialize`, which runs after this.
      const override =
        res instanceof Response && requiresRevalidation(res.headers.get("cache-control"))
          ? { staleMaxAge: 0 }
          : undefined;
      let dynamic: { maxAge?: number; staleMaxAge?: number } | undefined;
      try {
        const resolved = await opts.getMaxAge?.(entry);
        // Normalize the caller's shorthand so the override below can merge with it.
        dynamic = typeof resolved === "number" ? { maxAge: resolved } : resolved;
      } catch (error) {
        if (opts.onError) {
          opts.onError(error);
        } else {
          console.error("[cache] getMaxAge hook error.", error);
        }
      }
      return override ? { ...dynamic, ...override } : dynamic;
    },
    // Write-side seam (entry.ts). Handed the whole entry, not just `Response` — advertises
    // the lifetimes `getMaxAge` above resolved onto it (finding 10.2).
    serialize: (entry) => serializeResponse(config, entry),
    // Built-in bypass ∨ caller's check (request.ts), evaluated once per call — resolver's
    // narrowing reads the same memoized verdict (`cache.ts` short-circuits on `true`).
    shouldBypassCache: (event: HTTPEvent) => resolveBypass(config, event),
    // Key = resource identity + method component; see `key.ts` for both halves.
    getKey: async (event: HTTPEvent) =>
      methodKey(await resolveKey(config, event), event.req.method),
    // Always inspects the serialized shape: write, right after `serialize`; read, as persisted.
    validate: (entry) => validateEntry(config, entry.value as unknown as ResponseCacheEntry),
    group: opts.group || "handlers",
    integrity: opts.integrity || hash([handler, integrityOpts(opts)]),
  };

  // Bypassed calls skip `serialize` entirely — returns the live `Response` untouched.
  const cachedFn = cachedFunction<Response>(async (event: HTTPEvent) => {
    // Self-gates on the composed bypass verdict — excluded requests keep credentials/query intact.
    narrowRequest(config, event);

    // Call handler
    const rawValue = await handler(event as E);
    return toResponse(rawValue, event as E);
  }, _opts);

  const cachedHandler: EventHandler<E> = async (event) => {
    // Headers-only mode
    if (opts.headersOnly) {
      if (handleCacheHeaders(event, { maxAge: opts.maxAge })) {
        return createResponse(null, { status: 304 });
      }
      return handler(event);
    }

    // Call with cache
    const cached = (await cachedFn(event))! as Response | ResponseCacheEntry;

    // Bypassed: live `Response`, no `serialize`/`transform` — passed through untouched (no
    // body buffering, no synthesized headers, no bogus 304).
    if (cached instanceof Response) {
      return cached;
    }
    const response = cached;

    // Check for cache headers
    if (
      handleCacheHeaders(event, {
        modifiedTime: new Date(response.headers["last-modified"] as string),
        etag: response.headers.etag as string,
        maxAge: opts.maxAge,
      })
    ) {
      return createResponse(null, {
        status: 304,
        headers: notModifiedHeaders(response.headers, statusHeader),
      });
    }

    // Read half of the codec (null-body statuses, binary decode) lives in `entry.ts`.
    const { body, init } = deserializeEntry(response);
    return createResponse(body, init);
  };

  // issue #71: revalidation from the event, no key reconstruction. Covers every method
  // variant (own variant first → `resolveKeys()[0]`), so a purge can't strand a sibling entry.
  const variantOptions = async (event: E) => {
    // Variants spread `_opts` fresh — resolve storage first, or a purge before the first
    // request leaves each copy building its own default storage (silent no-op).
    resolveStorage(_opts);
    const key = await resolveKey(config, event);
    const methods = cacheableMethods.includes(event.req.method)
      ? [event.req.method, ...cacheableMethods.filter((m) => m !== event.req.method)]
      : // A non-cacheable event (e.g. a POST webhook trigger) has no variant of its own.
        cacheableMethods;
    return methods.map((method) => {
      const _key = methodKey(key, method);
      return { ..._opts, getKey: () => _key };
    });
  };

  const revalidate = cachedHandler as CachedEventHandler<E>;
  revalidate.resolveKeys = async (event: E) => {
    const keys = await Promise.all(
      (await variantOptions(event)).map((options) => resolveCacheKeys({ options })),
    );
    return keys.flat();
  };
  revalidate.invalidate = async (event: E) => {
    await Promise.all((await variantOptions(event)).map((options) => invalidateCache({ options })));
  };
  revalidate.expire = async (event: E) => {
    await Promise.all((await variantOptions(event)).map((options) => expireCache({ options })));
  };

  return revalidate;
}
