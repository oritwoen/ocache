# ocache

Composable caching primitives. Works with any runtime that has standard `Request`/`Response`.

## Project Structure

```
src/
├── index.ts        # Public exports (re-exports from all modules)
├── types.ts        # All type definitions (HTTPEvent, CacheEntry, CacheOptions, etc.)
├── cache.ts        # Core: defineCachedFunction, cachedFunction, invalidateCache, resolveCacheKeys
├── http/           # HTTP layer: defineCachedHandler (depends on cache.ts)
│   ├── index.ts         # defineCachedHandler: the wiring onto cachedFunction + the serve path
│   ├── config.ts        # Caller options -> the per-handler `HandlerConfig` every module reads
│   ├── request.ts       # What bypasses the cache + narrowing what the handler may see
│   ├── key.ts           # Cache key: resource identity + method component
│   ├── filters.ts       # Cookie/query allowlist filters, shared by request.ts and key.ts
│   ├── entry.ts         # Storage codec both ways: Response <-> ResponseCacheEntry
│   ├── validate.ts      # The `validate` hook: status allowlist + response-side opt-outs
│   ├── cache-control.ts # RFC 9111 directive parser (no policy, just syntax)
│   ├── vary.ts          # Vary merging and the two response-`Vary` predicates
│   └── conditional.ts   # 304 decisions and the headers a 304 must echo
├── hash.ts         # `hash`/`serialize`: cache keys + integrity, digest via `#crypto`
└── storage.ts      # Storage interface + built-in memory storage

lib/                # Shipped as-is (not built): the two arms of the `#crypto` import
├── digest.node.mjs # `node` condition -> node:crypto
└── digest.mjs      # default condition -> portable sha256
```

Each mechanism lives in the module its name suggests; `http/index.ts` holds only the wiring (the
`CacheOptions` hooks handed to `cachedFunction`, the resolver, the serve path, the revalidation
helpers). The `http/` dependency graph is a DAG — `cache-control.ts`, `vary.ts`, `conditional.ts`
and `config.ts` import nothing from the directory.

## Deep dives (`.agents/`)

Laid out to mirror `src/`. Read the one that owns the area you are changing **before** editing
it: they carry the measured symptom, the rejected alternatives and the findings behind each
shape — the code comments only reference them.

| File                       | Covers                                                                                                 |
| -------------------------- | ------------------------------------------------------------------------------------------------------ |
| `.agents/cache.md`         | `cache.ts`: `name`, option merging, lifetimes/storage TTL, dedup + deadline, hooks, purge, `waitUntil` |
| `.agents/http/key.md`      | `http/key.ts`: key shape (name, method, authority) + the revalidation helpers                          |
| `.agents/http/request.md`  | `http/request.ts` (+ `config.ts`, `filters.ts`): bypass, narrowing, cookies/credentials                |
| `.agents/http/response.md` | `http/entry.ts`, `validate.ts`, `vary.ts`, `cache-control.ts`, `conditional.ts`                        |
| `.agents/storage.md`       | `storage.ts`: memory-backend ceilings, byte accounting, `resolveStorage`                               |
| `.agents/hash.md`          | `hash.ts`: the digest backend lookup, what `serialize` renders and why it must stay stable             |

## Cross-module invariants

Breaking one of these is how nearly every finding in the deep dives happened.

- **A handler may read exactly what the key covers.** `keyHeaderNames` drives both narrowing
  (`request.ts`) and key composition (`key.ts`); the allowlist subsets are computed once in
  `filters.ts` so neither side derives its own. Narrowing is an allowlist — undeclared headers
  are stripped; the only exemptions are `filters.ts`'s `safeHeaderNames`, and adding one is a
  claim that no key could ever cover it.
- **The storage decision and the advertisement share predicates.** `isCacheableStatus`,
  `hasVaryWildcard`, `hasUnkeyedVary` are read by `validate.ts` (may we store it?) and `entry.ts`
  (may we advertise a lifetime?). Never re-implement one at a call site.
- **Never write an entry with neither an expiry nor a storage TTL** — `storageTtl` is the single
  decision point, and `remainingTtl` (`expireCache`) derives from it.
- **Storage is per instance, never global**, and key derivation must be deterministic across
  process restarts (persistent backends).
- `resolveName`, `definedOptions`, `resolveStorage` are shared internals exported from `cache.ts`
  and `storage.ts` so the function and handler paths cannot drift. `name` must be resolved
  **before** the defaults merge on both paths.
- Key segments reaching a `:`-joined key go through `escapeKeySegment`.

## Docs

- Never touch contents inside `<!-- automd -->` in README.md — auto-generated (`pnpm fmt`).
- User-facing guides live in `docs/1.guide/`. Behavior changes that alter a documented string or
  default belong there too (`8.cache-control.md`, `9.isr.md` are the closest to the internals).

## Dev Commands

- `pnpm vitest run test/` — run tests
- `pnpm typecheck` — `tsc --noEmit --skipLibCheck`
- `pnpm lint` — `oxlint` + `oxfmt --check`
- `pnpm build` — build with obuild

## Design Decisions

- No h3/srvx/unstorage dependency — fully standalone, and **zero runtime dependencies**. Cache
  keys and integrity hash through `src/hash.ts` (sha256/base64url over a deterministic
  `serialize`), which replaced `ohash`. Its digest comes from the `#crypto` conditional import:
  `node:crypto` under the `node` condition, a portable sha256 (`lib/digest.mjs`) otherwise, so
  each consumer bundles only the arm it needs. Both arms must give byte-identical keys; `hash` is
  sync, which is why neither is WebCrypto (`.agents/hash.md`).
- `base` supports `string | string[]` — multi-tier: reads try each prefix in order (first hit
  wins), writes go to all prefixes (a tier-N hit promotes to tiers 0..N).
- Default cache key group: `"functions"` (cache.ts) / `"handlers"` (http/index.ts) — no `ocache/`
  prefix.
- Integrity excludes the storage-location fields `base`/`group`/`name`/`storage`, in **both**
  `integrityOpts` (cache.ts, http/config.ts), so entries survive a backend or prefix change. See
  the JSDoc in `cache.ts` for why hashing `storage` is both meaningless and expensive.
- Framework integration hooks on `CachedEventHandlerOptions`: `toResponse(value, event)`,
  `createResponse(body, init)`, `handleCacheHeaders(event, conditions)` — each replacing the
  built-in `Response`/304 behavior.
