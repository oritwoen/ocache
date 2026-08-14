import type { HTTPEvent, CacheConditions, ResponseCacheEntry } from "../types.ts";

export function defaultHandleCacheHeaders(event: HTTPEvent, conditions: CacheConditions): boolean {
  const ifNoneMatch = event.req.headers.get("if-none-match");
  if (ifNoneMatch && conditions.etag && ifNoneMatch === conditions.etag) {
    return true;
  }

  const ifModifiedSince = event.req.headers.get("if-modified-since");
  if (ifModifiedSince && conditions.modifiedTime) {
    if (new Date(ifModifiedSince) >= conditions.modifiedTime) {
      return true;
    }
  }

  return false;
}

/**
 * Returns the cached headers that a 304 response must repeat.
 *
 * `Vary` preserves variant dimensions per RFC 7232 section 4.1.
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
