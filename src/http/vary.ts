// `Vary` mechanics only: merging our advertisement into the handler's, and the one `Vary: *`
// predicate three decisions read. *Which* names get advertised is `config.ts`'s
// `varyHeaderNames`; refusing to store a `Vary: *` response is `validate.ts`.

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
