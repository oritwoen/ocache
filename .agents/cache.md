# `cache.ts` — core caching

Deep dive for `defineCachedFunction` / `cachedFunction` and the standalone helpers. The HTTP
layer builds on all of this (`.agents/http/key.md`, `.agents/http/response.md`).

## Cache key `name`

`resolveName(opts.name, fn)` → `opts.name || fn.name || anon_<hash(fn)>`. Exported from
`cache.ts` and **shared with `http/config.ts`** (which passes the wrapped `EventHandler` as
`fn`) so the two paths cannot drift.

- Called on the caller's options **before** the defaults merge. Merging first pins `name` to the
  default `"_"` forever — that is how issue #53's fix missed the HTTP layer and every handler
  keyed as `"_"` (see `.agents/http/key.md` for what that collided).
- Anonymous fns fall back to a source hash so distinct inline fns don't share a key and thrash.
  **Caveat**: a source hash can't tell apart same-source fns differing only by closed-over
  variables — pass an explicit `name` (or `getKey`). Per-instance discriminators
  (counter/WeakMap/randomness) are inadmissible: keys must be deterministic across process
  restarts for persistent backends.
- The standalone `resolveCacheKeys`/`invalidateCache`/`expireCache` can't see `fn`, so always
  pass the same `name` you cached with.
- The segment reaches the key **escaped** (`escapeKeySegment`, inside `buildCacheKey`, so every
  path agrees by construction): non-word chars dropped, plus `.<hash(raw)>` whenever that
  changed anything. It was the last raw segment — harmless while every handler keyed as `"_"`,
  but not once it comes from `fn.name`, which is no controlled alphabet: `named.bind(null)` is
  `bound named` (embedded space), and a handler named `page:HEAD` built **exactly** the key a
  `page` handler's HEAD variant writes. Breaking only for names carrying an escapable character
  (≈ one `anon_<hash>` in five — ohash's alphabet includes `-`); `name` is outside the integrity
  hash, so a moved entry is simply not found: one cold read, never found-and-rejected.

## Option merging

**An option explicitly set to `undefined` is treated as unset** — `definedOptions`, exported and
applied at _both_ defaults merges (here and `http/config.ts`'s `resolveHandlerConfig`).

Object spread copies own properties _including_ undefined-valued ones, so `{ ...defaults(),
...opts }` let `{ maxAge: undefined }` clobber the `maxAge: 1` default while `{}` kept it:
measured, `{}` resolved once and wrote `{ ttl: 1 }` while `{ maxAge: undefined }` resolved on
every call and wrote nothing. That spelling is what plumbing produces, never what anyone types —
`defineCachedHandler(h, { maxAge: routeConfig.maxAge })` with an unset rule — and the route then
silently stopped caching. Predates finding 10.6 (before it, the same divergence cached
_forever_) and applied to every option: `swr`/`staleMaxAge`/`storage`/`getKey`/`varies` all had
the shape.

Only `undefined` is dropped — `null` stays a nullish (refused) lifetime. Applied to a **copy**:
the caller's object is the storage memo slot, and `resolveName`/`resolveStorage` read the
original. Idempotent, which is what makes the handler path safe (it merges twice). **Subsumes**
the removed `swr`-without-`maxAge` normalization (`resolveMaxAge`): "no `maxAge`" is not a
configuration any merge can produce, so the only zero-lifetime spellings left are an explicit
`<= 0` and a `getMaxAge` yielding one. `{ swr: true, staleMaxAge: 600 }` therefore caches for
the default second, which is what `{}` has always done.

## Lifetimes and the storage TTL

`storageTtl(maxAge, staleMaxAge, swr)` is the single decision point: `{ ttl }`, `undefined`
("store it, no TTL") or `false` ("don't store it"). `remainingTtl` (the `expireCache` rewrite)
derives from the same call, so expiring can neither extend a life, strip a TTL, nor arm one the
write withheld — it duplicated the logic before, which is how the three drifted.

Rule: **never write an entry that has neither an expiry nor a storage TTL** (finding 10.6). The
two shapes it must tell apart:

- `{ swr: true, maxAge: 60 }` — **has** an expiry (`entry.expires`), no TTL. Merely _retained_
  past going stale, which is the whole of ISR: the last good value keeps being served while a
  background refresh replaces it, and a _failed_ refresh keeps serving the last success (Next's
  `revalidate` marks a page eligible for regeneration, never deletes it; Vercel bounds ISR by
  capacity, not a timer — and `x-nextjs-cache`'s HIT/STALE/MISS is what `x-cache` mirrors).
  **Allowed.** Finding 14.3 proposed defaulting this TTL to `maxAge`; **rejected** — the entry
  would be deleted the instant it went stale, degrading SWR to foreground revalidation and
  making `docs/1.guide/9.isr.md` impossible. The bound on this shape is backend **capacity**,
  and since finding 14.1 the built-in backend actually is one (`.agents/storage.md`).
- `{ maxAge: 0 }`, or a `getMaxAge` clamped to it — **neither**: unservable-as-fresh _and_
  unreclaimable, a permanent HIT. **Refused**, and a prior entry on that key is evicted instead
  (which also clears what an older ocache left). A **nullish** `maxAge` is refused with it, but
  is unreachable through either defaults merge (both supply `maxAge: 1`, which an explicit
  `undefined` no longer defeats); it stays live for the standalone `expireCache`, which merges
  no defaults.

## Hooks

- `getMaxAge(entry)` — dynamic per-entry TTL, run after the resolver: seconds (shorthand for
  `maxAge`) or `{ maxAge?, staleMaxAge? }`. Persisted onto the entry, so it drives the read
  freshness check, the storage TTL and — in `defineCachedHandler` — the synthesized
  `Cache-Control` (finding 10.2). Runs before `serialize`, so `entry.value` is the live value;
  don't consume a one-shot body, `serialize` reads it exactly once. `http/index.ts` always
  installs its own wrapper, so a handler entry always carries both fields (`undefined` = "no
  override", never "not asked") — that is what makes finding 10.2's advertisement sound.
- `serialize(entry, { args })` — write-side counterpart of `transform` (which deserializes on
  read). For resolver outputs a backend can't persist as-is (raw `ReadableStream`, class
  instances). Runs **exactly once per resolution**, shared across deduplicated callers, so
  consuming a one-shot source is safe; a throw fails the call and evicts, like a rejected
  resolver. Both hooks are folded into the shared in-flight promise so neither runs twice.

## Dedup registry

`pending` is a **`Map`, never a plain object**: keys are caller-controlled (the documented
`getKey: (id) => id`), and a plain object inherits from `Object.prototype`, so
`pending["constructor"]`/`"toString"`/`"__proto__"` read truthy with nothing in flight. Such a
call was treated as a deduplicated follower, `await`ed the inherited member (not a thenable, so
it resolved to itself), never called the resolver, and cached `undefined` — silently for
`defineCachedFunction`, and as a hard permanent `TypeError` for `defineCachedHandler` (whose
`transform` then dereferences `undefined.headers`). Takes a custom `getKey` to reach. Unrelated
to prototype _pollution_ — this was unsafe prototype-chain _reading_.

## Resolution deadline

**`maxResolveTime` (seconds, default `30`)** bounds one shared in-flight resolution — the
resolver _plus_ the `getMaxAge` and `serialize` hooks folded into the same `pending` promise
(`withDeadline`; `Infinity`/`0`/negative disable it, the `createMemoryStorage` normalization
shape). Covering the hooks is deliberate: `serialize` is where a never-ending body is drained, so
a deadline around `resolver()` alone would miss the measured case.

A resolution that **never settles** was the one leak in an otherwise clean `pending` lifecycle
(cleanup is verified on the resolve path, the reject path, and a throwing
`getMaxAge`/`serialize`/`validate`): one hung upstream kept its slot occupied forever, so every
later request for that key became a follower of a resolution that would never finish — the key
was dead for the whole process, unrecoverable without a restart (finding 03, part 2; measured
`req1`/`req2` both unsettled after 10 s).

- **The waiters reject** (`TimeoutError`, the name `AbortSignal.timeout()` uses) rather than the
  finding's weaker "at minimum evict the `pending` entry": a caller awaiting a resolution nobody
  will complete is not "served" — it holds its request open until something outside kills it,
  which on a serverless runtime is nothing — and the weaker form fails the finding's own
  regression test, whose second request is already a follower when the deadline fires. Rejecting
  also means an abandoned resolver that settles **late cannot write**: the whole storage-write
  block sits after that `await`, so its long-dead value can never land on a key a fresh leader
  has since re-resolved.
- Not **cancelled** — there is no `AbortSignal` to hand the caller's `fn`. It keeps running, and
  `withDeadline` keeps its handlers attached so a late rejection is absorbed, not unhandled. The
  timer is `unref()`ed and cleared on **every** settle path (`.then(f, f)`, never `.finally`,
  whose returned promise would reject with nothing listening).
- A timed-out resolution is a **failed** one in every respect, the storage eviction included:
  "the resolution failed" has one meaning in this file, and a softer one for timeouts would
  pre-empt the open 19.3 question of whether evicting on failure is right at all, in one arm
  only. Errors route through the existing shapes — thrown to the caller in the foreground,
  reported via `onError` for a background refresh (the same wedge, the same deadline).
- **Seconds, not milliseconds**, and named `max*` for it: every other time value here is seconds
  (`maxAge`, `staleMaxAge`, `getMaxAge`'s return, the storage `ttl`), so a `maxResolveTime: 30`
  read as 30 ms would be a config that _looks_ like it works and no real resolver survives —
  a silent failure prose cannot fix, which is why `resolverTimeout` was rejected (`timeout` is
  milliseconds in `setTimeout`/`AbortSignal.timeout()`/ofetch/undici/axios). `max*` also names
  the right scope: the whole shared resolution, hooks included. Fractions cover sub-second
  (`0.5`); the `× 1000` happens at the `setTimeout`, and the `TimeoutError` message reports the
  configured seconds. A unit suffix (`maxResolveTimeSeconds`) stays rejected — it would be the
  only option here carrying one, implying the others are ambiguous.
- Deliberately **not** in `defaultCacheOptions()`/`defaultHandlerOptions()`, so the default
  doesn't materialize as a key on `opts` and cool every existing entry; setting it explicitly
  costs that one integrity change, since it stays in `integrityOpts` (it is not a
  storage-_location_ field). Flows to `defineCachedHandler` for free — `http/index.ts` spreads
  the caller's options into `_opts`.

Two consequences: a slow-but-eventually-fine upstream that would have answered at 31 s now
**fails** at 30 s (raise or disable the option — that is the trade), and the extra promise
between a resolution and the leader's write means a **sync** resolver's SWR background refresh no
longer lands on `entry.value` before the serve path returns, so `swr` now serves the stale value
for sync and async resolvers alike. The latter was always a microtask-tick accident (an async
resolver never made it in time); asserted in `test/index.test.ts`. Uncovered by design: storage
`get`/`set` sit outside the shared promise, so a wedged backend is a different problem.

## Purge helpers

`.resolveKeys(...args)` / `.invalidate(...args)` / `.expire(...args)` on the returned function,
and the standalone `resolveCacheKeys` / `invalidateCache` / `expireCache({ options, args })`.
`expire` marks entries stale without removing them: SWR keeps serving stale within the original
`staleMaxAge` window while the next access refreshes in the background.

- The standalone helpers are generic over `args` and know nothing about HTTP methods, so for a
  `defineCachedHandler` key they cover only the **one method variant** their `args` imply. Use
  the handler's own `.invalidate(event)`/`.expire(event)` (`.agents/http/key.md`).
- They reach a store only when handed the **same options object** (whose resolved storage is
  memoized on it) or an explicit `storage`, so they **throw** on an unset one (`requireStorage`)
  rather than purging a fresh empty store while the stale entry keeps being served. A mismatched
  `name`/`getKey` still no-ops silently. `resolveCacheKeys` is pure key derivation, unaffected.

## Storage resolution

`opts.storage` is a `StorageInterface` or a factory, defaulting to a fresh
`createMemoryStorage()` **per cached function/handler** — never global (`.agents/storage.md`).
Resolved lazily via `resolveStorage(_optsRef, opts)` on first read/write (never at definition
time — factories exist for late binding) and memoized back into the caller's options _and_ the
internal clone, so a factory runs at most once and the instance methods and the standalone
helpers reach the same store.

## `waitUntil`

Optional on `event.req` (srvx/Cloudflare `ServerRequest`), read as `event?.req.waitUntil?.(p)` at
four sites: the cache write, the SWR background refresh and both evictions. All four read it
_after_ `http/request.ts` swaps in the narrowed `Request`, so that swap must carry it over —
bound to the original request (see `.agents/http/request.md`).
