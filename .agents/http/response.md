# The response side — `entry.ts`, `validate.ts`, `vary.ts`, `cache-control.ts`, `conditional.ts`

`defineCachedHandler` is split along the `serialize` seam, built on `cachedFunction<Response>`:
the **resolver** narrows the request and returns the handler's live `Response`; the internal
**`serialize`** consumes the body, synthesizes `etag`/`last-modified`/`cache-control`/`Vary`,
strips every `Set-Cookie`, and builds the stored `ResponseCacheEntry`; **`transform`**
reconstructs the servable shape and injects the cache-status header on read. All three are
`Omit`ted from `CachedEventHandlerOptions` so internal use doesn't collide with a caller's.

## What may be stored

**One status gate**, `isCacheableStatus` over `{200, 203, 301, 308}` — the statuses whose
response is a complete, reusable representation of what was requested. It replaced three
overlapping conditions (`status >= 400`, `nullBodyStatuses`, and the implicit "anything under
400 is fine"), so "what may be stored" is expressed in one place, which `serialize` also
consults. Each exclusion is load-bearing:

- `302`/`303`/`307` are per-request answers — an auth middleware's `302 → /login?next=/dashboard`
  was stored under the **anonymous** `/dashboard` key (request-side defaults strip
  `Cookie`/`Authorization`, so anonymous and authenticated callers share a key) and published
  shared-cacheable, bouncing an authenticated user to someone else's login redirect.
- `206` is a partial body valid only for the range asked for (finding 07).
- `201`/`202`/`300` are operation outcomes or an unresolved choice.
- `204`/`205`/`304` have nothing to replay — a 304 answers _one_ client's conditional request, so
  a crafted `If-Modified-Since: <far future>` stored one that every later **unconditional**
  request got for the whole TTL, self-healing never.

Strictly narrowing: nothing previously rejected became acceptable, no existing entry invalidated.
Caching `404`/`410` (RFC 9111 permits it heuristically) was considered and **declined**: it
expands behavior and makes a 404 flood a cache-flush vector — finding 14.1's byte budget bounds
what such a flood can _retain_, not the eviction pressure it applies to the hot set (14.2).

`nullBodyStatuses` (`204`/`205`/`304`) survives for the **read path only**, independently of
`validate`: `serialize` stores a body-less response as `""` (not nullish, so `?? null` misses it),
`new Response("", { status: 204 })` **throws**, and the MISS caller is served through the freshly
serialized entry regardless of `validate`'s verdict — so without forcing `body → null` before
`createResponse` every 204/205/304 would crash on the way out.

`validate` rejects a **missing** body (`value.body === undefined`) but accepts `""`: a zero-byte
200 is legal and rejecting it would only cost hit rate. The dangerous empty body (a body-less
HEAD response replayed to GET clients) is prevented by the method component in the key.

## Response-side opt-outs

Never cached (rejected in `validate`), though still returned to the caller: `Cache-Control:
no-store` / `private` / `no-cache` / a zero **shared** lifetime, and `Vary: *`.

Which directive states the lifetime follows RFC 9111 §5.2.2.10: **`s-maxage` overrides `max-age`
for a shared cache** and ocache is one, so directives are collected first and only then judged —
`s-maxage` governs whenever it parses, `max-age` otherwise, and only that effective value being
`<= 0` rejects. Rejecting on the first zero of either (the shape this landed as) refused
`public, max-age=0, s-maxage=600` — the canonical "browsers revalidate, CDN caches" idiom, a
request _to_ be stored — in both directive orders, while `s-maxage=0, max-age=600` must still
reject.

Only `no-store`/`private` used to be recognized, so `no-cache` and a zero `max-age` — the two
commonest ways to write "don't reuse this", and what `"/**": { swr: 60 }` puts every hand-marked
page behind — were stored and replayed while the directive was faithfully echoed to the client
(same shape as h3#1524 finding #15, one directive over). `no-cache` is **rejected outright**, not
stored-with-revalidation: RFC 9111 §5.2.2.4 permits storing it if every reuse revalidates first,
which is real new machinery (ocache has no foreground-revalidation path) and buys nothing until
that exists; a `TODO` at the branch records it.

Directives are **parsed**, never substring-matched (`cacheControlDirectives`, quoted-string aware
so `no-cache="set-cookie, x"` is one directive; `deltaSeconds` is RFC 9111 `1*DIGIT`, so
`max-age=0600` is 600s and `stale-while-revalidate=0` is not a zero lifetime; a malformed value
states nothing and is ignored, except a leading `-` which reads as already-expired). The
qualified `no-cache="field"`/`private="field"` forms are rejected like the bare ones: they scope
the ban to named fields, but ocache replays a stored header set verbatim, so honoring them would
mean stripping fields on every reuse.

`Vary: *` lives in the same predicate (finding 13) but reads a different header — so
`forbidsSharedCaching` takes the whole serialized header set and delegates to
`cacheControlForbidsReuse`, rather than pretending it inspects one header. `hasUnkeyedVary` is a
**separate** check in `validateEntry`, deliberately not another arm: such a response forbids
nothing — it is cacheable, ocache just can't key it.

All of this governs storage only: concurrent requests are still coalesced by cache key, so
per-user responses must be keyed correctly.

### `must-revalidate` is not an opt-out

It constrains stale serving, not storage (RFC 9111 §5.2.2.2), so it must not reject. Instead the
internal `getMaxAge` wrapper persists **`staleMaxAge: 0` on that entry**: `cache.ts`'s read path
computes `staleTtl === 0` → `swr = false` for that entry alone, so a fresh read is still a HIT and
an expired one revalidates in the **foreground** instead of serving stale.

Chosen over a new `CacheEntry.mustRevalidate` flag because "no stale window" is already exactly
what `staleMaxAge: 0` means: no new field, no `cache.ts` change, and it flows through the
storage-TTL and `expireCache` math for free — all of which a flag would have to be taught
separately.

The wrapper computes its own override **first and independently** and isolates the caller's hook
in its own `try` (reported through the same `onError` / `console.error("[cache] getMaxAge hook
error.")` shape `cache.ts` uses, so it is neither silent nor double-reported): `cache.ts` handles
a throwing hook by leaving _both_ values `undefined`, so awaiting the caller's hook first and
uncaught let one throwing caller hook take ocache's own `staleMaxAge: 0` down with it and the
entry was served STALE — exactly what `must-revalidate` forbids. A throw degrades to "no _caller_
override", never "no override at all". `proxy-revalidate` is the shared-cache counterpart and
belongs in the same place, deliberately left to a separate change.

## `cache-control` synthesis

Sets `cache-control`, `etag`, `last-modified` — but never clobbers an explicit `cache-control`
set by the handler.

**Gated on `isCacheableStatus`, `hasVaryWildcard` and `hasUnkeyedVary`** — the same three
predicates `validate` rejects on, deliberately shared functions so the advertisement and the
storage decision cannot drift. They had: `serialize` runs before `validate` and shipped the header
regardless of the verdict, so a 500 was _not_ stored — origin takes every request, zero
protection — while being advertised `s-maxage=60, stale-while-revalidate=600`, pinned at every CDN
for 11 minutes and revalidating successfully. Inverted on both sides.

Not "synthesize if `validate` passes": the gate covers exactly the rejections a **fresh** response
can trip while carrying no `Cache-Control` of its own. `validate`'s remaining rejections split
three ways — structurally impossible here (an explicit opt-out already suppresses synthesis via
the `has("cache-control")` check; a `set-cookie` is deleted before this point; a missing body
can't occur on a value `serialize` just built) — and **deliberately ungated**: `shouldCache`, a
caller's own storage policy, where "ocache doesn't store this, but a CDN may" is a real
configuration and `sendCacheControl: false` is the inverse knob.

**Both `Vary` verdicts were the gap**, for one reason: unlike every other opt-out they are spelled
in a header that leaves `cache-control` empty, so synthesis fired for a response never stored (the
finding-10.1 shape, one header over) — `Vary: *` first (finding 08), then `hasUnkeyedVary`
(finding 13). The gate reads the handler's raw `Vary` (it runs before `appendVary`), `validate`
the merged one; same verdict, since the merge only adds keyed names.

### The advertised lifetime is the entry's, not the option's

Finding 10.2: `serialize` receives the whole `CacheEntry` and reads `entry.maxAge ?? opts.maxAge`
/ `entry.staleMaxAge ?? opts.staleMaxAge` — the same per-field precedence `cache.ts` applies to
the freshness check, the storage TTL and `expireCache`. Reading the static options alone meant
`{ maxAge: 3600, getMaxAge: () => 2 }` expired ocache's entry after 2 s while every shared cache
kept that 2-second-old copy for an hour: the dynamic TTL honored at the layer holding the value
and discarded at the layer holding the audience. Sound because `http/index.ts` **always** installs
its `getMaxAge` wrapper, so both fields are always written. The wrapper's own `staleMaxAge: 0` can
never be advertised: it exists only when the handler set `must-revalidate`, i.e. exactly when
`has("cache-control")` has already suppressed synthesis.

### What is emitted

`max-age=<lifetime>` whenever a lifetime is present (`0` included), `s-maxage=<the same number>`
additionally under `swr`, and `stale-while-revalidate=<staleMaxAge>` only when a stale window is
actually named.

- **`max-age` accompanies `s-maxage` rather than being replaced by it** (finding 10.3) —
  `s-maxage` is shared-cache-only and overrides `max-age` there (RFC 9111 §5.2.2.10), so CDNs see
  no change, but a private cache got no freshness lifetime at all and fell back to heuristic
  freshness over `Date − Last-Modified` (§4.2.2), which is ≈ 0 because `last-modified` is stamped
  at fill time: browsers revalidated on **every** navigation while ocache held the entry for the
  full `maxAge`. The same number on both, because that is the number ocache enforces — a smaller
  one is unenforced fiction, a larger one an overclaim. `s-maxage` is kept rather than folded away
  because it is separately what authorizes a shared cache to store the response to an
  `Authorization`-carrying request (§3.5, reachable under `allowAuthorization`).
- **Never a bare `stale-while-revalidate`** (finding 10.4): RFC 5861 §3 requires the delta-seconds,
  so the argument-less token the ISR shape used to emit was unparseable and had to be ignored
  wholesale (RFC 9111 §5.2.3) — the stale window evaporated downstream while the header read as
  though it hadn't. **Nothing replaces it**, deliberately: that shape's stale window is genuinely
  _unbounded_, so no number states it, and an invented one (`maxAge`, a year) would advertise a
  window ocache never promised. Silence costs nothing real: a downstream cache revalidates when
  `max-age` runs out, ocache answers _that_ request from its retained stale copy while refreshing
  in the background, so ISR still happens one layer in, where it is enforced.
  `{ swr: true, maxAge: 60 }` advertises `max-age=60, s-maxage=60`, and `docs/1.guide/9.isr.md`
  documents that string.
- `maxAge` is treated **identically** with and without `swr` — present (`0` included) advertised,
  absent not. The two branches disagreed (`!= null` under `swr`, truthy without it), so
  `{ swr: true, maxAge: 0 }` shipped `s-maxage=0` while `{ maxAge: 0 }` shipped nothing. Agreeing
  on `!= null` also means `validate` reads the same zero-lifetime opt-out out of a synthesized
  header as out of a hand-written one, so **`maxAge: 0` keeps the response out of storage either
  way** — narrowing, since `cache.ts` clamps a `<= 0` TTL to "re-resolve on every access" and the
  handler already ran on every request; what changes is a dead entry no longer stored plus an
  honest `max-age=0` downstream where silence previously invited heuristic caching. The opposite
  reconciliation would have _started_ storing `{ swr: true, maxAge: 0 }` and serving it stale.
  The `!= null` guard on `maxAge` is defensive only; the one on `staleMaxAge` is load-bearing — it
  _is_ the ISR shape.
- `sendCacheControl: false` opts out of synthesis entirely (**server-only caching**, issue #49 /
  nitro#3997): the entry is still stored and served (SWR/`etag`/`last-modified` unaffected), but
  nothing is advertised — without the `no-store`/`private` tricks that would also disqualify the
  entry via `validate`. It governs only ocache's synthesis; a handler's explicit `cache-control`
  is left untouched and still sent.

## `Vary`

Emitted by merging into whatever the handler set (case-insensitive dedup; a wildcard `*` is left
untouched — such a response is refused by `validate` anyway, so what `appendVary` preserves there
is only what the direct caller is served).

**Two separate lists, deliberately not the same one**: `keyHeaderNames` composes the cache key
(and gates handler visibility of the credential headers), `varyHeaderNames` is the advertisement.
They differ on exactly one name — `cookie` — which `allowCookies` removes from the key list (the
key carries a finer `cookie.<hash(subset)>` component) but which must stay in the `Vary` list,
since the response genuinely varies by the `Cookie` request header and `Vary` has no granularity
below a header name. Conflating them meant an `allowCookies` route advertised `s-maxage`/`max-age`
with **no** `Vary` at all, so a CDN stored one visitor's variant and served it to everyone; and
`varies: ["cookie"] + allowCookies` silently dropped a `Vary` the caller explicitly asked for.
`allowQuery` contributes nothing (query lives in the URL, which downstream caches already key on).

**Documented trade**: `Vary: Cookie` is destructive to CDN hit rates (any unrelated analytics
cookie makes a request its own variant) — the honest version of a shared-cacheability claim
ocache previously hadn't earned. Callers needing downstream hit rate should key by URL instead, or
keep the cookie-keyed cache server-only with `sendCacheControl: false`. **Rejected alternative**:
keep `Vary` off and mark cookie-keyed responses `private` — preserves CDN behavior by opting out
of it rather than by telling the truth, and `private` also disqualifies the entry via `validate`.

### Reading a handler's own `Vary`

Finding 13, the fail-closed half: `hasUnkeyedVary(vary, varyHeaderNames)` rejects in `validate`
and suppresses synthesis in `serialize` — one shared predicate at both sites. ocache _wrote_
`Vary` but never _read_ one, so a handler declaring `Vary: Accept-Language` (the spec-correct way
to say "not interchangeable", RFC 9111 §4.1) had its English rendering stored under the
language-free key and served to every other language — with that same `Vary` attached for
downstream caches to propagate, the layer closest to the origin violating what it told everyone
else.

Compared against **`varyHeaderNames`, not `keyHeaderNames`**: the two differ only on `cookie`,
which `allowCookies` keys as a finer component, so every advertised name _is_ in the key in some
form and a handler declaring `Vary: Cookie` under `allowCookies` must still cache.
Case-insensitive and whitespace-tolerant; only empty list elements are skipped (RFC 9110 §5.6.1 —
a trailing comma isn't degenerate), so a malformed token matches nothing and rejects — **fail
closed**. `*` is deliberately _not_ handled here: it is a different verdict on the same header,
`hasVaryWildcard`'s (finding 08), applied alongside at both sites — folding it in would let a
degenerate `varies: ["*"]` make the wildcard "keyed". Applied on read too, so an older entry heals
on access.

**Breaking**: costs hit rate on a route whose `varies` doesn't match what its handler declares —
which is exactly the route that was serving the wrong body. That includes a custom `getKey` that
already partitions by the header: list the name in `varies` too.

**Full `Vary` support** (folding declared names into the key) is deliberately not attempted:
`Vary` is only known _after_ the handler has run, so it needs a re-key or a second store pass —
the classic two-phase problem, **tracked, open**.

## Cookies, response side

**No `Set-Cookie` ever survives a cacheable route** — unconditional
`res.headers.delete("set-cookie")` in `serialize`, before storage and before the value any caller
(including the direct MISS caller) receives.

Closes issue #61: concurrent same-key requests coalesce onto one resolution, so the leader's
per-request `Set-Cookie` (e.g. a session id) was replayed to every deduplicated peer — a
cross-user session leak. `allowCookies` used to except its own names, which reintroduced that leak
one opt-in later: a handler minting `sid` on first visit stored the response under the _no-sid_
key with `Set-Cookie: sid=s1` attached, so every subsequent first-time visitor (also no `sid`,
same key) got a HIT carrying `sid=s1` — session-fixation grade, and broad rule sets like
`"/**": { swr: 60 }` put every cookie-setting route there (h3#1524 finding #15c).

The more permissive alternative (refuse to _store_ a response that mints a cookie) can't close the
concurrent-peer case at all — coalesced callers share one resolution and are indistinguishable —
so the rule is uniform and one sentence long. The rest of the response is cached normally (mirrors
how CDNs / Varnish drop `Set-Cookie` on cacheable responses). A bare `delete` covers every runtime,
so the old `getSetCookie()` capability branch is gone. `validate` rejects **any** stored
`set-cookie` — defense-in-depth for pre-existing/foreign entries. **Breaking**: handlers minting
per-request cookies must serve them from a non-GET/HEAD (bypassed) route.

## Transport headers

`content-encoding`, `content-length`, `content-range`, `transfer-encoding` are deleted in
`serialize` before storage: the body is stored fully decoded and re-buffered, so replaying an
upstream `content-encoding: gzip` against a decompressed body (or a stale `content-length`/wire
`transfer-encoding`) would desync headers from the served body and yield malformed responses
(nitro#2109). The runtime recomputes `content-length` on read. `content-range` is there for the
same reason and **not** because a 206 could reach storage (it can't — `Range` bypasses and
`validate` rejects the status): it describes a _partial_ body, so on an entry we do store it is
meaningless at best and a lie about the served bytes at worst. Realistic source: a proxying
handler copying upstream headers onto a 200.

## The header set is copied, never mutated in place

`serialize` builds the entry from `new Headers(res.headers)` — one copy taken before the first
synthesis — and the handler's own `Response` is left exactly as it was handed over.

It used to write straight onto `res.headers`: `set` for `etag`/`last-modified`/`cache-control`,
`appendVary`, `delete` for `set-cookie` and the transport headers. Every `Response` produced by
`fetch()`, `Response.redirect()` or `Response.error()` carries the spec's **immutable** header
guard, so the first of those threw a `TypeError` inside `serialize` → the shared resolution
rejected → the entry was evicted → the next request repeated it, forever. That is not a corner:
a reverse proxy over `fetch()` is the canonical use of an HTTP response cache, and `301`/`308`
are on the cacheable-status allowlist specifically so `Response.redirect` can be cached. **No
configuration avoided it** — `sendCacheControl: false` plus an upstream `etag`/`last-modified`
still hit the unconditional `set-cookie` / `appendVary` / transport deletes.

Sound because nothing reads `res.headers` after `serialize`: `getMaxAge` (which does read them,
for `must-revalidate`) runs strictly before it, `validate` and `transform` see the serialized
entry, the serve path rebuilds from storage via `createResponse`, and a bypassed call skips
`serialize` entirely. So for a mutable response the copy is behavior-identical — it only stops
ocache scribbling on an object the caller still owns.

Coverage gap that hid it: every 301 test constructed a mutable `new Response(...)`. The
regression tests now assert the premise (`Response.redirect` really is immutable) alongside the
behavior, since they prove nothing on a runtime that stops enforcing the guard.

## Body encoding

`serialize` decides by **byte validity, not content-type** — a valid-UTF-8 body (fatal
`TextDecoder` with `ignoreBOM`, lossless roundtrip) is stored verbatim as a string (unchanged text
behavior, stable text etags); anything else is base64-encoded and flagged `base64: true`. Base64
rather than a raw `Uint8Array` so binary bodies survive JSON-serializing backends. On read a
`base64` entry decodes back to a `Uint8Array` so the exact bytes replay untouched; `createResponse`
therefore receives `string | Uint8Array | null`.

## `304 Not Modified`

Decided from `if-none-match`/`if-modified-since` (`handleCacheHeaders` overrides it); the headers
a 304 echoes are not overridable. `Vary` above all: a 304 must state the same variant dimensions
or a shared cache updates its stored entry having lost them (RFC 7232 §4.1). The cache-status
header rides along, because a HIT served as a 304 is still a HIT.
