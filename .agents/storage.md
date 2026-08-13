# `storage.ts` — the built-in memory backend

`StorageInterface` is a minimal `get`/`set` (with optional TTL in seconds). Setting a nullish
value deletes the entry instead of storing dead weight.

## Two ceilings, LRU-evicted in one loop

`maxSize` (10 000 entries) and `maxBytes` (100 MB, finding 14.1). They bound different things and
both apply: `maxSize` bounds entry _count_, which is not a memory bound at all — retained bytes
are `maxSize × whatever an entry weighs`, i.e. attacker-influenced for an HTTP handler. Measured:
10 000 × 1 MB documents held 10 GB of RSS, and because the cache is external/large-object memory
the process is **OOM-killed rather than throwing a catchable `RangeError`** — there is no graceful
degradation path to write.

Promoted to a release blocker when finding 14.3 was rejected: `{ swr: true, maxAge: N }` carries
an expiry but no storage TTL (`.agents/cache.md`), so backend capacity became the _only_ bound on
it — the backend therefore has to be one. `Infinity`/`0`/negative disables either ceiling; `get`'s
recency touch is armed when _either_ is.

## The running total is a correctness obligation

The budget is policed by a running total, not by recomputing (which would be O(cache) per write).
That makes every removal path load-bearing: `set` (overwrite included), the nullish-value delete,
the TTL `setTimeout` callback and `get`'s lazy expiry all funnel through `deleteEntry`, the only
place bytes are released, and the single `map.set` in `set` is the only place they are charged.

A leaked count doesn't lose the budget, it converges on **evicting everything** — silently — so
the drift is tested per path. `get`'s LRU touch deliberately uses raw `map.delete`/`map.set`: it
moves the same entry object (and its charge); it is not a delete plus an insert.

## An entry larger than the whole budget is refused

Any previous value under its key is dropped with it. The alternative — store it and sit
permanently over the ceiling — isn't available, and evicting down to fit it flushes every other
entry for something that _still_ doesn't fit, which is finding 14.2's cache-flush DoS reachable
from a single request. Dropping the prior value is what `set` was asked to do; serving the old one
afterwards would be a lie about what is cached, and the read simply misses and re-resolves. The
eviction loop's empty-map guard makes termination unconditional regardless.

## Measuring an entry

- `sizeOf(value, key)` replaces the built-in estimate and owns the **whole** per-entry charge, key
  included — nothing is added on top. Only called when `maxBytes` is armed. A throwing hook, or a
  result that isn't a finite non-negative number, falls back to the built-in estimate: the budget
  degrades to an approximation, never to "free".
- The built-in estimate is a **depth-limited, cycle-safe structural walk**, deliberately not
  `JSON.stringify(value).length` — that throws on cycles and BigInt, drops non-JSON values, and
  allocates a second copy of the very body being measured because it is large. The walk allocates
  nothing but its `seen` set and reads each string's `length` once, so the dominant real shape
  (`CacheEntry<ResponseCacheEntry>`, depth 3) costs a handful of property reads. `seen` charges any
  object once, so a cycle terminates and a shared subtree isn't double-counted; the depth cap (8)
  keeps recursion off the stack limit, at the price of under-counting below it — that is what
  `sizeOf` is for. Typed arrays/`ArrayBuffer` are charged `byteLength` (walking indices would be
  O(n) reads and wildly wrong) and `Map`/`Set` are iterated, since `Object.keys` would price them
  at zero — the dangerous direction. Host objects with no own enumerable properties (a `Response`)
  are likewise under-counted, which is why the HTTP layer stores the serialized entry, not the live
  response.
- Strings are charged at **2 bytes per UTF-16 code unit** — the upper bound; engines store
  latin1-only strings at one byte per character, so an ASCII body is over-charged by up to 2×.
  Over-charging is the only safe direction: a budget that under-counts is not a bound. The key is
  measured the same way and counts toward the entry — the finding's second measurement (10 000 ×
  8 KB attacker-chosen _paths_, 93 MB heap / 296 MB RSS in 6 s, with trivial values) is entirely
  key weight.

## `resolveStorage` and the absence of a global

`StorageOption` is `StorageInterface | (() => StorageInterface)`; the factory form exists for late
binding (handler defined at module load, backend configured at server start). `resolveStorage(
...optsList)` resolves `optsList[0].storage` (factory → call it; unset → a fresh
`createMemoryStorage()`) and writes the result into every listed options object.

**No global storage.** `useStorage()`/`setStorage()` are _removed_, not deprecated: the
module-level slot made the last `setStorage()` call win for every consumer in the process, so two
independent apps each building their own handler + storage shared one backend and served each
other's cached response bodies (h3#1524 finding #2). Per-instance defaults close it by
construction — two defaults can never collide on a key. Sharing is explicit: pass the same
`storage`.
