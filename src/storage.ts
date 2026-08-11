export interface StorageInterface {
  get<T = unknown>(key: string): T | null | Promise<T | null>;
  set<T = unknown>(key: string, value: T, opts?: { ttl?: number }): void | Promise<void>;
}

/** Default entry ceiling for the built-in memory storage before LRU eviction kicks in. */
const DEFAULT_MEMORY_MAX_SIZE = 10_000;

export interface MemoryStorageOptions {
  /**
   * Maximum number of entries to keep. When exceeded, the least-recently-used
   * entries are evicted. Defaults to `10 000`. Pass `Infinity` (or `0`) to
   * disable the ceiling and grow unbounded.
   */
  maxSize?: number;
}

/** Creates an in-memory storage backed by a `Map` with optional TTL support (in seconds) and LRU eviction. */
export function createMemoryStorage(opts: MemoryStorageOptions = {}): StorageInterface {
  const rawMaxSize = opts.maxSize ?? DEFAULT_MEMORY_MAX_SIZE;
  // A finite positive ceiling enables LRU eviction; Infinity / 0 / negative disable it.
  const maxSize = Number.isFinite(rawMaxSize) && rawMaxSize > 0 ? rawMaxSize : undefined;
  const map = new Map<string, { value: unknown; expires?: number }>();
  const timers = new Map<string, ReturnType<typeof setTimeout>>();

  function _delete(key: string) {
    map.delete(key);
    _clearTimer(timers, key);
  }

  return {
    get(key) {
      const entry = map.get(key);
      if (!entry) {
        return null;
      }
      if (entry.expires && Date.now() > entry.expires) {
        _delete(key);
        return null;
      }
      // Mark as most-recently-used by reinserting (Map preserves insertion order).
      if (maxSize) {
        map.delete(key);
        map.set(key, entry);
      }
      return entry.value as any;
    },
    set(key, value, opts) {
      _clearTimer(timers, key);
      if (value === null || value === undefined) {
        map.delete(key);
        return;
      }
      // Delete first so reinsertion moves the key to the most-recent position.
      map.delete(key);
      const ttlMs = opts?.ttl ? opts.ttl * 1000 : undefined;
      map.set(key, {
        value,
        expires: ttlMs ? Date.now() + ttlMs : undefined,
      });
      if (ttlMs) {
        const timer = setTimeout(() => {
          map.delete(key);
          timers.delete(key);
        }, ttlMs);
        // Allow the process to exit even if timers are pending
        if (timer && typeof timer === "object" && "unref" in timer) {
          timer.unref();
        }
        timers.set(key, timer);
      }
      // Evict least-recently-used entries once over the ceiling.
      if (maxSize) {
        while (map.size > maxSize) {
          const oldest = map.keys().next().value;
          if (oldest === undefined) {
            break;
          }
          _delete(oldest);
        }
      }
    },
  };
}

function _clearTimer(timers: Map<string, ReturnType<typeof setTimeout>>, key: string) {
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

// Resolves `opts.storage` into a concrete backend, memoizing it back into every options
// object passed. `optsList[0]` is the source of truth and must be the one stable object per
// cached function/handler instance; the rest are mirrors (internal clones of it).
//
// There is deliberately no ambient storage to fall back on. The removed `setStorage()`
// singleton meant the *last* call won for every consumer in the process — including
// unrelated `defineCachedFunction` callers who never asked for it — which is how two
// independent apps, each constructing its own handler and its own storage, ended up sharing
// one backend and serving each other's cached response bodies (h3#1524 audit, finding #2).
// So an unset `storage` yields a *fresh* memory storage per cached function/handler:
// colliding by accident is now impossible, and callers who want a shared cache pass the
// same `storage` explicitly.
//
// The write-back is what lets the standalone `resolveCacheKeys` / `invalidateCache` /
// `expireCache` helpers reach the same store as the cached function — hand them the same
// options object and they see the memoized instance. Same mechanism (and same caveat) as
// the resolved `name`. It also guarantees a factory runs at most once.
//
// Internal (deliberately not a JSDoc block: it must stay out of the generated API docs).
export function _resolveStorage(
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
