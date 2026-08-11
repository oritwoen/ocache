// The allowlist filters. `key.ts` hashes what these return and `request.ts` hands it to the
// handler — the directory's one rule, a handler may read exactly what the key covers — so
// neither side may compute "the allowlisted subset" on its own. Here, so neither imports the
// other.

import type { HandlerConfig } from "./config.ts";

import type { HTTPEvent } from "../types.ts";

// The allowlisted query string for this request, memoized on the handler config so the key
// derivation and the URL rewrite don't recompute it.
export function filteredSearch<E extends HTTPEvent>(
  config: HandlerConfig<E>,
  event: HTTPEvent,
  url: URL,
): string {
  let search = config.searchCache.get(event);
  if (search === undefined) {
    search = filterSearch(url, config.allowedQueryNames!);
    config.searchCache.set(event, search);
  }
  return search;
}

/** Rebuilds the query string from only the allowlisted param names, order-independent. */
function filterSearch(url: URL, names: string[]): string {
  const filtered = new URLSearchParams();
  for (const name of names) {
    for (const value of url.searchParams.getAll(name).sort()) {
      filtered.append(name, value);
    }
  }
  const query = filtered.toString();
  return query ? `?${query}` : "";
}

/** Rebuilds the `Cookie` header from only the allowlisted cookie names, sorted (order-independent). */
export function filterCookie(header: string | null | undefined, names: string[]): string {
  if (!header) {
    return "";
  }
  const kept: Array<[string, string]> = [];
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    const name = (eq < 0 ? part : part.slice(0, eq)).trim();
    if (name && names.includes(name)) {
      kept.push([name, eq < 0 ? "" : part.slice(eq + 1).trim()]);
    }
  }
  kept.sort((a, b) =>
    a[0] === b[0] ? (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0) : a[0] < b[0] ? -1 : 1,
  );
  return kept.map(([n, v]) => `${n}=${v}`).join("; ");
}
