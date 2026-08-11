// The `validate` hook: may this response be stored, and may a lifetime be advertised for it?
// Both answers live here so the storage decision and `entry.ts`'s advertisement read the
// *same* predicates — their drift is the defect this module exists to prevent. Header syntax
// is parsed in `cache-control.ts`; the read path's null-body statuses are `entry.ts`'s.

import { cacheControlForbidsReuse } from "./cache-control.ts";
import { hasVaryWildcard } from "./vary.ts";

import type { HTTPEvent, CachedEventHandlerOptions, ResponseCacheEntry } from "../types.ts";

// The statuses ocache stores, and identically the only ones it advertises a lifetime for. An
// allowlist because "not obviously bad" isn't "a complete, reusable representation of what was
// requested": 200/203 are that representation, 301/308 the resource's stable identity. The
// rest are per-request answers (302/303/307 bounced an authenticated user to someone else's
// login redirect; 206 is a partial body), operation outcomes (201/202/300), empty (204/205/304
// — a stored 304 was replayed to *unconditional* requests) or errors.
const cacheableStatuses = new Set([200, 203, 301, 308]);

// The single source of truth on the status axis, read by `validateEntry` (storage) and by
// `serializeResponse` (advertisement) so the two cannot disagree. Not the only axis `validate`
// rejects on — see the synthesis gate for how the others are covered, or deliberately not.
export function isCacheableStatus(status: number): boolean {
  return cacheableStatuses.has(status);
}

// Whether a `ResponseCacheEntry` may be stored (on write, right after `serialize`) and
// served (on read, as persisted).
export async function validateEntry<E extends HTTPEvent>(
  opts: CachedEventHandlerOptions<E>,
  value: ResponseCacheEntry | undefined,
): Promise<boolean> {
  if (!value) {
    return false;
  }
  // Explicit response-side opt-outs: `no-store`/`private`/`no-cache`, a zero shared
  // lifetime, or `Vary: *`.
  if (forbidsSharedCaching(value.headers)) {
    return false;
  }
  // Defense in depth for entries this version didn't write (an older ocache kept allowlisted
  // cookies — h3#1524 finding #15c — or another writer shares the storage): reject *any*
  // stored Set-Cookie rather than replay it to strangers. `serialize`'s strip is the real guard.
  if (value.headers?.["set-cookie"]) {
    return false;
  }
  // The one status gate, shared with the advertisement — see `cacheableStatuses`. Applying it
  // on read too means an entry written by an older, more permissive ocache heals on access.
  if (!isCacheableStatus(value.status)) {
    return false;
  }
  // Only a *missing* body is rejected: `""` is a legal zero-byte 200, and the two dangerous
  // empty bodies are covered on their own axis — a HEAD body replayed to GET by the key's
  // method component, a null-body status by the check above.
  if (value.body === undefined) {
    return false;
  }
  if (value.headers.etag === "undefined" || value.headers["last-modified"] === "undefined") {
    return false;
  }
  // Additive user hook: ANDed with the checks above, so it can reject but never force-cache
  // what they reject. A throwing hook fails closed — served, but not stored.
  if (opts.shouldCache) {
    try {
      if ((await opts.shouldCache(value)) === false) {
        return false;
      }
    } catch (error) {
      if (opts.onError) {
        opts.onError(error);
      } else {
        console.error("[cache] shouldCache hook error.", error);
      }
      return false;
    }
  }
  return true;
}

/**
 * Whether a response explicitly forbids being stored in — and reused from — a shared cache.
 * Takes the whole header set because the answer is spelled in two of them: `Cache-Control`
 * (see {@link cacheControlForbidsReuse}) and `Vary: *`, which never matches a stored response
 * (RFC 9111 §4.1), so refusing the entry is the only honest handling. Honoring a `Vary` that
 * names a header outside `varyHeaderNames` is the wider problem, tracked separately.
 */
function forbidsSharedCaching(headers: ResponseCacheEntry["headers"] | undefined): boolean {
  if (!headers) {
    return false;
  }
  const vary = headers.vary;
  if (typeof vary === "string" && hasVaryWildcard(vary)) {
    return true;
  }
  return cacheControlForbidsReuse(headers["cache-control"]);
}
