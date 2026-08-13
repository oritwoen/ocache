export interface StorageInterface {
  get<T = unknown>(key: string): T | null | Promise<T | null>;
  set<T = unknown>(key: string, value: T, opts?: { ttl?: number }): void | Promise<void>;
}

/** Default entry ceiling for the built-in memory storage before LRU eviction kicks in. */
const DEFAULT_MEMORY_MAX_SIZE = 10_000;

/** Default byte ceiling (100 MB of estimated retained bytes) before LRU eviction kicks in. */
const DEFAULT_MEMORY_MAX_BYTES = 100 * 1024 * 1024;

export interface MemoryStorageOptions {
  /**
   * Maximum number of entries to keep. When exceeded, the least-recently-used
   * entries are evicted. Defaults to `10 000`. Pass `Infinity` (or `0`) to
   * disable the ceiling and grow unbounded.
   *
   * This bounds entry **count**, never memory — the retained bytes are
   * `maxSize × whatever an entry weighs`, which for cached HTTP responses is
   * attacker-influenced. {@link maxBytes} is the memory bound.
   */
  maxSize?: number;

  /**
   * Maximum total **estimated bytes** to keep, the key's own weight included.
   * When exceeded, least-recently-used entries are evicted until the total is
   * back under it. Defaults to `100 MB`. Pass `Infinity` (or `0`) to disable the
   * budget and grow unbounded.
   *
   * An entry that alone exceeds the budget is **not stored** (and any previous
   * value under its key is dropped), rather than flushing the whole cache for
   * something that still would not fit.
   */
  maxBytes?: number;

  /**
   * Per-entry byte estimate, replacing the built-in one. Returns the **whole**
   * charge for the entry — the key included; nothing is added on top. Only called
   * when {@link maxBytes} is armed. A throwing hook, or a result that is not a
   * finite non-negative number, falls back to the built-in estimate.
   */
  sizeOf?: (value: unknown, key: string) => number;
}

/** Creates an in-memory storage backed by a `Map` with optional TTL support (in seconds) and LRU eviction. */
export function createMemoryStorage(opts: MemoryStorageOptions = {}): StorageInterface {
  const rawMaxSize = opts.maxSize ?? DEFAULT_MEMORY_MAX_SIZE;
  const rawMaxBytes = opts.maxBytes ?? DEFAULT_MEMORY_MAX_BYTES;
  // A finite positive ceiling enables LRU eviction; Infinity / 0 / negative disable it.
  const maxSize = Number.isFinite(rawMaxSize) && rawMaxSize > 0 ? rawMaxSize : undefined;
  const maxBytes = Number.isFinite(rawMaxBytes) && rawMaxBytes > 0 ? rawMaxBytes : undefined;
  const sizeOf = opts.sizeOf;
  const map = new Map<string, { value: unknown; expires?: number; bytes: number }>();
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  // Running total, not recomputed (O(cache)/write). Every removal path must funnel through
  // `deleteEntry` — a leaked charge silently converges on evicting everything.
  let totalBytes = 0;

  function deleteEntry(key: string) {
    const entry = map.get(key);
    if (entry) {
      totalBytes -= entry.bytes;
      map.delete(key);
    }
    clearTimer(timers, key);
  }

  return {
    get(key) {
      const entry = map.get(key);
      if (!entry) {
        return null;
      }
      if (entry.expires && Date.now() > entry.expires) {
        deleteEntry(key);
        return null;
      }
      // Raw map ops, not delete+insert: moves the entry (and its byte charge) to MRU.
      if (maxSize || maxBytes) {
        map.delete(key);
        map.set(key, entry);
      }
      return entry.value as any;
    },
    set(key, value, opts) {
      // Drop the previous entry first — releases its bytes/timer; reinsertion below lands it MRU.
      deleteEntry(key);
      if (value === null || value === undefined) {
        return;
      }
      // Only computed when `maxBytes` is armed — an opted-out storage never pays for it.
      const bytes = maxBytes ? entryBytes(key, value, sizeOf) : 0;
      if (maxBytes && bytes > maxBytes) {
        // Evict-to-fit rejected: flushes every other entry for something that still won't
        // fit — cache-flush DoS. Previous value already dropped above; raise `maxBytes` instead.
        return;
      }
      const ttlMs = opts?.ttl ? opts.ttl * 1000 : undefined;
      map.set(key, {
        value,
        expires: ttlMs ? Date.now() + ttlMs : undefined,
        bytes,
      });
      totalBytes += bytes;
      if (ttlMs) {
        const timer = setTimeout(() => {
          deleteEntry(key);
        }, ttlMs);
        // Allow the process to exit even if timers are pending
        if (timer && typeof timer === "object" && "unref" in timer) {
          timer.unref();
        }
        timers.set(key, timer);
      }
      // LRU eviction, one loop, until under both ceilings (`map.keys()` is oldest-first).
      if (maxSize || maxBytes) {
        while ((maxSize && map.size > maxSize) || (maxBytes && totalBytes > maxBytes)) {
          const oldest = map.keys().next().value;
          if (oldest === undefined) {
            break;
          }
          deleteEntry(oldest);
        }
      }
    },
  };
}

// Overhead per entry (Map node, entry object, timer) and per property/slot; depth cap
// sized for `CacheEntry<ResponseCacheEntry>` (needs 3).
const ENTRY_OVERHEAD = 64;
const PROPERTY_OVERHEAD = 8;
const MAX_ESTIMATE_DEPTH = 8;

// Falls back to the built-in estimate on a throw or an unusable result — never degrades to "free".
function entryBytes(key: string, value: unknown, sizeOf: MemoryStorageOptions["sizeOf"]): number {
  if (sizeOf) {
    try {
      const size = sizeOf(value, key);
      if (Number.isFinite(size) && size >= 0) {
        return size;
      }
    } catch {
      // fall through to the built-in estimate
    }
  }
  try {
    return estimateBytes(key) + ENTRY_OVERHEAD + estimateValue(value, 0, new Set());
  } catch {
    // Exotic values only: a throwing getter or proxy trap. Charge the part we know.
    return estimateBytes(key) + ENTRY_OVERHEAD;
  }
}

// Upper bound (2×): engines store latin1 at 1 byte/char. Over-counting is the only safe
// direction (finding 14.1) — keys measured the same way; 10 000×8KB paths measured 296MB RSS.
function estimateBytes(str: string): number {
  return str.length * 2;
}

// JSON.stringify rejected: throws on cycles/BigInt, drops non-JSON, copies the body.
// `seen` dedups cycles/shared subtrees; depth cap bounds recursion, under-counting deep
// values beyond it — what `sizeOf` is for.
function estimateValue(value: unknown, depth: number, seen: Set<object>): number {
  switch (typeof value) {
    case "string": {
      return estimateBytes(value);
    }
    case "number":
    case "bigint": {
      return 8;
    }
    case "boolean": {
      return 4;
    }
    case "object": {
      break;
    }
    default: {
      // undefined, symbol, function: no retained payload worth counting.
      return 0;
    }
  }
  if (value === null || seen.has(value) || depth >= MAX_ESTIMATE_DEPTH) {
    return 0;
  }
  seen.add(value);
  // Binary payloads: byteLength is the weight — walking indices is O(n) and wrong.
  if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer) {
    return value.byteLength;
  }
  const next = depth + 1;
  let total = 0;
  // Array/Set/Map payload lives outside own properties — `Object.keys` would price it zero.
  if (Array.isArray(value) || value instanceof Set) {
    for (const item of value as Iterable<unknown>) {
      total += PROPERTY_OVERHEAD + estimateValue(item, next, seen);
    }
  } else if (value instanceof Map) {
    for (const [k, v] of value) {
      total += PROPERTY_OVERHEAD + estimateValue(k, next, seen) + estimateValue(v, next, seen);
    }
  } else {
    // Plain objects and class instances alike: own enumerable properties.
    for (const key of Object.keys(value)) {
      total +=
        PROPERTY_OVERHEAD +
        estimateBytes(key) +
        estimateValue((value as Record<string, unknown>)[key], next, seen);
    }
  }
  return total;
}

function clearTimer(timers: Map<string, ReturnType<typeof setTimeout>>, key: string) {
  const existing = timers.get(key);
  if (existing !== undefined) {
    clearTimeout(existing);
    timers.delete(key);
  }
}

/**
 * Where a cached function/handler persists its entries: a ready {@link StorageInterface},
 * or a factory returning one.
 *
 * The factory form exists for **late binding** — handlers are typically defined at module
 * load while the real backend (Redis, KV, ...) only exists once the server has started.
 * It is called on the first actual cache read/write, never at definition time, and at
 * most once per cached function/handler.
 */
export type StorageOption = StorageInterface | (() => StorageInterface);

// optsList[0] is the source of truth. Global storage rejected (h3#1524 #2) — unset
// `storage` now gets a fresh instance per cached fn/handler; write-back lets standalone
// helpers reach it too (same caveat as `name`). Factory runs once. `//`, not JSDoc: docs4ts.
export function resolveStorage(
  ...optsList: Array<{ storage?: StorageOption } | undefined>
): StorageInterface {
  const configured = optsList[0]?.storage;
  const resolved = typeof configured === "function" ? configured() : configured;
  const storage = resolved ?? createMemoryStorage();
  for (const opts of optsList) {
    if (opts) {
      opts.storage = storage;
    }
  }
  return storage;
}
