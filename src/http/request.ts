// Everything decided from the incoming request: whether it is cached at all, and what the
// handler may see of it (`narrowRequest` narrows exactly when `resolveBypass` said no —
// it gates itself on that verdict, so the two cannot disagree). One rule, shared with
// `key.ts`: a handler may read exactly what the key covers — otherwise it renders content
// from an input that never reaches the key. Filters live in `filters.ts`.

import type { HandlerConfig } from "./config.ts";
import { authHeaderNames } from "./config.ts";
import { filterCookie, filteredSearch } from "./filters.ts";
import { cacheableMethods } from "./key.ts";

import type { HTTPEvent } from "../types.ts";

// The built-in half of the bypass (a caller's `shouldBypassCache` composes on top in
// `resolveBypass`, never replaces it). Derived from `cacheableMethods` rather than repeating
// the method check, and never consulted alone outside it. `Range` bypasses too: it is
// neither in the key nor a `Vary` dimension, so one `curl -r 0-0` stored a one-byte body that
// every later `Range`-less GET was served — `validate` refusing 206 is the other half.
function shouldBypassCache(event: HTTPEvent): boolean {
  return !cacheableMethods.includes(event.req.method) || event.req.headers.has("range");
}

// The composed verdict: the built-in bypass OR the caller's hook. Composed rather than
// clobbered (assigning the built-in used to discard `opts.shouldBypassCache`, issue #50),
// and evaluated EXACTLY ONCE per call — `cache.ts` awaits this to decide whether to
// short-circuit to the raw resolver, so the answer is memoized on the event for
// `narrowRequest` to read instead of the caller's hook being asked a second time (it may be
// async, expensive or side-effecting). See `config.bypassed` for why the memo lives there.
export async function resolveBypass<E extends HTTPEvent>(
  config: HandlerConfig<E>,
  event: HTTPEvent,
): Promise<boolean> {
  const bypass =
    shouldBypassCache(event) || (await config.opts.shouldBypassCache?.(event as E)) === true;
  config.bypassed.set(event, bypass);
  return bypass;
}

// Narrows the request the handler sees — and NO-OPS on a bypassed call, which is never keyed
// and so must reach the handler untouched, including its body (the rewritten `Request` drops
// it) and its credentials (`shouldBypassCache` is the documented alternative to
// `allowAuthorization`, and stripping there left it serving the anonymous page to every
// authenticated user). The gate reads the *composed* verdict `resolveBypass` memoized, never
// the built-in half alone; the fallback only covers a resolver reached without it, which
// `cache.ts` cannot do.
//
// MUTATES the caller's event and never restores it: a handler's body producer can run *after*
// the resolver returns, and handing it back the credentialed request would re-open what
// narrowing closes. Narrowing a copy instead is tracked separately.
export function narrowRequest<E extends HTTPEvent>(
  config: HandlerConfig<E>,
  event: HTTPEvent,
): void {
  if (config.bypassed.get(event) ?? shouldBypassCache(event)) {
    return;
  }

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
