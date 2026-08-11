// Everything decided from the incoming request: whether it is cached at all, and what the
// handler may see of it (`narrowRequest` runs exactly when `shouldBypassCache` says no). One
// rule, shared with `key.ts`: a handler may read exactly what the key covers — otherwise it
// renders content from an input that never reaches the key. Filters live in `filters.ts`.

import type { HandlerConfig } from "./config.ts";
import { authHeaderNames } from "./config.ts";
import { filterCookie, filteredSearch } from "./filters.ts";
import { cacheableMethods } from "./key.ts";

import type { HTTPEvent } from "../types.ts";

// The built-in bypass (a caller's `shouldBypassCache` composes on top, never replaces it),
// shared by the option and the resolver so narrowing can't disagree with it. Derived from
// `cacheableMethods` rather than repeating the method check. `Range` bypasses too: it is
// neither in the key nor a `Vary` dimension, so one `curl -r 0-0` stored a one-byte body that
// every later `Range`-less GET was served — `validate` refusing 206 is the other half.
export function shouldBypassCache(event: HTTPEvent): boolean {
  return !cacheableMethods.includes(event.req.method) || event.req.headers.has("range");
}

// Narrows the request the handler sees, for cacheable requests only (a bypassed one is never
// keyed, so it must reach the handler untouched — including the body, which the rewritten
// `Request` drops). MUTATES the caller's event and never restores it: a handler's body
// producer can run *after* the resolver returns, and handing it back the credentialed request
// would re-open what narrowing closes. Narrowing a copy instead is tracked separately.
export function narrowRequest<E extends HTTPEvent>(
  config: HandlerConfig<E>,
  event: HTTPEvent,
): void {
  const { keyHeaderNames, allowedCookieNames, allowedQueryNames } = config;

  // Strip the credential headers and the cookies the handler didn't opt into. Everything
  // else — the `varies` headers included — is forwarded as-is: those values are in the key,
  // so reading them is safe and is the point of declaring them.
  const filteredHeaders = [...event.req.headers.entries()].flatMap(([key, value]) => {
    const name = key.toLowerCase();
    // Absent from `keyHeaderNames` the credential can't vary the key, so the handler must
    // not see it. The *key* list, never the `Vary` advertisement.
    if (authHeaderNames.includes(name) && !keyHeaderNames.includes(name)) {
      return [];
    }
    if (name !== "cookie") {
      return [[key, value] as [string, string]];
    }
    // Same rule, three-way because cookies have a finer form: `allowCookies` → the
    // allowlisted subset the key hashes; else `cookie` in `keyHeaderNames` (i.e.
    // `varies: ["cookie"]`) → the raw header, which *is* the key component, at one entry per
    // distinct value; else stripped (the secure default: not keyed, not visible).
    if (!allowedCookieNames) {
      return keyHeaderNames.includes("cookie") ? [[key, value] as [string, string]] : [];
    }
    const cookie = filterCookie(value, allowedCookieNames);
    return cookie ? [["cookie", cookie] as [string, string]] : [];
  });

  // Narrow the query to the allowlist, so the handler can't depend on params outside the
  // cache key (mirrors the header filtering above).
  let _reqUrl = event.req.url;
  if (allowedQueryNames) {
    const _url = event.url ?? new URL(event.req.url);
    const _filteredUrl = new URL(_url);
    _filteredUrl.search = filteredSearch(config, event, _url);
    _reqUrl = _filteredUrl.href;
  }

  try {
    const originalReq = event.req;
    (event as any).req = new Request(_reqUrl, {
      method: event.req.method,
      headers: filteredHeaders,
    });
    // Inherit runtime context
    if ((originalReq as any).runtime) {
      (event.req as any).runtime = (originalReq as any).runtime;
    }
    // Inherit the runtime's background-task hook, *bound* to the original request (srvx and
    // Cloudflare implement it against that receiver). `cache.ts` reads it after this swap, so
    // dropping it makes every background write inert on the runtimes that provide it.
    if (typeof originalReq.waitUntil === "function") {
      event.req.waitUntil = originalReq.waitUntil.bind(originalReq);
    }
    if (allowedQueryNames && event.url) {
      (event as any).url = new URL(_reqUrl);
    }
  } catch (error) {
    console.error("[cache] Failed to filter request:", error);
  }
}
