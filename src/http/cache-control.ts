// `Cache-Control`: the RFC 9111 directive syntax and the two questions ocache asks of it.
// Syntax only, no policy — storage is `validate.ts`'s decision and the stale window is the
// `getMaxAge` hook's, and a header parser is testable without an event or a cache.

/**
 * Whether a `Cache-Control` value forbids reusing the response from a shared cache:
 * `no-store`, `private` (the qualified `private="field"` form too — we replay headers
 * verbatim), `no-cache` (see the TODO below), or a zero shared lifetime. The last is
 * `s-maxage` whenever it parses, else `max-age` (RFC 9111 §5.2.2.10), never the first zero of
 * either — that refused the canonical `public, max-age=0, s-maxage=600` "store me" idiom.
 * `must-revalidate` is absent on purpose: it constrains stale serving, not storage.
 */
export function cacheControlForbidsReuse(cacheControl: unknown): boolean {
  if (typeof cacheControl !== "string" || !cacheControl) {
    return false;
  }
  // Lifetimes are collected, not decided, inside the loop: the verdict depends on which
  // directives are present *together*. The unconditional bans still short-circuit. A repeated
  // directive keeps its first parseable value, so the result doesn't depend on loop position.
  let maxAge: number | undefined;
  let sMaxAge: number | undefined;
  for (const [name, value] of cacheControlDirectives(cacheControl)) {
    switch (name) {
      case "no-store":
      case "private": {
        return true;
      }
      // TODO: RFC 9111 §5.2.2.4 permits storing a `no-cache` response if every reuse
      // revalidates first — real new machinery (ocache has no foreground-revalidation path
      // at all), and worth nothing until it exists. Rejecting is the honest interim.
      case "no-cache": {
        return true;
      }
      case "max-age": {
        maxAge ??= deltaSeconds(value);
        break;
      }
      case "s-maxage": {
        sMaxAge ??= deltaSeconds(value);
        break;
      }
    }
  }
  // The shared-cache lifetime: `s-maxage` when it says anything at all, `max-age` otherwise.
  const shared = sMaxAge ?? maxAge;
  return shared !== undefined && shared <= 0;
}

/**
 * Whether a `Cache-Control` value requires revalidation before a *stale* response is reused
 * (`must-revalidate`). Not a storage opt-out — see the `getMaxAge` hook.
 */
export function requiresRevalidation(cacheControl: unknown): boolean {
  if (typeof cacheControl !== "string" || !cacheControl) {
    return false;
  }
  return cacheControlDirectives(cacheControl).some(([name]) => name === "must-revalidate");
}

/**
 * Splits a `Cache-Control` value into `[name, value]` pairs, lowercasing names and unquoting
 * values. A parser rather than `includes()`/`split(",")`: a value may be a quoted string
 * holding a comma, and substring matching confuses `max-age=0` with `max-age=0600`,
 * `stale-while-revalidate=0` or `x-no-cache`.
 */
function cacheControlDirectives(value: string): Array<[string, string | undefined]> {
  const directives: Array<[string, string | undefined]> = [];
  let token = "";
  let quoted = false;
  const flush = () => {
    const directive = token.trim();
    token = "";
    if (!directive) {
      return;
    }
    const eq = directive.indexOf("=");
    const name = (eq < 0 ? directive : directive.slice(0, eq)).trim().toLowerCase();
    if (!name) {
      return;
    }
    let raw = eq < 0 ? undefined : directive.slice(eq + 1).trim();
    if (raw !== undefined && raw.length >= 2 && raw.startsWith('"') && raw.endsWith('"')) {
      raw = raw.slice(1, -1);
    }
    directives.push([name, raw]);
  };
  for (let i = 0; i < value.length; i++) {
    const char = value[i]!;
    if (quoted) {
      // A quoted-pair escapes the next character, including a closing quote.
      if (char === "\\") {
        token += char + (value[++i] ?? "");
        continue;
      }
      if (char === '"') {
        quoted = false;
      }
      token += char;
      continue;
    }
    if (char === '"') {
      quoted = true;
      token += char;
      continue;
    }
    if (char === ",") {
      flush();
      continue;
    }
    token += char;
  }
  flush();
  return directives;
}

/**
 * Parses a `delta-seconds` value (RFC 9111 §1.2.2: `1*DIGIT`), returning `undefined` for
 * anything else — a malformed directive states nothing we may act on (§5.2). A leading `-` is
 * accepted so the common `max-age=-1` reads as "already expired", and leading zeros are
 * digits, so `max-age=0600` is 600 seconds rather than a zero lifetime.
 */
function deltaSeconds(value: string | undefined): number | undefined {
  if (value === undefined || !/^-?\d+$/.test(value)) {
    return undefined;
  }
  return Number(value);
}
