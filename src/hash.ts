// Cache keys and integrity hashes. `serialize` renders any value as a deterministic string,
// `digest` hashes it — the two halves the rest of the codebase asks of a hash function: a stable
// rendering of function sources and option objects (`integrity`, `anon_<hash>` names) and of
// request-derived strings (`http/key.ts`, the body etag in `http/entry.ts`).
//
// `#crypto` is a *conditional* subpath import (package.json `imports`), not a runtime capability
// check: the `node` condition resolves to `node:crypto`, everything else to a portable sha256
// (`lib/digest.mjs`). Resolving it is the consumer's bundler's job, so a server build never pulls
// the sha256 bytes into its graph and a worker build never sees a `node:` specifier it cannot
// resolve — which a runtime `if` could not deliver, since both arms would have to survive
// bundling. Both arms return identical digests; `lib/digest.mjs` documents why they must.

import { digest } from "#crypto";

/** Serializes `input` and returns the sha256 of it, base64url (alphabet `[A-Za-z0-9_-]`). */
export function hash(input: unknown): string {
  return digest(serialize(input));
}

/**
 * Renders any value as a string that is equal for equal values and, as far as is practical,
 * different for different ones.
 *
 * - Every branch is type-tagged (`'str'`, `1n`, `Set[…]`, `Ctor{…}`), so values of different
 *   types cannot render alike.
 * - Object, `Map` and `Set` members are sorted, so member order is not part of the identity.
 * - A cycle collapses to `#<n>`, the visit order of the object it points back at.
 * - Functions render as their source with line breaks collapsed: identical source hashes
 *   identically across restarts — what makes `anon_<hash>` names and `integrity` usable with a
 *   persistent backend — and reindentation alone does not invalidate every entry. Two functions
 *   with equal source differing only in closed-over variables are therefore indistinguishable;
 *   that caveat is documented on `resolveName` and in the guides.
 */
export function serialize(input: unknown): string {
  // Visit order, not depth: `#<n>` is only ever read back inside the value that is still being
  // built (a true cycle), since the entry is replaced by the finished rendering below.
  const seen = new Map<object, string>();

  function ser(value: unknown): string {
    if (value === null) {
      return "null";
    }
    switch (typeof value) {
      case "string": {
        return `'${value}'`;
      }
      case "bigint": {
        return `${value}n`;
      }
      case "function": {
        return `${value.name}(${value.length})${Function.prototype.toString.call(value).replace(/\s*\n\s*/g, "")}`;
      }
      case "object": {
        const ref = seen.get(value);
        if (ref !== undefined) {
          return ref;
        }
        seen.set(value, `#${seen.size}`);
        const serialized = serObject(value);
        seen.set(value, serialized);
        return serialized;
      }
      // number, boolean, undefined, symbol — `String()` is unambiguous for all four.
      default: {
        return String(value);
      }
    }
  }

  function serObject(value: object): string {
    if (Array.isArray(value)) {
      return `[${value.map((item) => ser(item)).join(",")}]`;
    }
    if (value instanceof Date) {
      // An invalid date throws on `toISOString()`; every one of them is the same value here.
      return `Date(${Number.isNaN(value.getTime()) ? "null" : value.toISOString()})`;
    }
    if (value instanceof RegExp || value instanceof URL || value instanceof Error) {
      return `${value.constructor.name}(${value})`;
    }
    if (value instanceof Set) {
      return `Set[${[...value]
        .map((item) => ser(item))
        .sort(compare)
        .join(",")}]`;
    }
    if (value instanceof Map) {
      return serEntries("Map", [...value]);
    }
    if (value instanceof ArrayBuffer) {
      return `ArrayBuffer[${new Uint8Array(value).join(",")}]`;
    }
    if (ArrayBuffer.isView(value)) {
      // Element values for a typed array, raw bytes for a `DataView` (which has no `join`) —
      // never the typed array's own bytes, whose order is the machine's endianness.
      const items =
        "join" in value
          ? (value as unknown as number[]).join(",")
          : new Uint8Array(value.buffer, value.byteOffset, value.byteLength).join(",");
      return `${value.constructor.name}[${items}]`;
    }
    const ctor = (value as { constructor?: { name?: string } }).constructor;
    // A plain object (or a null-prototype one) carries no tag; anything else is tagged with its
    // class, so two shapes that happen to share entries stay distinct.
    const tag = ctor === Object || ctor === undefined ? "" : ctor.name || "";
    const toJSON = (value as { toJSON?: unknown }).toJSON;
    // Own enumerable properties miss whatever a class keeps in private fields or getters; a
    // `toJSON` is the value's own answer to "what am I", so it wins where one exists.
    if (typeof toJSON === "function") {
      return `${tag}(${ser(toJSON.call(value))})`;
    }
    return serEntries(tag, Object.entries(value));
  }

  // Sorted on the rendered `key:value` pair rather than the key alone: object keys are unique,
  // so the two orders agree there, and a `Map` keyed by objects gets a total order for free.
  function serEntries(tag: string, entries: [unknown, unknown][]): string {
    const parts = entries
      .map(([key, value]) => `${typeof key === "string" ? key : ser(key)}:${ser(value)}`)
      .sort(compare);
    return `${tag}{${parts.join(",")}}`;
  }

  return ser(input);
}

// Code-unit order, never `localeCompare`: the sort decides the hash, so it may not depend on
// the process locale (the same key must resolve on every machine reading one shared backend).
function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
