import { hash } from "ohash";
import { resolveStorage } from "./storage.ts";

import type { StorageInterface, StorageOption } from "./storage.ts";
import type { HTTPEvent, CacheEntry, CacheOptions, CacheStatus } from "./types.ts";

function defaultCacheOptions() {
  return {
    name: "_",
    base: "/cache",
    swr: false,
    maxAge: 1,
  } as const;
}

/** Default deadline (seconds) on one shared resolution — the resolver plus `getMaxAge` and `serialize`. */
const DEFAULT_MAX_RESOLVE_TIME = 30;

type ResolvedCacheEntry<T> = CacheEntry<T> & { value: T; status: CacheStatus };

export type CachedFunction<T, ArgsT extends unknown[]> = {
  (...args: ArgsT): Promise<T>;
  /** Resolves all storage keys (one per base prefix) for the given arguments. */
  resolveKeys: (...args: ArgsT) => Promise<string[]>;
  /** Invalidates (removes) cached entries for the given arguments across all base prefixes. */
  invalidate: (...args: ArgsT) => Promise<void>;
  /** Marks cached entries as stale across all base prefixes. With SWR, stale values are still served (within `staleMaxAge`) while the next access triggers a background refresh. */
  expire: (...args: ArgsT) => Promise<void>;
};

/**
 * Wraps a function with caching support including TTL, SWR, integrity checks, and request deduplication.
 *
 * @param fn - The function to cache.
 * @param opts - Cache configuration options.
 * @returns A cached function with a `.resolveKey(...args)` method for cache key resolution.
 */
export function defineCachedFunction<T, ArgsT extends unknown[] = any[]>(
  fn: (...args: ArgsT) => T | Promise<T>,
  opts: CacheOptions<T, ArgsT> = {},
): CachedFunction<T, ArgsT> {
  // Resolve `name` from the caller's opts BEFORE merging defaults — see `resolveName`.
  const name = resolveName(opts.name, fn);
  // The caller's own object is the storage memo slot (`resolveStorage`), so the same object handed
  // to `invalidateCache`/`expireCache` reaches this store. The clone below mirrors it.
  const _optsRef = opts;
  // `definedOptions` first: an explicit `undefined` must read as unset, not "override with
  // nothing". Copies, so `_optsRef` stays the caller's own object.
  opts = { ...defaultCacheOptions(), ...definedOptions(opts), name };

  // Resolved on first read/write, never at definition time — a `storage` factory exists for late
  // binding. Unset -> this instance's *own* memory storage, no ambient global to collide on.
  const getStorage = (): StorageInterface => resolveStorage(_optsRef, opts);

  // Shares the storable (post-`serialize`) value + TTL so `getMaxAge`/`serialize` run once. `Map`,
  // never a plain object: `Object.prototype` keys faked in-flight followers, caching `undefined`.
  const pending = new Map<string, Promise<{ value: T; maxAge?: number; staleMaxAge?: number }>>();

  // Normalize cache params
  const group = opts.group || "functions";
  const integrity = opts.integrity || hash([fn, integrityOpts(opts)]);
  const validate = opts.validate || ((entry) => entry.value !== undefined);
  // Seconds, like every other time-valued option here (`maxAge`, `staleMaxAge`, `getMaxAge`'s
  // return, the storage `ttl`) — the conversion to milliseconds happens at the `setTimeout`,
  // which is where `createMemoryStorage` does it too. A finite positive deadline arms the
  // timeout; `Infinity` / `0` / negative disable it — the normalization shape
  // `createMemoryStorage` uses for its own ceilings. Deliberately
  // NOT in `defaultCacheOptions()`: the default must not materialize as a key on `opts`, or
  // every entry written by an earlier ocache would go cold over a knob that says nothing
  // about the cached computation. Setting it explicitly does cost that one integrity change
  // (it stays in `integrityOpts` — it is not a storage-*location* field, and carving out an
  // exception for it would be the first).
  const rawMaxResolveTime = opts.maxResolveTime ?? DEFAULT_MAX_RESOLVE_TIME;
  const maxResolveTime =
    Number.isFinite(rawMaxResolveTime) && rawMaxResolveTime > 0 ? rawMaxResolveTime : undefined;
  const onError = (context: string, error: unknown) => {
    if (opts.onError) {
      opts.onError(error);
    } else {
      console.error(context, error);
    }
  };

  async function get(
    key: string,
    resolver: () => T | Promise<T>,
    args: ArgsT,
    shouldInvalidateCache?: boolean,
    event?: HTTPEvent,
  ): Promise<ResolvedCacheEntry<T>> {
    const validateCtx = { args };
    // Use extension for key to avoid conflicting with parent namespace (foo/bar and foo/bar/baz)
    const bases = normalizeBases(opts.base);

    let entry: CacheEntry<T> = {} as CacheEntry<T>;
    // Index of the base that had a cache hit (-1 = miss on all tiers)
    let hitIndex = -1;
    try {
      // Multi-tier read: try each base prefix in order, use first hit
      for (let i = 0; i < bases.length; i++) {
        const result = (await getStorage().get(
          buildCacheKey(key, { group, name }, bases[i]!),
        )) as CacheEntry<T> | null;
        if (result) {
          entry = result;
          hitIndex = i;
          break;
        }
      }
    } catch (error) {
      onError("[cache] Cache read error.", error);
    }

    // https://github.com/nitrojs/nitro/issues/2160
    if (typeof entry !== "object") {
      entry = {};
      const error = new Error("Malformed data read from cache.");
      onError("[cache]", error);
    } else {
      // Per-call clone: backends may return the entry by reference (memory storage does), so the
      // mutations below must not corrupt stored state nor race concurrent same-key calls.
      entry = { ...entry };
    }

    // Per-entry TTL (set by the `getMaxAge` hook on the previous write) takes precedence over static options.
    const readMaxAge = entry.maxAge ?? opts.maxAge;
    const readStaleMaxAge = entry.staleMaxAge ?? opts.staleMaxAge;

    const ttl = (readMaxAge ?? 0) * 1000;
    if (ttl > 0) {
      entry.expires = Date.now() + ttl;
    }

    const staleTtl =
      opts.swr && readStaleMaxAge != null && readStaleMaxAge >= 0
        ? readStaleMaxAge * 1000
        : undefined;

    // Zero stale window (upstream `must-revalidate`): never serve stale — revalidate in foreground.
    const swr = opts.swr && staleTtl !== 0;

    // When staleMaxAge is set, an entry is completely dead after maxAge + staleMaxAge
    const isFullyExpired =
      staleTtl !== undefined &&
      readMaxAge != null &&
      Date.now() - (entry.mtime || 0) > ttl + staleTtl;

    // Computed once, reused by the `expired` check and the `status` decision below; may be async.
    const _isValid = (await validate(entry, validateCtx)) !== false;

    const expired =
      shouldInvalidateCache ||
      entry.stale === true ||
      entry.integrity !== integrity ||
      readMaxAge === 0 ||
      (ttl > 0 && Date.now() - (entry.mtime || 0) > ttl) ||
      !_isValid;

    // If fully expired beyond staleMaxAge, clear the stale value so SWR won't serve it
    if (isFullyExpired) {
      entry.value = undefined;
      entry.integrity = undefined;
      entry.mtime = undefined;
      entry.expires = undefined;
    }

    // MUST mirror the serve decision below. "revalidated" = a prior value was expired/invalid and
    // re-resolved in the foreground, no stale served.
    const status: CacheStatus =
      entry.value === undefined
        ? "miss"
        : !expired
          ? "hit"
          : swr && _isValid
            ? "stale"
            : "revalidated";

    const resolveEntry = async () => {
      const isPending = pending.has(key);
      if (!isPending) {
        if (entry.value !== undefined && (opts.staleMaxAge || 0) >= 0 && opts.swr === false) {
          // Remove cached entry to prevent using expired cache on concurrent requests
          entry.value = undefined;
          entry.integrity = undefined;
          entry.mtime = undefined;
          entry.expires = undefined;
        }
        // Resolved once and shared with all callers — `serialize` may consume a one-shot stream.
        const resolution = (async () => {
          const value = await resolver();
          // Throwaway entry so the hooks can inspect resolution metadata.
          const resolvedEntry: CacheEntry<T> = { value, mtime: Date.now(), integrity };
          let maxAge: number | undefined;
          let staleMaxAge: number | undefined;
          // Derive per-entry lifetime from the resolved value, overriding static options for this write.
          if (opts.getMaxAge) {
            try {
              const resolved = await opts.getMaxAge(resolvedEntry);
              // A bare number is shorthand for `{ maxAge }`.
              const dynamic = typeof resolved === "number" ? { maxAge: resolved } : resolved;
              // A value <= 0 means "don't cache" (re-resolve every access), never "cache forever".
              maxAge = clampTtl(dynamic?.maxAge);
              staleMaxAge = clampTtl(dynamic?.staleMaxAge);
              resolvedEntry.maxAge = maxAge;
              resolvedEntry.staleMaxAge = staleMaxAge;
            } catch (error) {
              onError("[cache] getMaxAge hook error.", error);
            }
          }
          // Write-side counterpart of `transform`, run after `getMaxAge` so it sees the raw value.
          const stored = opts.serialize ? await opts.serialize(resolvedEntry, validateCtx) : value;
          return { value: stored, maxAge, staleMaxAge };
        })();
        // Bound the shared resolution: a promise that *never settles* was the one leak in an
        // otherwise clean `pending` lifecycle — the slot stayed occupied forever, so one hung
        // upstream took the key down for the whole process. Covers the hooks, not just
        // `resolver()`: `serialize` is where a never-ending body is drained.
        //
        // Rejects the waiters rather than merely dropping the slot: a caller awaiting a
        // resolution nobody will complete is not "served", and since the write block below sits
        // *after* this `await`, rejecting also stops an abandoned resolver settling late from
        // overwriting what a fresh leader has since resolved. Cost: an upstream that would have
        // answered at 31s now fails at 30s — hence the generous default and the `0`/`Infinity`
        // opt-out. The slot is *not* additionally dropped from the timer callback; the promise is
        // guaranteed to settle, and doing so would let this leader's `catch` delete a successor's.
        pending.set(key, maxResolveTime ? withDeadline(resolution, maxResolveTime) : resolution);
      }

      let resolved: { value: T; maxAge?: number; staleMaxAge?: number };
      try {
        resolved = await pending.get(key)!;
      } catch (error) {
        // Make sure entries that reject get removed. A timed-out resolution (see the deadline
        // above) is a rejection in every respect, this eviction included: "the resolution
        // failed" already has exactly one meaning here, and giving the timeout its own
        // softer one would pre-empt the open question of whether evicting on failure is right
        // at all — a question that belongs to every arm of it at once, not to this one.
        if (!isPending) {
          pending.delete(key);
          // Evict stale entry from storage so SWR doesn't keep serving it
          const evictPromise = evictFromStorage(getStorage(), key, bases, group, name).catch(
            (error) => {
              onError("[cache] Cache eviction error.", error);
            },
          );
          event?.req.waitUntil?.(evictPromise);
        }
        // Re-throw error to make sure the caller knows the task failed.
        throw error;
      }

      // Leader and followers see the same storable value, so `transform` deserializes consistently.
      entry.value = resolved.value;

      if (!isPending) {
        // Update mtime, integrity + validate and set the value in cache only the first time the request is made.
        entry.mtime = Date.now();
        entry.integrity = integrity;
        entry.stale = undefined;
        pending.delete(key);
        // Persist the per-entry lifetime derived by `getMaxAge` above, overriding static options for this write.
        if (opts.getMaxAge) {
          entry.maxAge = resolved.maxAge;
          entry.staleMaxAge = resolved.staleMaxAge;
        }
        // See `storageTtl`. Per-entry lifetimes from `getMaxAge` beat static options, as on read.
        const setOpts = storageTtl(
          entry.maxAge ?? opts.maxAge,
          entry.staleMaxAge ?? opts.staleMaxAge,
          opts.swr,
        );
        if ((await validate(entry, validateCtx)) !== false && setOpts !== false) {
          // Multi-tier write: no hit -> all tiers; tier N matched -> tiers 0..N (promote upward).
          const writeBases = hitIndex < 0 ? bases : bases.slice(0, hitIndex + 1);
          // `status` is a per-call field — never persist it to storage.
          const { status: _status, ...toStore } = entry;
          const promise = (async () => {
            try {
              await Promise.all(
                writeBases.map((b) =>
                  getStorage().set(buildCacheKey(key, { group, name }, b), toStore, setOpts),
                ),
              );
            } catch (error) {
              onError("[cache] Cache write error.", error);
            }
          })();
          event?.req.waitUntil?.(promise);
        } else if (hitIndex >= 0) {
          // Prior entry, unstorable resolution (`validate` refused, or `storageTtl` -> `false`):
          // evict so SWR stops serving it; also clears entries an older ocache wrote with no TTL.
          const evictPromise = evictFromStorage(getStorage(), key, bases, group, name).catch(
            (error) => {
              onError("[cache] Cache eviction error.", error);
            },
          );
          event?.req.waitUntil?.(evictPromise);
        }
      }
    };

    const _resolvePromise = expired ? resolveEntry() : Promise.resolve();

    if (entry.value === undefined) {
      await _resolvePromise;
    } else if (expired) {
      event?.req.waitUntil?.(_resolvePromise);
    }

    // `entry` is a per-call clone, so no shared-state race; NON-ENUMERABLE anyway so `status` never
    // persists. Attached to the live clone, not a return-time copy, so an SWR refresh landing during
    // the serve path is reflected — which no longer happens for a *sync* resolver, whose shared
    // promise now carries the `maxResolveTime` deadline and settles a tick after the serve path
    // reads it. That was always a tick-count accident (an async resolver never made it), so SWR now
    // serves the stale value for both, which is what SWR means.
    Object.defineProperty(entry, "status", {
      value: status,
      enumerable: false,
      writable: true,
      configurable: true,
    });

    if (swr && (await validate(entry, validateCtx)) !== false) {
      _resolvePromise.catch((error) => {
        onError("[cache] SWR handler error.", error);
      });
      return entry as ResolvedCacheEntry<T>;
    }

    return _resolvePromise.then(() => entry) as Promise<ResolvedCacheEntry<T>>;
  }

  const cachedFn = async (...args: ArgsT) => {
    const shouldBypassCache = await opts.shouldBypassCache?.(...args);
    if (shouldBypassCache) {
      return fn(...args);
    }
    const key = await (opts.getKey || getKey)(...args);
    const shouldInvalidateCache = await opts.shouldInvalidateCache?.(...args);
    const entry = await get(
      key,
      () => fn(...args),
      args,
      shouldInvalidateCache,
      isHTTPEvent(args[0]) ? args[0] : undefined,
    );
    let value = entry.value;
    if (opts.transform) {
      value = (await opts.transform(entry, ...args)) || value;
    }
    return value;
  };

  cachedFn.resolveKeys = (...args: ArgsT) => resolveCacheKeys({ options: opts, args });
  // Resolve before delegating: an unresolved factory here (purge before the first call) lets the
  // helpers resolve a *different* store and silently no-op. `getStorage` memoizes into `opts`.
  cachedFn.invalidate = (...args: ArgsT) => {
    getStorage();
    return invalidateCache({ options: opts, args });
  };
  cachedFn.expire = (...args: ArgsT) => {
    getStorage();
    return expireCache({ options: opts, args });
  };

  return cachedFn;
}

/** Alias for {@link defineCachedFunction}. */
export const cachedFunction = defineCachedFunction;

// --- Public helpers ---

/**
 * Resolves all cache storage keys (one per base prefix) for given arguments and cache options.
 *
 * Uses the same key derivation as `defineCachedFunction` internally:
 * - When `opts.getKey` is provided, it is called with `args` to produce the key segment.
 * - Otherwise, `args` are hashed with `ohash` (same default as `defineCachedFunction`).
 *
 * Pass the same `getKey`, `name`, `group`, and `base` options you use in
 * `defineCachedFunction` / `defineCachedHandler` to get the exact storage keys.
 *
 * @param input - Object with `options` (cache options) and optional `args` (function arguments).
 * @returns An array of storage key strings (one per base prefix).
 *
 * @example
 * ```ts
 * const storage = createMemoryStorage();
 * const fn = cachedFunction(fetchUser, { name: "fetchUser", getKey: (id: string) => id, storage });
 *
 * const keys = await resolveCacheKeys({
 *   options: { name: "fetchUser", getKey: (id: string) => id },
 *   args: ["user-123"],
 * });
 * for (const key of keys) {
 *   await storage.set(key, null); // invalidate all tiers
 * }
 * ```
 */
export async function resolveCacheKeys<ArgsT extends unknown[] = any[]>(
  input: {
    options?: Pick<CacheOptions<any, ArgsT>, "base" | "group" | "name" | "getKey">;
    args?: ArgsT;
  } = {},
): Promise<string[]> {
  const opts = input.options ?? {};
  const args = input.args ?? ([] as unknown as ArgsT);
  const key = await (opts.getKey || getKey)(...args);
  return normalizeBases(opts.base).map((base) => buildCacheKey(key, opts, base));
}

/**
 * Invalidates (removes) cached entries for given arguments and cache options across all base prefixes.
 *
 * Uses the same key derivation as `defineCachedFunction` / `resolveCacheKeys`.
 *
 * Targets `options.storage` — pass the same backend (or, better, the very same options
 * object you cached with, whose resolved storage is memoized on it) the entries were
 * written to. **Throws** if `storage` is unset: there is no global store to fall back on,
 * so the call could only purge a fresh empty one while the stale entry kept being served.
 * A mismatched `name`/`getKey` still purges nothing silently. When the cached function is
 * at hand, prefer its own `.invalidate(...args)`.
 *
 * @param input - Object with `options` (cache options) and optional `args` (function arguments).
 *
 * @example
 * ```ts
 * // Invalidate a specific cached entry
 * await invalidateCache({
 *   options: { name: "fetchUser", getKey: (id: string) => id, storage },
 *   args: ["user-123"],
 * });
 * ```
 */
export async function invalidateCache<ArgsT extends unknown[] = any[]>(
  input: {
    options?: Pick<CacheOptions<any, ArgsT>, "base" | "group" | "name" | "getKey" | "storage">;
    args?: ArgsT;
  } = {},
): Promise<void> {
  const keys = await resolveCacheKeys(input);
  const storage = requireStorage(input.options, "invalidateCache");
  await Promise.all(keys.map((key) => storage.set(key, null)));
}

/**
 * Expires cached entries for given arguments and cache options across all base prefixes,
 * without removing them.
 *
 * Unlike {@link invalidateCache} (which removes entries entirely), expired entries keep
 * serving the stale value with SWR — still bounded by the originally configured
 * `staleMaxAge` window — while the next access triggers a background refresh.
 * Without SWR, the next call re-resolves before returning.
 *
 * Uses the same key derivation as `defineCachedFunction` / `resolveCacheKeys`.
 * Pass the same `maxAge` / `swr` / `staleMaxAge` options you cache with so the
 * remaining storage TTL is preserved.
 *
 * Targets `options.storage` with the same rule as {@link invalidateCache}: **throws** if
 * `storage` is unset, since there is no global store to fall back on.
 *
 * @param input - Object with `options` (cache options) and optional `args` (function arguments).
 *
 * @example
 * ```ts
 * // Mark a cached entry for background refresh on next access
 * await expireCache({
 *   options: { name: "fetchUser", getKey: (id: string) => id, maxAge: 60, staleMaxAge: 300, storage },
 *   args: ["user-123"],
 * });
 * ```
 */
export async function expireCache<ArgsT extends unknown[] = any[]>(
  input: {
    options?: Pick<
      CacheOptions<any, ArgsT>,
      "base" | "group" | "name" | "getKey" | "maxAge" | "swr" | "staleMaxAge" | "storage"
    >;
    args?: ArgsT;
  } = {},
): Promise<void> {
  const opts = input.options ?? {};
  const keys = await resolveCacheKeys(input);
  const storage = requireStorage(opts, "expireCache");
  await Promise.all(
    keys.map(async (key) => {
      const entry = (await storage.get(key)) as CacheEntry | null;
      if (!entry || typeof entry !== "object" || entry.value === undefined) {
        return;
      }
      await storage.set(key, { ...entry, stale: true }, remainingTtl(entry, opts));
    }),
  );
}

// --- Internal helpers ---

// Shared with `defineCachedHandler` so keys can't drift; `//` not JSDoc (docs4ts). MUST precede
// the defaults merge or `name: "_"` wins (issue #53: every handler keyed `_`; shared `storage` ->
// thrash/leak). Anon -> stable source hash; per-instance ids rejected; equal-source fns need one.
export function resolveName(name: string | undefined, fn: (...args: any[]) => any): string {
  return name || fn.name || `anon_${hash(fn).slice(0, 16)}`;
}

// Shared by both defaults merges (here + `resolveHandlerConfig`) so they can't drift: spread copies
// undefined keys, so `{ maxAge: undefined }` clobbered the default and the route silently stopped
// caching (pre-10.6: forever). Idempotent; the handler merges twice. Copies — caller's = memo slot.
export function definedOptions<T extends object>(opts: T): T {
  const cleaned = { ...opts } as Record<string, unknown>;
  for (const key of Object.keys(cleaned)) {
    if (cleaned[key] === undefined) {
      delete cleaned[key];
    }
  }
  return cleaned as T;
}

// The purge helpers are useless without the write-side backend, and per-instance storage has no
// ambient fallback: an unset `storage` resolved a *fresh empty* one — purge no-ops, stale serves.
function requireStorage(
  options: { storage?: StorageOption } | undefined,
  caller: string,
): StorageInterface {
  if (!options?.storage) {
    throw new Error(`[ocache] ${caller}() requires \`options.storage\``);
  }
  return resolveStorage(options);
}

// Rejects with a `TimeoutError` if `work` hasn't settled within `seconds`, so a resolution
// that never settles cannot pin its `pending` slot forever (finding 03 — see the call site
// for why the waiters are rejected rather than merely released). Seconds in, milliseconds
// converted at the timer, exactly as `createMemoryStorage` treats its `ttl`.
//
// `work` is *not* cancelled: there is no cancellation to reach for (the resolver is the
// caller's `fn`, invoked with the caller's arguments, and nothing here has an `AbortSignal`
// to hand it). It keeps running, its hooks may still run, and it may still settle late — but
// only into a promise nobody awaits any more, so a late settle can neither be served nor
// written to storage.
//
// The timer is cleared on *every* settle path, or a long-lived process accumulates one live
// timer per resolution — a rejecting `work` included, which is why the handler is attached as
// `.then(f, f)` and not as a `.finally` (whose returned promise would reject with nothing
// listening) or a lone `.then`. A late settle lands on those same handlers, so it is absorbed
// here rather than surfacing as an unhandled rejection.
//
// Hand-built rather than `Promise.race([...])`, which adopts a promise arm at a cost of two
// further microtask ticks. Ticks are not free here: how quickly a resolution lands on
// `entry.value` decides whether a background refresh is visible to the call it was triggered
// by. One tick is unavoidable and does change that for a *sync* resolver under SWR (see the
// `status` attach below); three would be gratuitous.
function withDeadline<T>(work: Promise<T>, seconds: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      // Reported in the unit the caller configured, never the converted milliseconds.
      const error = new Error(`[cache] Resolver timed out after ${seconds}s.`);
      // The name the platform gives this failure (`AbortSignal.timeout()`), so a caller can
      // tell a deadline apart from a resolver's own error without a class to import.
      error.name = "TimeoutError";
      reject(error);
    }, seconds * 1000);
    // Allow the process to exit even if a deadline is pending (as the memory storage does).
    if (timer && typeof timer === "object" && "unref" in timer) {
      timer.unref();
    }
    work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function isHTTPEvent(input: unknown): input is HTTPEvent {
  return (input as any)?.req instanceof Request;
}

/** Normalizes a dynamic TTL: clamps negatives to 0, treats nullish/non-finite as "unset" (static fallback). */
function clampTtl(value: number | undefined): number | undefined {
  return value == null || !Number.isFinite(value) ? undefined : Math.max(0, value);
}

function getKey(...args: unknown[]) {
  return args.length > 0 ? hash(args) : "";
}

function buildCacheKey(
  key: string,
  opts: Pick<CacheOptions, "group" | "name">,
  base: string,
): string {
  const group = opts.group || "functions";
  // Escaped — `name` is no controlled alphabet once it comes from `fn.name` (see `resolveName`).
  const name = escapeKeySegment(opts.name || "_");
  return [base, group, name, key + ".json"].filter(Boolean).join(":").replace(/:\/$/, ":index");
}

// Non-word chars dropped (lossy), so a changed segment carries a hash of the raw — collisions like
// `a:bc`/`ab:c` stay distinct; identifiers unchanged. Shared with `http/key.ts`; `//` for docs4ts.
export function escapeKeySegment(raw: string): string {
  const escaped = escapeKey(raw);
  return escaped === raw ? escaped : `${escaped.slice(0, 64)}.${hash(raw)}`;
}

// Lossy on purpose — callers composing a `:`-joined key should reach for `escapeKeySegment`.
export function escapeKey(key: string | string[]): string {
  return String(key).replace(/\W/g, "");
}

function normalizeBases(base: CacheOptions["base"]): [string, ...string[]] {
  if (Array.isArray(base)) return base as [string, ...string[]];
  return [base ?? "/cache"];
}

async function evictFromStorage(
  storage: StorageInterface,
  key: string,
  bases: string[],
  group: string,
  name: string,
) {
  await Promise.all(bases.map((b) => storage.set(buildCacheKey(key, { group, name }, b), null)));
}

// Never persist an entry with neither expiry nor storage TTL (finding 10.6). One helper, so this
// and `remainingTtl` can't drift. `{ swr, maxAge }` = expiry, no TTL: ISR, bounded by backend
// capacity (14.1); 14.3 (TTL=maxAge) rejected, kills SWR. `!swr` not `=== false`: `expireCache`.
function storageTtl(
  maxAge: number | undefined,
  staleMaxAge: number | undefined,
  swr: boolean | undefined,
): { ttl: number } | undefined | false {
  if (maxAge == null || maxAge <= 0) {
    return false;
  }
  if (!swr) {
    return { ttl: maxAge };
  }
  // A TTL must cover the whole window the entry may still be served in; no stale window named (or a
  // negative one, which states none) -> no TTL armed, the ISR shape above.
  return staleMaxAge != null && staleMaxAge >= 0 ? { ttl: maxAge + staleMaxAge } : undefined;
}

/** Computes remaining storage TTL (seconds) so expiring an entry doesn't extend its original lifetime. */
function remainingTtl(
  entry: CacheEntry,
  opts: Pick<CacheOptions, "maxAge" | "swr" | "staleMaxAge">,
): { ttl: number } | undefined {
  // Same decision as the write path, so expiring can't extend a lifetime, strip a TTL, or arm one
  // the write withheld (deleting the ISR entry when it goes stale). Per-entry beats static.
  const ttlOpts = storageTtl(
    entry.maxAge ?? opts.maxAge,
    entry.staleMaxAge ?? opts.staleMaxAge,
    opts.swr,
  );
  if (!entry.mtime || !ttlOpts) {
    return undefined;
  }
  return { ttl: Math.max(Math.ceil((entry.mtime + ttlOpts.ttl * 1000 - Date.now()) / 1000), 1) };
}

/**
 * Strips storage-location fields from opts so integrity only reflects the cached computation.
 *
 * `storage` belongs in that set for the same reason as `base`/`group`/`name`: it says
 * *where* entries live, not what they contain, so pointing an instance at a different
 * backend must not invalidate the entries already there. Hashing it would also be
 * meaningless and expensive — ohash walks a storage object's methods as source text, so
 * two `createMemoryStorage()` instances hash identically (including different `maxSize`,
 * a closure variable) while a factory vs. a ready instance hash differently: an integrity
 * change on a purely cosmetic config edit.
 */
function integrityOpts(
  opts: CacheOptions<any, any>,
): Omit<CacheOptions, "base" | "group" | "name" | "storage"> {
  const { base: _, group: _g, name: _n, storage: _s, ...rest } = opts;
  return rest;
}
