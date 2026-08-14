# `src/hash.ts` — cache keys and integrity

`hash(input)` = base64url(sha256(`serialize(input)`)). Everything that reaches a storage key or an
`integrity` field goes through it: `resolveName`'s `anon_<hash>`, `escapeKeySegment`, the default
`getKey(...args)`, `integrity`, the `_hashedPath`/header/cookie components in `http/key.ts` and the
body etag in `http/entry.ts`.

Replaced the `ohash` dependency (ocache now ships with none). The shape follows ohash's — sha256,
base64url, source-text serialization of functions, sorted object entries — but it is **not** byte
compatible, so the upgrade rotates every key and every integrity value once: entries written by an
earlier ocache are not found (one cold read), never found-and-rejected.

## The digest backend: `#crypto`

`src/hash.ts` imports `digest` from `#crypto` and knows nothing else about crypto — no capability
check, no `try`/`catch`, no `node:` specifier. Nothing else in the codebase may reach for a crypto
API. The conditional `imports` entry in package.json picks the implementation:

| Condition | File                  | What it is                                                      |
| --------- | --------------------- | --------------------------------------------------------------- |
| `node`    | `lib/digest.node.mjs` | `node:crypto`, one-shot `crypto.hash()` (`createHash` fallback) |
| `default` | `lib/digest.mjs`      | Portable sha256 (FIPS 180-4) + `btoa` base64url                 |

**Why a condition and not a runtime `if`.** Resolution happens in the _consumer's_ bundler, so
each build takes only the arm it needs: a server bundle never pulls the sha256 bytes in (-1.7 kB
min / -1.1 kB gzip), and a worker bundle never sees a `node:` specifier it cannot resolve. A
runtime check cannot do either — both arms would have to survive bundling, which is precisely the
cost this replaced. `test/bundle.ts` builds both platforms and budgets them separately; the gap
between its two rows _is_ `lib/digest.mjs`.

Consequences to keep in mind:

- **Both arms must return identical digests**, or one persistent backend written by a Node process
  and read by a worker splits its key space. `test/hash.test.ts` imports both by path and holds
  each against `node:crypto` across every message-padding boundary. That test is sabotage-checked
  (flip one round constant and it fails), and it is why `lib/digest.mjs` is a straight
  transcription of §6.2 with nothing improvised. It does not show up in the `--coverage` table —
  v8 coverage only reports what vitest transformed, and these ship untransformed — so read the
  test, not the report, before assuming an arm is unexercised.
- **The arms ship as `.mjs`, not built from `src/`** — the consumer resolves the condition, so both
  files must exist in the published package. Hence `"lib"` in `files`, and `dist/index.mjs`
  keeping `#crypto` external (obuild does this on its own; check its `Dependencies:` line if the
  build ever changes).
- `crypto.hash()` is Node >= 20.12/21.7 and node-compat layers lag, so the node arm imports the
  namespace and branches on it. A _named_ import of a missing export is a link-time SyntaxError —
  the whole graph fails before a line runs, instead of falling back.

### Why not WebCrypto

`crypto.subtle.digest` is **async** and `hash` must be sync: `resolveName` and `integrity` hash at
definition time inside the synchronous `defineCachedFunction`/`defineCachedHandler`, and
`escapeKeySegment` is called from plain string composition (`buildCacheKey`). Reaching WebCrypto
would mean making `hash` return a promise, deferring `name`/`integrity` to first async use and
threading `await` through every key path — permanent async in the hot path to save ~1.7 kB min in
the non-Node arm alone. `ohash` ships a JS implementation for exactly this reason.

## What `serialize` guarantees

- **Deterministic across processes and machines.** No counters, no `WeakMap` identity, no
  randomness, and no `localeCompare` (the sort order decides the hash, and locale is per process —
  the same key must resolve on every machine reading one shared backend).
- **Type-tagged branches.** `'str'`, `1n`, `Set[…]`, `Map{…}`, `Ctor{…}`, `Uint8Array[…]` — two
  values of different types cannot render alike.
- **Order-insensitive members.** Object/`Map`/`Set` entries are sorted, so `{a, b}` and `{b, a}`
  share an entry. Objects are sorted on the rendered `key:value` pair, which agrees with sorting on
  the key (object keys are unique) and gives a `Map` keyed by objects a total order for free.
- **Cycles terminate**, collapsing to `#<n>` (visit order). The `seen` entry is overwritten with
  the finished rendering, so a _repeated_ (non-cyclic) reference still renders in full.
- **Functions render as source**, line breaks collapsed. Same source → same hash across restarts,
  which is what makes `anon_<hash>` names and `integrity` usable with a persistent backend, and
  reindentation alone does not go cold. The known cost: two functions with equal source differing
  only in closed-over variables are indistinguishable (documented on `resolveName`, in
  `.agents/cache.md` and in the guides — pass an explicit `name`).
- **Typed arrays render element values, not bytes.** Raw bytes would make an `Int32Array` key
  depend on the machine's endianness. `DataView` (no `join`) is the one view read as bytes.
- **`toJSON` wins where a class has one.** Own enumerable properties miss whatever a class keeps in
  private fields or getters, so two distinct instances would otherwise render as `Ctor{}`.

Changing any of this rotates every persisted key: treat the rendering as a storage format.
