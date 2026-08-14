// A handler may read only request data that its cache key covers.

import type { HandlerConfig } from "./config.ts";
import { filterCookie, filteredSearch, safeHeaderNames } from "./filters.ts";
import { cacheableMethods } from "./key.ts";

import type { HTTPEvent } from "../types.ts";

// Range requests bypass caching because the key does not cover byte ranges.
function shouldBypassCache(event: HTTPEvent): boolean {
  return !cacheableMethods.includes(event.req.method) || event.req.headers.has("range");
}

// Evaluate the combined bypass rule once because caller hooks may have side effects.
export async function resolveBypass<E extends HTTPEvent>(
  config: HandlerConfig<E>,
  event: HTTPEvent,
): Promise<boolean> {
  const bypass =
    shouldBypassCache(event) || (await config.opts.shouldBypassCache?.(event as E)) === true;
  config.bypassed.set(event, bypass);
  return bypass;
}

// Leave bypassed requests unchanged, including their bodies and credentials.
// Do not restore mutations because a lazy response body may read the narrowed event later.
export function narrowRequest<E extends HTTPEvent>(
  config: HandlerConfig<E>,
  event: HTTPEvent,
): void {
  if (config.bypassed.get(event) ?? shouldBypassCache(event)) {
    return;
  }

  const { keyHeaderNames, allowedCookieNames, allowedQueryNames } = config;

  // Remove every header that is neither keyed nor explicitly safe.
  const filteredHeaders = [...event.req.headers.entries()].flatMap(([key, value]) => {
    const name = key.toLowerCase();
    if (name !== "cookie") {
      return keyHeaderNames.includes(name) || safeHeaderNames.has(name)
        ? [[key, value] as [string, string]]
        : [];
    }
    // Forward the keyed cookie subset, the keyed raw header, or no cookies.
    if (!allowedCookieNames) {
      return keyHeaderNames.includes("cookie") ? [[key, value] as [string, string]] : [];
    }
    const cookie = filterCookie(value, allowedCookieNames);
    return cookie ? [["cookie", cookie] as [string, string]] : [];
  });

  // Remove query values that the key does not cover.
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
    // Preserve adapter runtime context.
    if ((originalReq as any).runtime) {
      (event.req as any).runtime = (originalReq as any).runtime;
    }
    // Bind `waitUntil` because adapters may require the original Request receiver.
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
