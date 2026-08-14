// The `node` arm of the `#crypto` subpath import (see package.json `imports`). Anything
// resolving with the `node` condition — Node, Bun, Deno, a server-targeted bundler — gets this
// and never pulls the portable sha256 in `./digest.mjs` into its graph.
//
// A namespace import, not `import { hash } from "node:crypto"`: `crypto.hash` is Node >= 20.12 /
// 21.7 and the node-compat layers lag, and a *named* import of a missing export is a link-time
// SyntaxError — the whole module graph fails before a line runs, rather than falling back.
import crypto from "node:crypto";

/**
 * @param {string} text
 * @returns {string} sha256 of `text`, base64url, unpadded.
 */
export function digest(text) {
  // The one-shot form skips the per-call stream object, and this is one call per cache key.
  return crypto.hash
    ? crypto.hash("sha256", text, "base64url")
    : crypto.createHash("sha256").update(text).digest("base64url");
}
