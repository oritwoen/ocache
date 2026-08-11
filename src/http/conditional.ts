// Conditional requests: deciding a `304 Not Modified` and building the headers it must carry.
// One exchange, so both sides sit together. The decision is overridable (`handleCacheHeaders`),
// the echo is not — getting it wrong loses a variant dimension at every downstream cache.

import type { HTTPEvent, CacheConditions, ResponseCacheEntry } from "../types.ts";

export function defaultHandleCacheHeaders(event: HTTPEvent, conditions: CacheConditions): boolean {
  // Check if-none-match
  const ifNoneMatch = event.req.headers.get("if-none-match");
  if (ifNoneMatch && conditions.etag && ifNoneMatch === conditions.etag) {
    return true;
  }

  // Check if-modified-since
  const ifModifiedSince = event.req.headers.get("if-modified-since");
  if (ifModifiedSince && conditions.modifiedTime) {
    if (new Date(ifModifiedSince) >= conditions.modifiedTime) {
      return true;
    }
  }

  return false;
}

/**
 * The headers a `304` carries over from the full response it stands in for, or `undefined`.
 * `Vary` above all: a 304 must state the same variant dimensions or a shared cache updates
 * its stored entry having lost them (RFC 7232 §4.1). The cache-status header rides along
 * because a HIT served as a 304 is still a HIT.
 */
export function notModifiedHeaders(
  headers: ResponseCacheEntry["headers"],
  statusHeader: string | undefined,
): Record<string, string> | undefined {
  const notModified: Record<string, string> = {};
  const statusValue = statusHeader ? (headers[statusHeader] as string | undefined) : undefined;
  if (statusValue !== undefined) {
    notModified[statusHeader!] = statusValue;
  }
  const varyValue = headers.vary as string | undefined;
  if (varyValue !== undefined) {
    notModified.vary = varyValue;
  }
  return Object.keys(notModified).length > 0 ? notModified : undefined;
}
