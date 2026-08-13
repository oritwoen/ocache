// Normalizes the caller's options into the `HandlerConfig` every other module here reads:
// the cookie/query allowlists, the key header list, the `Vary` list and the status header.
// Computed once at definition time, so no module re-derives a list of its own.

import { definedOptions, resolveName } from "../cache.ts";

import type { HTTPEvent, EventHandler, CachedEventHandlerOptions } from "../types.ts";

// Handler defaults, not `cache.ts`'s `defaultCacheOptions()` (HTTP-only `cacheStatusHeader`) —
// named apart so neither is importable for the other.
export function defaultHandlerOptions() {
  return {
    name: "_",
    base: "/cache",
    swr: false,
    maxAge: 1,
    cacheStatusHeader: true,
  } as const;
}

// Stripped by default (like a non-allowlisted cookie): else a token-authenticated route fails
// *open* — first caller's private response cached under the anonymous key, replayed to everyone.
export const authHeaderNames = ["authorization", "proxy-authorization"];

/** Per-handler configuration derived once from the caller's options. */
export interface HandlerConfig<E extends HTTPEvent> {
  /** The caller's options merged over {@link defaultHandlerOptions}, with `name` resolved. */
  opts: CachedEventHandlerOptions<E>;

  /**
   * Cookie names that may participate in caching — the *request* side only; `undefined`
   * strips the Cookie header entirely. The response side is not negotiable: no Set-Cookie
   * survives a cacheable route (see `entry.ts`).
   */
  allowedCookieNames: string[] | undefined;

  /** Allowlist of query param names that compose the key and reach the handler. */
  allowedQueryNames: string[] | undefined;

  /**
   * Key composition (`resolveKey`), plus handler visibility for the credential and cookie
   * headers — one rule: a handler may read exactly what the key covers. `allowCookies`
   * supersedes `varies: ["cookie"]` (the key carries the finer allowlisted subset instead);
   * without it, `cookie` here is the coarse opt-in — raw header, keyed and forwarded.
   */
  keyHeaderNames: string[];

  /**
   * The response `Vary` advertisement: the *request header* a downstream cache must key on,
   * not our key shape — so `allowCookies` still emits `Vary: Cookie` (deduped against
   * `varies`). Costly downstream: any unrelated cookie makes a request its own variant.
   */
  varyHeaderNames: string[];

  /** CDN-style cache-status header name (`X-Cache: HIT | MISS | STALE`), or `undefined`. */
  statusHeader: string | undefined;

  /**
   * Memoizes the filtered query per request for the key derivation and the URL rewrite.
   * Scoped to this handler instance, so a shared event can't pick up another's allowlist.
   */
  searchCache: WeakMap<HTTPEvent, string>;

  /**
   * The *composed* bypass verdict (built-in ∨ the caller's `shouldBypassCache`) for the
   * call in flight: written by `resolveBypass`, read by `narrowRequest`. Two consumers,
   * one evaluation — `cache.ts` short-circuits to the raw resolver on `true`, and the
   * resolver must gate narrowing on the very same answer, while the caller's hook may be
   * async, expensive or side-effecting and must not be asked twice.
   *
   * Keyed by the event and scoped to this handler instance (the {@link searchCache}
   * pattern), which is what makes it per-call state: a module-level slot would leak one
   * request's verdict into the next.
   */
  bypassed: WeakMap<HTTPEvent, boolean>;
}

// `name` resolved BEFORE defaults merge, via `cache.ts`'s `resolveName` (paths can't drift) —
// else every handler collapsed to key `_` (shared-storage collision). Caveat: same-source names collide.
export function resolveHandlerConfig<E extends HTTPEvent>(
  handler: EventHandler<E>,
  callerOpts: CachedEventHandlerOptions<E>,
): HandlerConfig<E> {
  const name = resolveName(callerOpts.name, handler);
  // `definedOptions` (cache.ts, shared with `defineCachedFunction`): explicit `undefined`
  // reads as unset — `{ maxAge: routeConfig.maxAge }` falls back to the default, not clobbered.
  const opts: CachedEventHandlerOptions<E> = {
    ...defaultHandlerOptions(),
    ...definedOptions(callerOpts),
    name,
  };

  // Names trimmed/deduped; an empty (or whitespace-only) list normalizes to "no cookies allowed".
  const _cookieNames = [
    ...new Set((opts.allowCookies ?? []).map((c) => c?.trim()).filter(Boolean)),
  ];
  const allowedCookieNames = _cookieNames.length > 0 ? _cookieNames : undefined;

  // Declared header names, before the two consumers below take differing views of them.
  const _declaredHeaderNames = [
    ...new Set([
      ...(opts.varies || []).filter(Boolean).map((h) => h.toLowerCase()),
      // Deduped against `varies`: listing a credential header there is the same opt-in.
      ...(opts.allowAuthorization ? authHeaderNames : []),
    ]),
  ].sort();

  // Two lists differ on one name, `cookie` — `allowCookies` changes *how* it's keyed, not
  // *whether* it varies. Conflated before: routes advertised cacheability with no `Vary`.
  const keyHeaderNames = allowedCookieNames
    ? _declaredHeaderNames.filter((h) => h !== "cookie")
    : _declaredHeaderNames;

  const varyHeaderNames = allowedCookieNames
    ? [...new Set([..._declaredHeaderNames, "cookie"])].sort()
    : _declaredHeaderNames;

  const allowedQueryNames = opts.allowQuery
    ? [...new Set(opts.allowQuery.filter(Boolean))]
    : undefined;

  const statusHeader =
    opts.cacheStatusHeader === true
      ? "x-cache"
      : typeof opts.cacheStatusHeader === "string" && opts.cacheStatusHeader
        ? opts.cacheStatusHeader.toLowerCase()
        : undefined;

  return {
    opts,
    allowedCookieNames,
    allowedQueryNames,
    keyHeaderNames,
    varyHeaderNames,
    statusHeader,
    searchCache: new WeakMap<HTTPEvent, string>(),
    bypassed: new WeakMap<HTTPEvent, boolean>(),
  };
}

/**
 * Strips storage-location fields from opts so integrity only reflects the cached
 * computation (`storage` included — see the same helper in `cache.ts`).
 */
export function integrityOpts<E extends HTTPEvent>(
  opts: CachedEventHandlerOptions<E>,
): Omit<CachedEventHandlerOptions<E>, "base" | "group" | "name" | "storage"> {
  const { base: _, group: _g, name: _n, storage: _s, ...rest } = opts;
  return rest;
}
