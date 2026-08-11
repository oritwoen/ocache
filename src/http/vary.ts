// `Vary` mechanics only: merging our advertisement into the handler's, and the two predicates
// that read a response's `Vary` back — `*` and "names a header we don't key on". *Which*
// names get advertised is `config.ts`'s `varyHeaderNames`; acting on either verdict (refuse
// to store, refuse to advertise) is `validate.ts`'s and `entry.ts`'s.

/**
 * Merges `names` into the response's `Vary`, preserving what the handler declared and
 * deduplicating case-insensitively. A `Vary: *` is left untouched — it already varies on
 * everything, and such a response is only ever served to the direct caller, never stored.
 */
export function appendVary(headers: Headers, names: string[]): void {
  const existing = headers.get("vary");
  // A `*` token means the response varies on everything — nothing to add.
  if (hasVaryWildcard(existing)) {
    return;
  }
  const seen = new Set<string>();
  const merged: string[] = [];
  const add = (raw: string) => {
    const name = raw.trim();
    const key = name.toLowerCase();
    if (!name || seen.has(key)) {
      return;
    }
    seen.add(key);
    merged.push(name);
  };
  if (existing) {
    for (const part of existing.split(",")) {
      add(part);
    }
  }
  for (const name of names) {
    add(name);
  }
  headers.set("vary", merged.join(", "));
}

/**
 * Whether a `Vary` value contains the `*` token. Three callers, one expression: `appendVary`
 * (nothing to merge in), `forbidsSharedCaching` (never store) and `serializeResponse`'s
 * synthesis gate (never advertise) — written out twice, the third was simply missing.
 */
export function hasVaryWildcard(value: string | null | undefined): boolean {
  return !!value && value.split(",").some((part) => part.trim() === "*");
}

/**
 * Whether a response's `Vary` names a request header that is not in `keyed` — one ocache
 * cannot tell apart, so a single entry would be served to every value of it. ocache *wrote*
 * `Vary` but never *read* one, so a handler declaring `Vary: Accept-Language` (RFC 9111 §4.1's
 * "not interchangeable") had one rendering replayed to every language with that same `Vary`
 * attached. Both `validate` (never store) and the synthesis gate (never advertise) reject on
 * it; keying on it instead needs a re-key after the handler runs, tracked separately.
 *
 * `keyed` is `HandlerConfig.varyHeaderNames`, the *advertisement* list, not `keyHeaderNames`:
 * they differ only on `cookie`, which `allowCookies` keys as a finer hashed subset, so every
 * name here is in the key in some form and `Vary: Cookie` under `allowCookies` still caches.
 * Already lowercased (`config.ts`), so only this side is normalized. On the storage side the
 * value is our list merged into the handler's ({@link appendVary}), so anything unkeyed came
 * from the handler; the gate sees the raw pre-merge value — same verdict, shorter list.
 *
 * Fails closed: only empty list elements are skipped (RFC 9110 §5.6.1, so a trailing comma is
 * not degenerate) and anything that isn't exactly a keyed name rejects, malformed included.
 * `*` is deliberately left to {@link hasVaryWildcard}, applied alongside at both sites — a
 * different verdict, and folding it in would let a degenerate `varies: ["*"]` key the wildcard.
 */
export function hasUnkeyedVary(value: string | null | undefined, keyed: string[]): boolean {
  return (
    !!value &&
    value.split(",").some((part) => {
      const name = part.trim().toLowerCase();
      return !!name && name !== "*" && !keyed.includes(name);
    })
  );
}
