# `http/key.ts` — cache key + revalidation helpers

**Key = resource identity + method component.** `resolveKey` derives the method-free resource
part (auto: URL origin + path + `varies` header values + allowlisted cookies; or the caller's
`getKey`), `methodKey` prefixes the method.

## Handler `name`

`resolveName(opts.name, handler)` **before** the `defaultHandlerOptions()` merge — same rule and
same shared internal as `defineCachedFunction` (`.agents/cache.md`). `config.ts` keeps its own
defaults, deliberately not `cache.ts`'s (only the HTTP layer has `cacheStatusHeader`), named
apart so neither is importable for the other.

Merging first left `opts.name` permanently `"_"`, so **every** handler keyed identically. Two
handlers sharing one `storage` (the configuration `types.ts` recommends) that can see the same
path then collided: identical source ⇒ identical integrity ⇒ one served the other's cached
response (cross-handler leak); differing source ⇒ every read failed the other's integrity check
⇒ permanent thrash at 0% hit rate. Breaking key change; every handler entry went cold once.
`hash(handler)` sees only source, so handlers from one factory share a name _and_ an integrity —
pass an explicit `name` per instance.

## Method component

GET is the implicit default and carries no component; every other cacheable method contributes
`<METHOD>:` — today exactly `HEAD:` (`cacheableMethods`, the enumerable counterpart of
`shouldBypassCache`'s method half; another cacheable method is a one-line addition, not a key
redesign).

Closes h3#1524 audit finding #3: GET and HEAD shared one entry, and a spec-compliant host
`toResponse` nulls the body of a HEAD response — exactly the `Response` `serialize` stores — so
one anonymous `HEAD /page` seeded the shared entry with a zero-byte body, a synthesized
`max-age=N` and a weak etag over that empty body, and every GET for the rest of the TTL got a
blank 200 that CDNs/browsers cached and successfully revalidated.

Applied around **both** key branches (a custom `getKey` expresses content identity; preventing
the method collision is ocache's job either way), and both are escaped, as is the `name` before
them — no segment can forge a `<METHOD>:` component. GET keys are byte-identical to pre-fix ones
so existing entries stay warm; the cost is one origin dispatch per method per resource per TTL.
Non-cacheable methods never reach `getKey`.

## Request authority in the hashed component

`_hashedPath = ${_pathname}.${hash([authority(_url), _path])}`.

Without the authority, one handler instance serving several hostnames — the normal nitro/h3
vhost deployment — stored **one entry per path across all hosts**: tenant A's rendering served to
tenant B (h3#1524 finding #2's cross-app body leak, reopened between hosts on one instance after
per-instance storage closed it between processes), and an attacker-supplied `Host` that reached a
rendered absolute URL (canonical link, `Location`, a password-reset link) was stored under the
shared key and published with the synthesized `s-maxage` for shared CDNs to propagate. The
pre-existing mitigation, `varies: ["host"]`, was off by default and _silently_ a no-op on adapters
that don't put `Host` in `req.headers`.

Derived from `event.url` — what the adapter resolved — **never** from the `Host` header; on
adapters that build `url` from that header the two coincide, so a reverse proxy must still
normalize it. Goes in the hashed component, never the human-readable `_pathname` prefix
(debuggability only), and is hashed as a **tuple** with `_path` so the origin/path boundary can't
be read two ways (an opaque-scheme pathname need not start with `/`). Breaking: GET keys moved
once.

`authority(url)` prefers `url.origin` because it canonicalizes (lowercased host, default port
dropped), but `origin` is the literal string `"null"` for every **opaque** origin, including any
non-special scheme where a real authority is present and simply not exposed
(`new URL("x-proxy://a.example/p").origin === "null"`, as does `b.example`) — so those fall back
to `${protocol}//${host}`, or the collision this exists to prevent comes right back.
Authority-less schemes (`file:`/`data:`/`about:`) land on a per-scheme constant, which is right:
their identity is entirely in the path, already hashed alongside.

## `.resolveKeys(event)` / `.invalidate(event)` / `.expire(event)`

Issue #71. They target the **resource, not one method variant**: every cacheable method's variant
of the event's resource key, regardless of which method the event carries, so purging
`/article/hello` can't leave a sibling HEAD entry advertising the dead etag/last-modified for
downstream caches to revalidate against. `resolveKeys` enumerates the same set (one key per base
prefix per method variant), the event's own variant first, so `keys[0]` is still exactly the key
that event reads/writes.

Implemented by feeding each variant key to the standalone helpers as a fixed `getKey` —
`resolveKey` is method-free, so no event is cloned or mutated. `variantOptions` calls
`resolveStorage(_opts)` first: it spreads `_opts` into one fresh options object per variant, so
without pre-resolving, a purge issued before the first request would leave each copy to resolve
its own storage (re-running a factory once per variant).

**Storage memo asymmetry vs `cache.ts`**: `defineCachedHandler` reassigns `opts` to a merged
clone on entry and clones again into `_opts`, so the caller's own options object never receives
the resolved storage. `invalidateCache({ options: myHandlerOpts })` therefore will _not_ reach a
handler's default storage. Deliberate: never-works is clearer than sometimes-works (the memo
would otherwise land only when a purge happened to run before the first request), and
reconstructing a handler key by hand is the error-prone path issue #71 exists to avoid — use the
handler's own methods, or pass an explicit `storage`.
