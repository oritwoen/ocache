// The `#crypto` package condition selects Node or portable SHA-256 at bundle time.
// Both implementations must return identical digests for shared storage.
// Keep serialization allocation-light because cache-key paths call it per request.

import { digest } from "#crypto";

/** Returns a base64url SHA-256 digest of the serialized input. */
export function hash(input: unknown): string {
  return digest(serialize(input));
}

/**
 * Renders values in a deterministic, type-tagged storage format.
 *
 * Object, Map, and Set order does not affect the result.
 * Cycles use visit-order references.
 * Functions use source text, so equal-source closures are indistinguishable.
 */
export function serialize(input: unknown): string {
  // Strings do not need cycle tracking.
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
  // Tag class instances, but keep common plain objects untagged.
  if (ctor === Object || ctor === undefined) {
    return serProperties("", value, seen);
  }
  if (value instanceof Date) {
    // Render all invalid dates identically without calling `toISOString`.
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
    // Sort rendered pairs because Map keys may not be comparable.
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
    // Element values keep typed-array hashes independent of machine endianness.
    const items =
      "join" in value
        ? (value as unknown as number[]).join(",")
        : new Uint8Array(value.buffer, value.byteOffset, value.byteLength).join(",");
    return `${value.constructor.name}[${items}]`;
  }
  return serProperties(ctor.name || "", value, seen);
}

// Prefer `toJSON` because enumerable properties omit private state and getters.
function serProperties(tag: string, value: object, seen: Map<object, string>): string {
  const toJSON = (value as { toJSON?: unknown }).toJSON;
  if (typeof toJSON === "function") {
    return `${tag}(${ser(toJSON.call(value), seen)})`;
  }
  // Use code-unit order; locale-dependent order would change keys across machines.
  const keys = Object.keys(value).sort();
  let parts = "";
  for (let index = 0; index < keys.length; index++) {
    const key = keys[index]!;
    parts += index === 0 ? `${key}:` : `,${key}:`;
    parts += ser((value as Record<string, unknown>)[key], seen);
  }
  return `${tag}{${parts}}`;
}
