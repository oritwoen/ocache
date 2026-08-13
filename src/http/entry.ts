// The storage codec, both directions: live `Response` → stored `ResponseCacheEntry`
// (`serializeResponse`) and back on a hit (`deserializeEntry`). One file because the two
// halves must agree on the body encoding, the null-body statuses and which headers survive.

import { hash } from "ohash";

import type { HandlerConfig } from "./config.ts";
import { isCacheableStatus } from "./validate.ts";
import { appendVary, hasUnkeyedVary, hasVaryWildcard } from "./vary.ts";

import type { CacheEntry, HTTPEvent, ResponseCacheEntry } from "../types.ts";

// Stripped: body is stored fully decoded/re-buffered, none still describe it. `content-range`
// included though 206 never reaches storage — a proxying handler can copy it onto a 200.
const transportHeaders = [
  "content-encoding",
  "content-length",
  "content-range",
  "transfer-encoding",
];

// `Response` throws on non-null body for these — read path only (storage already rejects
// via `validate.ts`). Stored as `""`; MISS caller is served regardless of `validate`.
const nullBodyStatuses = new Set([204, 205, 304]);

// Runs once per resolution (dedup callers share it), so the body is read exactly once. Takes
// the whole entry: lifetimes below are what `cache.ts` already resolved onto it (finding 10.2).
export async function serializeResponse<E extends HTTPEvent>(
  config: HandlerConfig<E>,
  entry: CacheEntry<Response>,
): Promise<ResponseCacheEntry> {
  const { opts, varyHeaderNames } = config;
  const res = entry.value as Response;

  // Valid UTF-8 → stored as string (stable etags); else base64 + flagged, so binary survives
  // a JSON storage backend. Discriminated by byte validity, not the spoofable content-type.
  const bytes = new Uint8Array(await res.arrayBuffer());
  const text = decodeUtf8(bytes);
  const base64 = text === undefined;
  const body = base64 ? bytesToBase64(bytes) : text;

  // Copied, never mutated in place: a `Response` from `fetch()`, `Response.redirect()` or
  // `Response.error()` carries the spec's *immutable* header guard, so the first `set` below
  // threw — taking the whole resolution down and evicting the entry, on every request. A
  // reverse proxy over `fetch()` and cacheable `Response.redirect(…, 301)` are both exactly
  // that shape. Nothing reads `res.headers` after this point, so the copy is otherwise a no-op.
  const headers = new Headers(res.headers);

  if (!headers.has("etag")) {
    headers.set("etag", `W/"${hash(body)}"`);
  }

  if (!headers.has("last-modified")) {
    headers.set("last-modified", new Date().toUTCString());
  }

  // Mirrors `validate`'s predicates (can't drift — an unstored 500 once shipped `s-maxage=60`),
  // closing findings 08/13's gap for `Vary`-only responses. Opt-out: `sendCacheControl` (issue #49).
  // Raw `Vary` here vs. merged in `validate`: same verdict, since `appendVary` only adds keyed names.
  const declaredVary = headers.get("vary");
  if (
    opts.sendCacheControl !== false &&
    isCacheableStatus(res.status) &&
    !hasVaryWildcard(declaredVary) &&
    !hasUnkeyedVary(declaredVary, varyHeaderNames) &&
    !headers.has("cache-control")
  ) {
    // Same precedence `cache.ts` uses for freshness/TTL (finding 10.2): `opts` alone advertised
    // the static lifetime while a dynamic one was enforced; `http/index.ts` always wraps `getMaxAge`.
    const maxAge = entry.maxAge ?? opts.maxAge;
    const staleMaxAge = entry.staleMaxAge ?? opts.staleMaxAge;

    const cacheControl = [];
    // Treated identically with/without `swr` — present (`0` included) is advertised, so
    // `validate` reads a zero the same from a synthesized header as a hand-written one.
    if (maxAge != null) {
      // `max-age` accompanies `s-maxage`, never replaced by it (finding 10.3, RFC 9111 §5.2.2.10):
      // alone, private caches fall back to heuristic freshness ≈ 0 and revalidate every navigation.
      // Not folded away: `s-maxage` alone authorizes storing an `Authorization`-carrying response (§3.5).
      cacheControl.push(`max-age=${maxAge}`);
      if (opts.swr) {
        cacheControl.push(`s-maxage=${maxAge}`);
      }
    }
    // No delta-seconds ⇒ invalid per RFC 5861 §3; a bare token here was previously ignored
    // wholesale (RFC 9111 §5.2.3, finding 10.4). Nothing replaces it — the window is unbounded,
    // and inventing a number would overclaim it.
    if (opts.swr && staleMaxAge != null) {
      cacheControl.push(`stale-while-revalidate=${staleMaxAge}`);
    }
    if (cacheControl.length > 0) {
      headers.set("cache-control", cacheControl.join(", "));
    }
  }

  // `varyHeaderNames`, not the key list: `allowCookies` keys a hashed cookie subset, but
  // `Vary` can only state header names.
  if (varyHeaderNames.length > 0) {
    appendVary(headers, varyHeaderNames);
  }

  // Always stripped, allowlisted or not (issue #61: minted cookies leak to coalesced/later
  // callers). Exempting `allowCookies` reopened this as session fixation (h3#1524 finding #15c).
  headers.delete("set-cookie");

  // Deleted here, not just excluded above — a stale value would desync headers from the
  // re-buffered body (nitro#2109); runtime recomputes `content-length` on read.
  for (const header of transportHeaders) {
    headers.delete(header);
  }

  const cacheEntry: ResponseCacheEntry = {
    status: res.status,
    statusText: res.statusText,
    headers: Object.fromEntries(headers.entries()),
    body,
    // Only set for binary bodies — text entries stay flag-free, byte-identical to
    // pre-binary-support ones.
    ...(base64 && { base64: true }),
  };

  return cacheEntry;
}

/**
 * The read half: a stored entry → the pieces its `Response` is rebuilt from (pieces, because
 * the construction itself is the caller's `createResponse` hook). Mirrors
 * {@link serializeResponse}: a null-body status is forced back to `null` (`""` is not nullish
 * and `new Response("", { status: 204 })` throws), and a `base64` entry decodes to raw bytes.
 */
export function deserializeEntry(entry: ResponseCacheEntry): {
  body: string | Uint8Array | null;
  init: ResponseInit;
} {
  const body = nullBodyStatuses.has(entry.status)
    ? null
    : entry.base64 && typeof entry.body === "string"
      ? base64ToBytes(entry.body)
      : (entry.body ?? null);
  return {
    body,
    init: {
      status: entry.status,
      statusText: entry.statusText,
      headers: entry.headers,
    },
  };
}

// Fatal: throws on invalid UTF-8 (→ base64) instead of substituting replacement chars.
// `ignoreBOM` preserves a leading BOM so decode→encode round-trips byte-for-byte.
const utf8Decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

/** Decodes bytes as UTF-8, returning `undefined` when they aren't valid UTF-8 (i.e. binary). */
function decodeUtf8(bytes: Uint8Array): string | undefined {
  try {
    return utf8Decoder.decode(bytes);
  } catch {
    return undefined;
  }
}

/** Encodes raw bytes to a base64 string (chunked to stay within `String.fromCharCode` arg limits). */
function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const CHUNK = 0x80_00;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

/** Decodes a base64 string produced by {@link bytesToBase64} back to raw bytes. */
function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}
