# `http/request.ts` — bypass and request narrowing

The directory's one rule: **a handler may read exactly what the key covers**. `keyHeaderNames`
drives narrowing (`config.ts`), `filters.ts` computes the allowlisted subsets both this module
and `key.ts` use, so neither side can derive its own.

## Bypass

Non-GET/HEAD requests **and any request carrying a `Range` header** bypass the cache — the
built-in half of `resolveBypass`, composed with (never replaced by) any caller
`shouldBypassCache` (issue #50) — and reach the handler untouched, body included, which the
rewritten `Request` would otherwise drop.

Narrowing gates on the **composed** verdict, never the built-in half alone (finding 09): the
built-in check said "cacheable" for a GET the caller had excluded, so `shouldBypassCache`
stripped credentials off the very requests it exempted — and it is the escape hatch the
credential defaults document, so following that advice served the anonymous/401 rendering to
every authenticated user, on every request. `narrowRequest` gates itself rather than trusting
its call site.

The verdict is produced **exactly once per call** (the caller's hook may be async, expensive or
side-effecting) by `resolveBypass`, which `cache.ts` awaits for its short-circuit to the raw
resolver and which memoizes the answer on the event in a per-handler-instance `WeakMap`
(`config.bypassed`, the `searchCache` pattern). Per-call state keyed by the event, deliberately
not a module-level slot (a cross-request bug); threaded through `config` rather than the
resolver's arguments because `cache.ts` calls `fn(...args)` with the caller's args and nothing
else.

**`Range` specifically** (finding 07) — the request-side half of the 206 fix, paired with 206's
absence from the status allowlist. `Range` is forwarded but is neither in the key nor a `Vary`
dimension, so a range-honoring handler (static files, media, `serveStatic`) resolved a _partial_
representation under the range-free key: one `curl -r 0-0` stored a one-byte body plus its
`Content-Range`, and every later `Range`-less GET got that truncation for the whole TTL,
propagated to shared CDNs by the synthesized `s-maxage` (RFC 9110 §15.3.7 / RFC 9111 §3.3 — a 206
answers only the request that named the range; combining partials is out of scope). Bypassing on
the request side is the cheaper half: nothing partial is stored and `serialize` never buffers a
large partial body. Breaking: a ranged request now also skips narrowing (the standard bypass
contract) and gets no `x-cache`/`etag`/`cache-control`.

Bypassed responses pass through untouched: because `serialize` lives outside the resolver, a
bypassed call yields the handler's live `Response`, which the outer wrapper detects
(`value instanceof Response`) and returns as-is — no body buffering (streaming/binary bodies
survive), no synthesized cache headers, no bogus `304` for a non-cacheable method. Breaking vs.
the old always-serialize path.

## What the handler sees

`varies` headers are **forwarded** — their values are part of the key, so reading them is safe
and is the point of declaring them. They used to be the only headers filtered _out_, which meant
`varies: ["accept-language"]` produced correct per-language keys and `Vary` while every entry
held the _default_ rendering (breaking behavior change).

### Cookies (request side)

By default no cookies participate in caching: the `Cookie` header is stripped before the handler
runs and never varies the key. Two opt-ins, both governing **this direction only** (the response
side is not negotiable — see `.agents/http/response.md`):

- `varies: ["cookie"]` — the **coarse** opt-in, symmetric with how `varies: ["authorization"]`
  equals `allowAuthorization: true`: `cookie` stays in `keyHeaderNames`, so the **raw** header
  composes the key _and_ is forwarded untouched. Correct by construction, and the caller owns the
  fragmentation cost — one entry per distinct raw `Cookie` value, i.e. effectively per visitor.
  Previously the raw header was hashed into the key while narrowing still stripped it, so the
  handler rendered the cookie-less default variant into every per-cookie entry (N identical
  entries, zero variation), a key re-derived from an already-served event drifted from the one
  just written (so `.invalidate(event)` after `handler(event)` — the documented issue-#71 pattern
  — silently purged nothing), and the documented "`varies` headers are forwarded" rule was
  contradicted.
- `allowCookies: string[]` — the **fine** opt-in and the one to prefer: only listed names survive
  in the handler-visible `Cookie` header and vary the key (sorted, order-independent —
  `filterCookie`). **Supersedes** `varies: ["cookie"]` in both directions — `cookie` is dropped
  from `keyHeaderNames` (the allowlist hash is strictly finer) and the handler never sees the raw
  header — but is added to `varyHeaderNames`, so `allowCookies` always emits `Vary: Cookie`.

The three-way branch lives in the narrowing block: allowlist → filtered subset; no allowlist but
`cookie` in `keyHeaderNames` → forward raw; neither → strip.

### Authorization

By default `authorization`/`proxy-authorization` do not participate in caching (same rigor as
cookies) — both stripped from the handler-visible request on cacheable calls, so a handler cannot
render per-user content from a credential that isn't in the key. Previously they were forwarded
but never keyed, so a token-authenticated route failed **open**: the first caller's private
response was stored under the anonymous key, replayed to everyone, and advertised
`max-age=N, s-maxage=N` for shared CDNs. Cookie-authenticated routes already failed safe — that
asymmetry was the defect.

`allowAuthorization: true` folds both names into both header lists (deduped against `opts.varies`,
sorted), which in one step makes them vary the key, appear in `Vary`, and stay visible. Listing
either name in `varies` counts as the same opt-in. Callers own the consequence: one entry per
distinct credential value, shared by everyone presenting it. Breaking: handlers needing the
credential must set `allowAuthorization`, or bypass those requests.

## Mutation of the caller's event

Narrowing **mutates** `event.req` (plus `event.url` under `allowQuery`) and never restores it, so
after a MISS the caller observes the narrowed request while after a HIT or bypass it does not.

Not restored in a `finally` on purpose: a handler's body producer can run _after_ the resolver
returns (an async `ReadableStream.pull` is drained by `serialize`'s `res.arrayBuffer()`), so a
restore would hand the original credentialed request back to a lazy read whose output is then
cached and replayed — re-opening exactly what narrowing closes. It would also still leave the SWR
window, where the background refresh swaps the stale reader's event after its response was
returned. The real fix is to stop mutating the caller's event at all, which needs a design
decision because `E` is an arbitrary framework event — **tracked, open**.

The replacement `Request` carries `runtime` and `waitUntil` over, the latter **bound to the
original request** (a bare copy would run with the narrowed `Request` as its receiver;
srvx/Cloudflare implement it against the real one). All four `cache.ts` call sites read
`waitUntil` _after_ this swap, so dropping it made every background write inert on exactly the
runtimes that provide it: the isolate can be torn down before the write lands — every request a
MISS forever, with SWR refreshes and post-failure evictions cancelled the same way.
