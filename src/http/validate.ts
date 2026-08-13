// The `validate` hook: may this response be stored, and may a lifetime be advertised for it?
// Both answers live here so the storage decision and `entry.ts`'s advertisement read the
// *same* predicates — their drift is the defect this module exists to prevent. Header syntax
// is parsed in `cache-control.ts`; the read path's null-body statuses are `entry.ts`'s.

import { cacheControlForbidsReuse } from "./cache-control.ts";
import { hasUnkeyedVary, hasVaryWildcard } from "./vary.ts";

import type { HandlerConfig } from "./config.ts";
import type { HTTPEvent, ResponseCacheEntry } from "../types.ts";

// Allowlist: complete, reusable representations only. 302/303/307 bounced an authed user to
// someone else's login redirect; 206 is partial; a stored 304 was replayed to *unconditional* GETs.
const cacheableStatuses = new Set([200, 203, 301, 308]);

// Read by `validateEntry` (storage) and `serializeResponse` (advertisement) so the two cannot
// disagree; likewise `hasVaryWildcard`/`hasUnkeyedVary`. `shouldCache` ungated: a CDN may store.
export function isCacheableStatus(status: number): boolean {
  return cacheableStatuses.has(status);
}

// Whether an entry may be stored (on write, right after `serialize`) and served (on read).
export async function validateEntry<E extends HTTPEvent>(
  config: HandlerConfig<E>,
  value: ResponseCacheEntry | undefined,
): Promise<boolean> {
  const { opts, varyHeaderNames } = config;
  if (!value) {
    return false;
  }
  // Explicit opt-outs: `no-store`/`private`/`no-cache`, a zero shared lifetime, or `Vary: *`.
  if (forbidsSharedCaching(value.headers)) {
    return false;
  }
  // Not an opt-out: cacheable, just not keyable per the header it varies on — refuse rather than
  // serve one variant to all. On read too, so an older ocache's entry heals.
  if (hasUnkeyedVary(value.headers?.vary, varyHeaderNames)) {
    return false;
  }
  // Defense in depth for entries we didn't write (h3#1524 #15c, or a shared storage): reject *any*
  // stored Set-Cookie rather than replay it to strangers. `serialize`'s strip is the real guard.
  if (value.headers?.["set-cookie"]) {
    return false;
  }
  // The one status gate, shared with the advertisement. On read too, so older entries heal.
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
  // ANDed with the above: can reject, never force-cache. A throwing hook fails closed.
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
 * (RFC 9111 §4.1), so refusing the entry is the only honest handling. A `Vary` naming a
 * header outside `varyHeaderNames` is refused too, but by `hasUnkeyedVary` in
 * {@link validateEntry}: that response forbids nothing — it is cacheable, we just can't key
 * it — so it is a separate verdict, not another arm of this one.
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
