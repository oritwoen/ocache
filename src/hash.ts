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
//
// This runs per request (three or more `hash` calls in `http/key.ts` alone) and per cached call,
// so the walk below is written for it: no closure is allocated per `serialize`, primitives never
// reach the object path, and members are concatenated rather than mapped into a throwaway array.

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
  // A string needs neither the walk nor the cycle map only an object can require — and a string
  // is what most calls carry (every `http/key.ts` component, the body etag).
  // Visit order, not depth: `#<n>` is only ever read back inside the value that is still being
  // built (a true cycle), since the entry is replaced by the finished rendering below.
  return typeof input === "string" ? `'${input}'` : ser(input, new Map<object, string>());
}

function ser(value: unknown, seen: Map<object, string>): string {
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
      const serialized = serObject(value, seen);
      seen.set(value, serialized);
      return serialized;
    }
    default: {
      return String(value);
    }
  }
}

function serObject(value: object, seen: Map<object, string>): string {
  if (Array.isArray(value)) {
    let items = "";
    for (let index = 0; index < value.length; index++) {
      items += index === 0 ? ser(value[index], seen) : `,${ser(value[index], seen)}`;
    }
    return `[${items}]`;
  }
  const ctor = (value as { constructor?: { name?: string } }).constructor;
  // A plain object (or a null-prototype one) carries no tag; anything else is tagged with its
  // class, so two shapes that happen to share entries stay distinct. Checked by constructor
  // identity first, ahead of the `instanceof` chain no plain object can match, because plain
  // objects (call args, option bags) are what this is asked for.
  if (ctor === Object || ctor === undefined) {
    return serProperties("", value, seen);
  }
  if (value instanceof Date) {
    // An invalid date throws on `toISOString()`; every one of them is the same value here.
    return `Date(${Number.isNaN(value.getTime()) ? "null" : value.toISOString()})`;
  }
  if (value instanceof RegExp || value instanceof URL || value instanceof Error) {
    return `${value.constructor.name}(${value})`;
  }
  if (value instanceof Set) {
    const parts: string[] = [];
    for (const item of value) {
      parts.push(ser(item, seen));
    }
    return `Set[${parts.sort().join(",")}]`;
  }
  if (value instanceof Map) {
    // Sorted on the rendered `key:value` pair rather than the key alone, which gives a `Map`
    // keyed by objects a total order for free (its keys need not be strings, or comparable).
    const parts: string[] = [];
    for (const [key, item] of value) {
      parts.push(`${typeof key === "string" ? key : ser(key, seen)}:${ser(item, seen)}`);
    }
    return `Map{${parts.sort().join(",")}}`;
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
  return serProperties(ctor.name || "", value, seen);
}

// Own enumerable properties miss whatever a class keeps in private fields or getters; a
// `toJSON` is the value's own answer to "what am I", so it wins where one exists.
function serProperties(tag: string, value: object, seen: Map<object, string>): string {
  const toJSON = (value as { toJSON?: unknown }).toJSON;
  if (typeof toJSON === "function") {
    return `${tag}(${ser(toJSON.call(value), seen)})`;
  }
  // Keys, not rendered pairs: object keys are unique, so sorting them is already a total order.
  // Bare `sort()` is code-unit order on strings by definition (never `localeCompare`) — the sort
  // decides the hash, so it may not depend on the process locale: the same key must resolve on
  // every machine reading one shared backend.
  const keys = Object.keys(value).sort();
  let parts = "";
  for (let index = 0; index < keys.length; index++) {
    const key = keys[index]!;
    parts += index === 0 ? `${key}:` : `,${key}:`;
    parts += ser((value as Record<string, unknown>)[key], seen);
  }
  return `${tag}{${parts}}`;
}
