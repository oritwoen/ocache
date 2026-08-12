// Normalizes the caller's options into the `HandlerConfig` every other module here reads:
// the cookie/query allowlists, the key header list, the `Vary` list and the status header.
// Computed once at definition time, so no module re-derives a list of its own.

import { definedOptions, resolveName } from "../cache.ts";

import type { HTTPEvent, EventHandler, CachedEventHandlerOptions } from "../types.ts";

// The handler defaults. Deliberately not `cache.ts`'s `defaultCacheOptions()` — only the HTTP
// layer has a `cacheStatusHeader` — and named apart so the two can't be imported for one
// another as they diverge.
export function defaultHandlerOptions() {
  return {
    name: "_",
    base: "/cache",
    swr: false,
    maxAge: 1,
    cacheStatusHeader: true,
  } as const;
}

// Stripped from the handler-visible request by default, like a non-allowlisted cookie:
// otherwise a token-authenticated route fails *open* — the first caller's private response is
// stored under the anonymous key and replayed to everyone. `allowAuthorization` folds both
// names into the header lists below, making them keyed, `Vary`-advertised and visible at once.
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

// Derives the per-handler configuration from the caller's options. `name` is resolved BEFORE
// the defaults merge (they set a truthy `name: "_"`, which made every handler key as `_` and
// collide across one shared storage) — via `cache.ts`'s `resolveName`, so the two paths can't
// drift, and with its caveat: same-source handlers share a name, so pass an explicit one.
export function resolveHandlerConfig<E extends HTTPEvent>(
  handler: EventHandler<E>,
  callerOpts: CachedEventHandlerOptions<E>,
): HandlerConfig<E> {
  const name = resolveName(callerOpts.name, handler);
  // `definedOptions` (from `cache.ts`, the same helper `defineCachedFunction` merges through):
  // an option explicitly set to `undefined` reads as unset, so `{ maxAge: routeConfig.maxAge }`
  // with an unset rule gets the `maxAge: 1` default rather than clobbering it with nothing.
  const opts: CachedEventHandlerOptions<E> = {
    ...defaultHandlerOptions(),
    ...definedOptions(callerOpts),
    name,
  };

  // Names are trimmed/deduped; an empty (or whitespace-only) list normalizes to the
  // "no cookies allowed" default.
  const _cookieNames = [
    ...new Set((opts.allowCookies ?? []).map((c) => c?.trim()).filter(Boolean)),
  ];
  const allowedCookieNames = _cookieNames.length > 0 ? _cookieNames : undefined;

  // The header names the caller declared, before the two consumers below take their
  // differing views of them.
  const _declaredHeaderNames = [
    ...new Set([
      ...(opts.varies || []).filter(Boolean).map((h) => h.toLowerCase()),
      // Deduped against `varies`: listing a credential header there is the same opt-in.
      ...(opts.allowAuthorization ? authHeaderNames : []),
    ]),
  ].sort();

  // Two lists, differing on exactly one name — `cookie` — because `allowCookies` changes
  // *how* cookies are keyed, not *whether* the response varies by them. Conflating them made
  // an `allowCookies` route advertise shared-cacheability with no `Vary` at all.
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
