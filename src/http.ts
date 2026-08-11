import { hash } from "ohash";
import { cachedFunction, expireCache, invalidateCache, resolveCacheKeys } from "./cache.ts";
import { _resolveStorage } from "./storage.ts";

import type {
  HTTPEvent,
  EventHandler,
  CachedEventHandler,
  CacheOptions,
  CachedEventHandlerOptions,
  CacheConditions,
  ResponseCacheEntry,
} from "./types.ts";

function defaultCacheOptions() {
  return {
    name: "_",
    base: "/cache",
    swr: false,
    maxAge: 1,
    cacheStatusHeader: true,
  } as const;
}

/**
 * Wraps an HTTP event handler with response caching.
 *
 * Automatically generates cache keys from the URL path, variable headers and the request
 * method (`GET` and `HEAD` are cached separately), sets `cache-control`, `etag`, and
 * `last-modified` headers, and handles `304 Not Modified` responses via conditional
 * request headers.
 *
 * @param handler - The event handler to cache.
 * @param opts - Cache and HTTP-specific configuration options.
 * @returns A new event handler that serves cached responses when available. The handler
 *   also exposes `.resolveKeys(event)`, `.invalidate(event)`, and `.expire(event)` for
 *   on-demand revalidation, keyed exactly as the handler caches (no key reconstruction);
 *   they cover every method variant of the event's resource.
 */
export function defineCachedHandler<E extends HTTPEvent = HTTPEvent>(
  handler: EventHandler<E>,
  opts: CachedEventHandlerOptions<E> = {},
): CachedEventHandler<E> {
  opts = { ...defaultCacheOptions(), ...opts };

  // Allowlist of cookie names that may participate in caching — the *request* side only.
  // `undefined` means "no cookies allowed": the Cookie request header is stripped before
  // the handler runs and cookies never vary the key. The response side is not negotiable:
  // no Set-Cookie ever survives a cacheable route, allowlisted or not (see `serialize`).
  // Names are trimmed/deduped; an empty (or whitespace-only) list normalizes to the
  // "no cookies allowed" default.
  const _cookieNames = [
    ...new Set((opts.allowCookies ?? []).map((c) => c?.trim()).filter(Boolean)),
  ];
  const allowedCookieNames = _cookieNames.length > 0 ? _cookieNames : undefined;

  // Credential headers are stripped from the handler-visible request by default, exactly
  // like a non-allowlisted cookie. Without this a token-authenticated route fails *open*:
  // the handler renders per-user content from a bearer token that is not part of the cache
  // key, so the first caller's response is stored under the anonymous key, replayed to
  // everyone, and (via the synthesized `public, s-maxage=N`) propagated by shared CDNs —
  // whereas the same route behind a cookie fails safe. `allowAuthorization` opts them back
  // in by folding both names into the header lists below, which is what makes them
  // key-varying, `Vary`-advertised and handler-visible all at once.
  const _authHeaderNames = ["authorization", "proxy-authorization"];

  // The request header names the caller declared, before the two consumers below take
  // their differing views of them.
  const _declaredHeaderNames = [
    ...new Set([
      ...(opts.varies || []).filter(Boolean).map((h) => h.toLowerCase()),
      // Deduped against `varies`: a caller who already listed a credential header has
      // opted into keying on it, so `allowAuthorization` must not add it twice.
      ...(opts.allowAuthorization ? _authHeaderNames : []),
    ]),
  ].sort();

  // Two consumers, two lists, differing on exactly one name — `cookie` — because
  // `allowCookies` changes *how* cookies are keyed without changing *whether* the response
  // varies by them. Conflating the two is what made an `allowCookies` route advertise
  // shared-cacheability it hadn't earned.
  //
  // 1. Key composition (`_resolveKey`), plus handler visibility for the credential headers.
  //    `allowCookies` supersedes `varies: ["cookie"]` here: the key already carries a
  //    `cookie.<hash>` component over the *allowlisted subset*, so hashing the coarse raw
  //    header on top of it would re-admit exactly the unlisted cookies (analytics, A/B, a
  //    session id) the allowlist exists to keep out of the key.
  const keyHeaderNames = allowedCookieNames
    ? _declaredHeaderNames.filter((h) => h !== "cookie")
    : _declaredHeaderNames;

  // 2. The response `Vary` advertisement, which is about the *request header* a downstream
  //    cache must key on, not about our internal key shape. With an allowlist the response
  //    does vary by `Cookie` (two `theme` values produce two entries), so a shared cache
  //    that isn't told stores one visitor's variant and serves it to everyone under the
  //    `s-maxage`/`max-age` we synthesize. `cookie` is deduped against a `varies` entry the
  //    caller already wrote. Note the honest cost: `Vary: Cookie` collapses downstream hit
  //    rates, since any unrelated cookie makes a request its own variant — a route that
  //    needs CDN caching should not key by cookie at all.
  const varyHeaderNames = allowedCookieNames
    ? [...new Set([..._declaredHeaderNames, "cookie"])].sort()
    : _declaredHeaderNames;

  const allowedQueryNames = opts.allowQuery
    ? [...new Set(opts.allowQuery.filter(Boolean))]
    : undefined;

  // Requests outside `_cacheableMethods` skip the cache entirely. Derived from that one
  // list rather than repeating the method check, so the bypass decision and the per-method
  // key variants can never disagree — making a further method cacheable is a one-line
  // change there. Shared between the `shouldBypassCache` option and the resolver so the
  // request-narrowing step below can't disagree with the bypass decision either. This is
  // the built-in method check only — a caller's `opts.shouldBypassCache` is composed on
  // top of it in `_opts` below, never in place of it.
  const _shouldBypassCache = (event: HTTPEvent) => !_cacheableMethods.includes(event.req.method);

  // Memoize the filtered query per request so getKey and the handler-facing URL
  // rewrite don't recompute it. Scoped to this handler instance so a shared
  // event can't pick up another handler's allowlist.
  const _searchCache = new WeakMap<HTTPEvent, string>();
  const _filteredSearch = (event: HTTPEvent, url: URL): string => {
    let search = _searchCache.get(event);
    if (search === undefined) {
      search = _filterSearch(url, allowedQueryNames!);
      _searchCache.set(event, search);
    }
    return search;
  };

  // Resource identity: everything about the request that selects a representation except
  // the method. Split out of `getKey` so the method component below can wrap *both* key
  // branches (auto and custom) and so the revalidation helpers can enumerate every method
  // variant of one resource from a single event, without cloning or mutating it.
  const _resolveKey = async (event: HTTPEvent): Promise<string> => {
    // Custom user-defined key
    const customKey = await opts.getKey?.(event as E);
    if (customKey) {
      const _key = escapeKey(customKey);
      // If escaping was a no-op the key is already storage-safe and can't collide,
      // so keep it as-is. Otherwise escaping is lossy (distinct keys can collapse to
      // the same segment), so append a hash of the raw key to keep them distinct.
      // The `.` separator only appears in the hashed form, so an escaped-clean key
      // (pure `\w`, never contains `.`) and a hashed key can never overlap.
      return _key === customKey ? _key : `${_key.slice(0, 64)}.${hash(customKey)}`;
    }
    // Auto-generated key
    const _url = event.url ?? new URL(event.req.url);
    const _search = allowedQueryNames ? _filteredSearch(event, _url) : _url.search;
    const _path = _url.pathname + _search;
    let _pathname: string;
    try {
      _pathname =
        escapeKey(decodeURI(new URL(_path, "http://localhost").pathname)).slice(0, 16) || "index";
    } catch {
      _pathname = "-";
    }
    const _hashedPath = `${_pathname}.${hash(_path)}`;
    const _headers = keyHeaderNames
      .map((header) => [header, event.req.headers.get(header)])
      .map(([name, value]) => `${escapeKey(name as string)}.${hash(value)}`);
    // Vary the key by the allowlisted cookie subset only (sorted, order-independent),
    // never the full raw Cookie header. Omitted entirely when no cookies are allowed.
    const _cookies = allowedCookieNames
      ? [`cookie.${hash(_filterCookie(event.req.headers.get("cookie"), allowedCookieNames))}`]
      : [];
    return [_hashedPath, ..._headers, ..._cookies].join(":");
  };

  const _toResponse =
    opts.toResponse ||
    ((rawValue: unknown) =>
      rawValue instanceof Response ? rawValue : new Response(String(rawValue)));

  const _createResponse =
    opts.createResponse ||
    ((body: string | Uint8Array | null, init: ResponseInit) =>
      new Response(body as BodyInit | null, init));

  const _handleCacheHeaders = opts.handleCacheHeaders || _defaultHandleCacheHeaders;

  // CDN-style cache-status header (X-Cache: HIT | MISS | STALE)
  const _statusHeader =
    opts.cacheStatusHeader === true
      ? "x-cache"
      : typeof opts.cacheStatusHeader === "string" && opts.cacheStatusHeader
        ? opts.cacheStatusHeader.toLowerCase()
        : undefined;

  // The cached function resolves to a live `Response`; `serialize` turns it into the
  // stored `ResponseCacheEntry`, and `transform` reads that entry back on serve. So `T`
  // is the resolver's `Response`, while `entry.value` holds the serialized entry once
  // stored — the same documented looseness `transform` already relies on.
  const _opts: CacheOptions<Response> = {
    ...opts,
    // Inject the cache-status header into a cloned entry value (never mutating the
    // stored entry) so it flows through to the final Response headers.
    transform: _statusHeader
      ? (entry) => {
          const value = entry.value as unknown as ResponseCacheEntry | undefined;
          if (!value) {
            return;
          }
          return {
            ...value,
            headers: {
              ...value.headers,
              [_statusHeader]: String(entry.status).toUpperCase(),
            },
          };
        }
      : undefined,
    // Write-side seam: consume the resolved `Response` body, synthesize the cache
    // headers, and build the storable `ResponseCacheEntry`. Runs exactly once per
    // resolution (shared across deduplicated callers), so `res.arrayBuffer()`'s one-shot
    // consumption is safe. Kept out of the resolver so bypassed requests — which never
    // reach `serialize` — get their live `Response` back untouched.
    serialize: async (entry) => {
      const res = entry.value as unknown as Response;

      // Read the body once as raw bytes. A valid-UTF-8 body is stored verbatim as a
      // string (unchanged behavior, so text etags stay stable); anything else (images,
      // protobuf/MVT tiles, other binary Buffers) is base64-encoded and flagged, so the
      // lossy `res.text()` UTF-8 decode can't mangle it and it survives JSON-serializing
      // storage backends. Valid UTF-8 roundtrips losslessly through the string form, so
      // the discriminator is byte validity, not the (spoofable/absent) content-type.
      const bytes = new Uint8Array(await res.arrayBuffer());
      const text = _decodeUtf8(bytes);
      const base64 = text === undefined;
      const body = base64 ? _bytesToBase64(bytes) : text;

      if (!res.headers.has("etag")) {
        res.headers.set("etag", `W/"${hash(body)}"`);
      }

      if (!res.headers.has("last-modified")) {
        res.headers.set("last-modified", new Date().toUTCString());
      }

      // Only synthesize a cache-control header when the handler did not set one
      // explicitly — never clobber an explicit cache-control with our SWR/s-maxage
      // directives (mirrors the etag / last-modified "preserve if present" behavior above).
      // `sendCacheControl: false` opts out of synthesis entirely (server-only caching):
      // the entry is still stored/served with SWR/etag/last-modified, but no
      // cache-control is advertised to clients/CDNs — without the `no-store`/`private`
      // tricks that would also disqualify the entry from storage (issue #49, nitro#3997).
      if (opts.sendCacheControl !== false && !res.headers.has("cache-control")) {
        const cacheControl = [];
        if (opts.swr) {
          if (opts.maxAge != null) {
            cacheControl.push(`s-maxage=${opts.maxAge}`);
          }
          if (opts.staleMaxAge != null) {
            cacheControl.push(`stale-while-revalidate=${opts.staleMaxAge}`);
          } else {
            cacheControl.push("stale-while-revalidate");
          }
        } else if (opts.maxAge) {
          // For non-SWR, set max-age directly
          cacheControl.push(`max-age=${opts.maxAge}`);
        }
        if (cacheControl.length > 0) {
          res.headers.set("cache-control", cacheControl.join(", "));
        }
      }

      // Advertise the request headers this response varies on so downstream
      // caches/CDNs/browsers store a separate variant per value — merging with any
      // `Vary` the handler already set rather than clobbering it (mirrors the
      // "preserve if present" behavior of the etag / last-modified / cache-control
      // synthesis above). This is `varyHeaderNames`, not the key list: `allowCookies`
      // keys on a hashed subset of `Cookie` but the response still varies by the header
      // itself, and a downstream cache can only be told at header granularity.
      if (varyHeaderNames.length > 0) {
        _appendVary(res.headers, varyHeaderNames);
      }

      // Strip EVERY Set-Cookie — allowlisted or not — BEFORE the headers are serialized.
      // A cacheable response is a shared object: it is replayed to every later hit on the
      // same key and to every concurrent peer coalesced onto this one resolution, so a
      // cookie minted here reaches callers it was never minted for (issue #61: the
      // leader's session id handed to every deduplicated peer). `allowCookies` used to
      // except its own names from this strip, which reintroduced that exact leak one
      // opt-in later — a handler minting `sid` on first visit stores the response under
      // the *no-sid* key with `Set-Cookie: sid=s1` attached, so every subsequent
      // first-time visitor keys the same and is served `sid=s1`: session fixation, and a
      // broad rule set like `"/**": { swr: 60 }` puts every cookie-setting route in that
      // position (h3#1524 audit, finding #15c). The more permissive alternative — refuse
      // to *store* a response that mints a cookie, rather than stripping it — cannot close
      // the concurrent-peer case at all, since coalesced callers share one resolution and
      // are indistinguishable from each other. So the rule is uniform and statable in one
      // sentence: no Set-Cookie survives a cacheable route, in either the served or the
      // stored response. `allowCookies` governs the request side only. The rest of the
      // response is still cached (mirroring how CDNs / Varnish drop Set-Cookie on
      // cacheable responses); a handler that must mint a cookie serves it from a
      // non-GET/HEAD route, which bypasses the cache and passes through untouched.
      // A bare `delete` drops every value on every runtime, so the `getSetCookie()`
      // capability dance the old per-cookie filter needed is gone with the filter.
      res.headers.delete("set-cookie");

      // Strip transport headers before storing. The body has already been fully read and
      // decoded into `bytes`, so a stored `content-encoding` (e.g. `gzip`) would describe
      // an encoding the cached body no longer has, and a `content-length`/`transfer-encoding`
      // would describe the original wire framing, not the re-buffered body — replaying any
      // of them on a cache hit desyncs the headers from the body and yields malformed
      // responses (nitro#2109). The runtime recomputes `content-length` from the served
      // body on read.
      for (const header of _transportHeaders) {
        res.headers.delete(header);
      }

      const cacheEntry: ResponseCacheEntry = {
        status: res.status,
        statusText: res.statusText,
        headers: Object.fromEntries(res.headers.entries()),
        body,
        // Only set for binary bodies — text entries stay flag-free (and byte-identical to
        // pre-binary-support entries), so `transform`'s `{ ...value }` spread carries it through.
        ...(base64 && { base64: true }),
      };

      return cacheEntry;
    },
    // Compose the built-in non-GET/HEAD bypass with the caller's opt-in check
    // instead of clobbering it: bypass when either says so. A bare `...opts`
    // spread already carried `opts.shouldBypassCache`, but assigning the
    // built-in here used to silently discard it (issue #50).
    shouldBypassCache: async (event: HTTPEvent) => {
      if (_shouldBypassCache(event)) {
        return true;
      }
      return (await opts.shouldBypassCache?.(event as E)) === true;
    },
    // Key = resource identity + method component. GET is the implicit default and stays
    // unprefixed (so its keys are byte-identical to pre-fix ones — existing entries stay
    // warm); every other cacheable method contributes its own component, which today means
    // exactly `head:`. Without it a GET and a HEAD for the same URL share one entry, and a
    // spec-compliant host framework (h3's `toResponse`, and every other one) nulls the body
    // of a HEAD response — precisely the `Response` that `serialize` then stores. So a
    // single anonymous `HEAD /page` seeds the shared entry with a zero-byte body plus a
    // synthesized `public, max-age=N` and a weak etag computed over that empty body, and
    // every GET for the rest of the TTL is served a blank 200 that downstream CDNs and
    // browsers then cache and successfully revalidate (h3#1524 audit, finding #3). Applied
    // around *both* key branches: a custom `getKey` expresses content identity, so
    // preventing the method collision stays ocache's job there too. The cost is one origin
    // dispatch per method per resource per TTL — the accepted trade.
    getKey: async (event: HTTPEvent) => _methodKey(await _resolveKey(event), event.req.method),
    validate: async (entry) => {
      // `validate` always inspects the serialized shape: on write it runs right after
      // `serialize` (entry.value is the freshly built `ResponseCacheEntry`), on read it
      // sees the entry as persisted.
      const value = entry.value as unknown as ResponseCacheEntry | undefined;
      if (!value) {
        return false;
      }
      // Honor an explicit `Cache-Control: no-store` / `private` on the response — never cache it.
      if (_forbidsSharedCaching(value.headers?.["cache-control"])) {
        return false;
      }
      // Defense-in-depth for entries this version didn't write: cached before the
      // Set-Cookie stripping in `serialize` existed, by an older ocache that still kept
      // allowlisted cookies on the response (h3#1524 audit, finding #15c), or by another
      // writer sharing the storage. Reject *any* stored Set-Cookie rather than replay it
      // to strangers until expiry — the allowlist has no say here, matching the
      // unconditional strip in `serialize`, so entries written by this version can never
      // trip it. Serialized headers collapse multiple Set-Cookie values to the last, so
      // this sees only one of them; presence alone is enough to reject, and the lossless
      // guard is the strip.
      if (value.headers?.["set-cookie"]) {
        return false;
      }
      if (value.status >= 400) {
        return false;
      }
      // Only a *missing* body (`serialize` never ran / a malformed foreign entry) is
      // rejected — an empty string is a legitimate entry and stays cacheable. A zero-byte
      // 200 is a valid GET response, so rejecting `""` would only cost hit rate. The one
      // dangerous empty body — a body-less HEAD response replayed to GET clients — is
      // handled where it belongs, in `getKey`'s method component: an empty entry is now
      // only ever readable by requests of the method that produced it (h3#1524 audit,
      // finding #3). Rejecting `""` here would neither have closed that hole (the poisoned
      // entry would just be re-poisoned on the next HEAD) nor be the right layer for it.
      if (value.body === undefined) {
        return false;
      }
      if (value.headers.etag === "undefined" || value.headers["last-modified"] === "undefined") {
        return false;
      }
      // Additive user hook: ANDed with the built-in checks above so callers can
      // reject responses (e.g. redirects) without reimplementing load-bearing
      // safety checks. Cannot be used to force-cache a response the built-ins reject.
      // A throwing hook fails closed (treat as not cacheable) rather than breaking
      // the request — the response is still served, just not stored/served-from-cache.
      if (opts.shouldCache) {
        try {
          if ((await opts.shouldCache(value)) === false) {
            return false;
          }
        } catch (error) {
          if (opts.onError) {
            opts.onError(error);
          } else {
            console.error("[cache] shouldCache hook error.", error);
          }
          return false;
        }
      }
      return true;
    },
    group: opts.group || "handlers",
    integrity: opts.integrity || hash([handler, _integrityOpts(opts)]),
  };

  // Resolver: narrow the request (cacheable calls only), run the handler, and return
  // the *live* `Response`. Serialization into a `ResponseCacheEntry` happens in the
  // `serialize` hook above, so a bypassed request — which `cachedFunction` returns raw,
  // skipping `serialize`/`transform` — flows back out as an untouched `Response`.
  const _cachedHandler = cachedFunction<Response>(async (event: HTTPEvent) => {
    // Narrow the request for cache-key consistency — cacheable calls only. Bypassed
    // methods (POST etc.) are never stored or key-derived, so their request must reach
    // the handler untouched (cookies, varied headers, full query, body — the rewritten
    // Request below carries no body).
    if (!_shouldBypassCache(event)) {
      // Strip the credential headers the handler didn't opt into, and narrow the Cookie
      // header to the allowlist, so the handler can't depend on credentials outside the
      // cache key (mirrors allowQuery). Everything else — including the `varies` headers —
      // is forwarded as-is: those values *are* in the cache key, so letting the handler
      // read them is both safe and the whole point of declaring them (previously they were
      // filtered out, so e.g. `varies: ["accept-language"]` keyed per language but every
      // entry held the default rendering).
      const filteredHeaders = [...event.req.headers.entries()].flatMap(([key, value]) => {
        const name = key.toLowerCase();
        // Not in `keyHeaderNames` (neither `allowAuthorization` nor `varies`) means the
        // credential can't vary the key, so the handler must not see it either. The *key*
        // list is the right one here — visibility must follow what is actually keyed on,
        // never the `Vary` advertisement.
        if (_authHeaderNames.includes(name) && !keyHeaderNames.includes(name)) {
          return [];
        }
        if (name !== "cookie") {
          return [[key, value] as [string, string]];
        }
        const cookie = allowedCookieNames ? _filterCookie(value, allowedCookieNames) : "";
        return cookie ? [["cookie", cookie] as [string, string]] : [];
      });

      // Narrow the query the handler sees to the allowlist, so it can't depend on
      // params outside the cache key (mirrors the header filtering above).
      let _reqUrl = event.req.url;
      if (allowedQueryNames) {
        const _url = event.url ?? new URL(event.req.url);
        const _filteredUrl = new URL(_url);
        _filteredUrl.search = _filteredSearch(event, _url);
        _reqUrl = _filteredUrl.href;
      }

      try {
        const originalReq = event.req;
        (event as any).req = new Request(_reqUrl, {
          method: event.req.method,
          headers: filteredHeaders,
        });
        // Inherit runtime context
        if ((originalReq as any).runtime) {
          (event.req as any).runtime = (originalReq as any).runtime;
        }
        if (allowedQueryNames && event.url) {
          (event as any).url = new URL(_reqUrl);
        }
      } catch (error) {
        console.error("[cache] Failed to filter request:", error);
      }
    }

    // Call handler
    const rawValue = await handler(event as E);
    return _toResponse(rawValue, event as E);
  }, _opts);

  const cachedHandler: EventHandler<E> = async (event) => {
    // Headers-only mode
    if (opts.headersOnly) {
      if (_handleCacheHeaders(event, { maxAge: opts.maxAge })) {
        return _createResponse(null, { status: 304 });
      }
      return handler(event);
    }

    // Call with cache
    const cached = (await _cachedHandler(event))! as Response | ResponseCacheEntry;

    // Bypassed requests (non-GET/HEAD, or a caller `shouldBypassCache`) resolve to the
    // handler's live `Response`: `cachedFunction` returns the resolver output raw on the
    // bypass path (no `serialize`/`transform`). Pass it straight through — no body
    // buffering (streaming and binary bodies survive), no synthesized cache headers, and
    // no bogus 304 for a method that was never cacheable.
    if (cached instanceof Response) {
      return cached;
    }
    const response = cached;

    // Check for cache headers
    if (
      _handleCacheHeaders(event, {
        modifiedTime: new Date(response.headers["last-modified"] as string),
        etag: response.headers.etag as string,
        maxAge: opts.maxAge,
      })
    ) {
      // A 304 must echo the `Vary` (and cache-status) that would have accompanied
      // the full response, so a shared cache doesn't lose the variant dimension
      // (RFC 7232 §4.1).
      const notModifiedHeaders: Record<string, string> = {};
      const statusValue = _statusHeader
        ? (response.headers[_statusHeader] as string | undefined)
        : undefined;
      if (statusValue !== undefined) {
        notModifiedHeaders[_statusHeader!] = statusValue;
      }
      const varyValue = response.headers.vary as string | undefined;
      if (varyValue !== undefined) {
        notModifiedHeaders.vary = varyValue;
      }
      return _createResponse(null, {
        status: 304,
        headers: Object.keys(notModifiedHeaders).length > 0 ? notModifiedHeaders : undefined,
      });
    }

    // Send Response. Binary bodies were stored base64-encoded; decode them back to raw
    // bytes so the Response carries the original payload untouched (no UTF-8 mangling).
    const body =
      response.base64 && typeof response.body === "string"
        ? _base64ToBytes(response.body)
        : (response.body ?? null);
    return _createResponse(body, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  };

  // On-demand revalidation without reconstructing the auto-generated key (which internal
  // escaping makes error-prone — issue #71): these accept the request event directly and
  // derive the exact keys the handler stores under.
  //
  // They target the *resource*, not one method variant of it: `getKey` splits GET and HEAD
  // into separate entries (see above), but that is an internal key-shape decision the
  // caller never asked for — "this URL's cached representation is dead" must not leave a
  // sibling HEAD entry advertising the old etag/last-modified for downstream caches to
  // revalidate against. So every cacheable method's variant of the event's resource key is
  // covered, whichever method the passed event carries (`_resolveKey` is method-free, so
  // this needs no cloned or mutated event — never mutate a caller's event). `resolveKeys`
  // enumerates the same set, the event's own variant first, so `keys[0]` is still exactly
  // the key this event reads and writes.
  //
  // The keys are handed to the standalone `cache.ts` helpers as a fixed `getKey`; going
  // through `_cachedHandler.*` would re-derive only the event's own variant.
  const _variantOptions = async (event: E) => {
    // `_opts` is the object `cachedFunction` memoizes this handler's resolved storage into,
    // but each variant below spreads it into a *fresh* object. Resolve first so every
    // variant carries the concrete backend: without it, a purge issued before the first
    // request would leave an unresolved `storage` (or none at all) on each copy, each copy
    // would build its own default memory storage, and the purge would silently no-op.
    _resolveStorage(_opts);
    const key = await _resolveKey(event);
    const methods = _cacheableMethods.includes(event.req.method)
      ? [event.req.method, ..._cacheableMethods.filter((m) => m !== event.req.method)]
      : // A non-cacheable event (e.g. a POST webhook used as the invalidation trigger)
        // has no variant of its own — purge the cacheable ones in their canonical order.
        _cacheableMethods;
    return methods.map((method) => {
      const _key = _methodKey(key, method);
      return { ..._opts, getKey: () => _key };
    });
  };

  const _revalidate = cachedHandler as CachedEventHandler<E>;
  _revalidate.resolveKeys = async (event: E) => {
    const keys = await Promise.all(
      (await _variantOptions(event)).map((options) => resolveCacheKeys({ options })),
    );
    return keys.flat();
  };
  _revalidate.invalidate = async (event: E) => {
    await Promise.all(
      (await _variantOptions(event)).map((options) => invalidateCache({ options })),
    );
  };
  _revalidate.expire = async (event: E) => {
    await Promise.all((await _variantOptions(event)).map((options) => expireCache({ options })));
  };

  return _revalidate;
}

// --- Internal helpers ---

// Transport/framing headers stripped from a cached entry: the body is stored fully
// decoded and re-buffered, so these no longer describe it (see `serialize`).
const _transportHeaders = ["content-encoding", "content-length", "transfer-encoding"];

// The methods whose responses reach the cache. Single source of truth: `_shouldBypassCache`
// is derived from it, and it enumerates every method variant one resource can be stored
// under (see the revalidation helpers). Making a further method cacheable is a one-line
// addition here; the key scheme below already accommodates it.
const _cacheableMethods = ["GET", "HEAD"];

/**
 * Prefixes a resource key with its method component. GET is the implicit default and
 * carries none, so its keys are unchanged; every other cacheable method gets a
 * `<METHOD>:` component of its own. Methods are used verbatim, not case-folded: unlike
 * header names and `cache-control` directives (case-insensitive, so normalized elsewhere
 * in this file), HTTP methods are case-sensitive and canonically uppercase, and `Request`
 * already normalizes the cacheable ones — so the key matches `_cacheableMethods` with no
 * transformation in between. Method components are alphabetic and a resource key's first
 * `:`-segment never is (an auto key's leading segment always contains a `.`; an escaped
 * custom key never contains a `:` at all), so the per-method key spaces cannot overlap.
 * See `getKey` for why the split exists.
 */
function _methodKey(key: string, method: string): string {
  return method === "GET" ? key : `${method}:${key}`;
}

// Fatal decoder so invalid UTF-8 throws (→ binary) instead of substituting replacement
// characters. `ignoreBOM` keeps a leading BOM in the string so it re-encodes byte-for-byte,
// preserving the lossless roundtrip that lets valid UTF-8 be stored as a plain string.
const _utf8Decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

/** Decodes bytes as UTF-8, returning `undefined` when they aren't valid UTF-8 (i.e. binary). */
function _decodeUtf8(bytes: Uint8Array): string | undefined {
  try {
    return _utf8Decoder.decode(bytes);
  } catch {
    return undefined;
  }
}

/** Encodes raw bytes to a base64 string (chunked to stay within `String.fromCharCode` arg limits). */
function _bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const CHUNK = 0x80_00;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

/** Decodes a base64 string produced by {@link _bytesToBase64} back to raw bytes. */
function _base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

function escapeKey(key: string | string[]) {
  return String(key).replace(/\W/g, "");
}

/** Rebuilds the query string from only the allowlisted param names, order-independent. */
function _filterSearch(url: URL, names: string[]): string {
  const filtered = new URLSearchParams();
  for (const name of names) {
    for (const value of url.searchParams.getAll(name).sort()) {
      filtered.append(name, value);
    }
  }
  const query = filtered.toString();
  return query ? `?${query}` : "";
}

/** Rebuilds the `Cookie` header from only the allowlisted cookie names, sorted (order-independent). */
function _filterCookie(header: string | null | undefined, names: string[]): string {
  if (!header) {
    return "";
  }
  const kept: Array<[string, string]> = [];
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    const name = (eq < 0 ? part : part.slice(0, eq)).trim();
    if (name && names.includes(name)) {
      kept.push([name, eq < 0 ? "" : part.slice(eq + 1).trim()]);
    }
  }
  kept.sort((a, b) =>
    a[0] === b[0] ? (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0) : a[0] < b[0] ? -1 : 1,
  );
  return kept.map(([n, v]) => `${n}=${v}`).join("; ");
}

/**
 * Merges `names` into the response's `Vary` header, preserving any header names the
 * handler already declared and deduplicating case-insensitively. A wildcard
 * (`Vary: *`) is left untouched since it already varies on everything.
 */
function _appendVary(headers: Headers, names: string[]): void {
  const existing = headers.get("vary");
  // A `*` token means the response varies on everything — nothing to add.
  if (existing && existing.split(",").some((part) => part.trim() === "*")) {
    return;
  }
  const seen = new Set<string>();
  const merged: string[] = [];
  const add = (raw: string) => {
    const name = raw.trim();
    const key = name.toLowerCase();
    if (!name || seen.has(key)) {
      return;
    }
    seen.add(key);
    merged.push(name);
  };
  if (existing) {
    for (const part of existing.split(",")) {
      add(part);
    }
  }
  for (const name of names) {
    add(name);
  }
  headers.set("vary", merged.join(", "));
}

/**
 * Whether a `Cache-Control` header value explicitly forbids storing the response in a
 * shared cache — `no-store` (never store anywhere) or `private` (not in a shared cache).
 */
function _forbidsSharedCaching(cacheControl: unknown): boolean {
  if (typeof cacheControl !== "string" || !cacheControl) {
    return false;
  }
  return cacheControl.split(",").some((directive) => {
    const name = directive.trim().split("=")[0]!.toLowerCase();
    return name === "no-store" || name === "private";
  });
}

/**
 * Strips storage-location fields from opts so integrity only reflects the cached
 * computation (`storage` included — see the same helper in `cache.ts`).
 */
function _integrityOpts<E extends HTTPEvent>(
  opts: CachedEventHandlerOptions<E>,
): Omit<CachedEventHandlerOptions<E>, "base" | "group" | "name" | "storage"> {
  const { base: _, group: _g, name: _n, storage: _s, ...rest } = opts;
  return rest;
}

function _defaultHandleCacheHeaders(event: HTTPEvent, conditions: CacheConditions): boolean {
  // Check if-none-match
  const ifNoneMatch = event.req.headers.get("if-none-match");
  if (ifNoneMatch && conditions.etag && ifNoneMatch === conditions.etag) {
    return true;
  }

  // Check if-modified-since
  const ifModifiedSince = event.req.headers.get("if-modified-since");
  if (ifModifiedSince && conditions.modifiedTime) {
    if (new Date(ifModifiedSince) >= conditions.modifiedTime) {
      return true;
    }
  }

  return false;
}
