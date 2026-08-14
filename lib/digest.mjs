// The `default` arm of the `#crypto` subpath import (see package.json `imports`): a portable
// sha256 for every runtime that resolves without the `node` condition — browsers, workers,
// edge bundles. Its counterpart is `./digest.node.mjs`.
//
// Both arms return the same 43 base64url characters for the same input, so a cache key never
// depends on which one a consumer resolved: a persistent backend written by a Node process and
// read by a worker has to agree. `test/hash.test.ts` holds this file against `node:crypto`
// across every message-padding boundary.
//
// Why a JS implementation and not WebCrypto: `crypto.subtle.digest` is async, and `hash()` is
// called synchronously at definition time (`resolveName`, `integrity`) and from plain string
// composition (`escapeKeySegment`). See `.agents/hash.md`.
//
// Plain `.mjs`, shipped as-is rather than built from `src/`: the condition has to be resolved by
// the *consumer's* bundler or runtime, so both arms must exist as real files in the package.

/**
 * @param {string} text
 * @returns {string} sha256 of `text`, base64url, unpadded.
 */
export function digest(text) {
  return base64url(sha256(new TextEncoder().encode(text)));
}

// Round constants: the first 32 bits of the fractional parts of the cube roots of the first 64
// primes (FIPS 180-4 §4.2.2). Verbatim from the spec.
const K = new Uint32Array([
  0x42_8a_2f_98, 0x71_37_44_91, 0xb5_c0_fb_cf, 0xe9_b5_db_a5, 0x39_56_c2_5b, 0x59_f1_11_f1,
  0x92_3f_82_a4, 0xab_1c_5e_d5, 0xd8_07_aa_98, 0x12_83_5b_01, 0x24_31_85_be, 0x55_0c_7d_c3,
  0x72_be_5d_74, 0x80_de_b1_fe, 0x9b_dc_06_a7, 0xc1_9b_f1_74, 0xe4_9b_69_c1, 0xef_be_47_86,
  0x0f_c1_9d_c6, 0x24_0c_a1_cc, 0x2d_e9_2c_6f, 0x4a_74_84_aa, 0x5c_b0_a9_dc, 0x76_f9_88_da,
  0x98_3e_51_52, 0xa8_31_c6_6d, 0xb0_03_27_c8, 0xbf_59_7f_c7, 0xc6_e0_0b_f3, 0xd5_a7_91_47,
  0x06_ca_63_51, 0x14_29_29_67, 0x27_b7_0a_85, 0x2e_1b_21_38, 0x4d_2c_6d_fc, 0x53_38_0d_13,
  0x65_0a_73_54, 0x76_6a_0a_bb, 0x81_c2_c9_2e, 0x92_72_2c_85, 0xa2_bf_e8_a1, 0xa8_1a_66_4b,
  0xc2_4b_8b_70, 0xc7_6c_51_a3, 0xd1_92_e8_19, 0xd6_99_06_24, 0xf4_0e_35_85, 0x10_6a_a0_70,
  0x19_a4_c1_16, 0x1e_37_6c_08, 0x27_48_77_4c, 0x34_b0_bc_b5, 0x39_1c_0c_b3, 0x4e_d8_aa_4a,
  0x5b_9c_ca_4f, 0x68_2e_6f_f3, 0x74_8f_82_ee, 0x78_a5_63_6f, 0x84_c8_78_14, 0x8c_c7_02_08,
  0x90_be_ff_fa, 0xa4_50_6c_eb, 0xbe_f9_a3_f7, 0xc6_71_78_f2,
]);

/**
 * SHA-256 (FIPS 180-4), returning the 32 digest bytes. A straight transcription of §6.2 — the
 * one thing here with no room for a judgement call, since its output is a storage format shared
 * with `node:crypto`.
 *
 * Intermediate sums exceed 32 bits but stay well under `2 ** 53`, so the `| 0` (and the implicit
 * `Uint32Array` coercion) recovers the low 32 bits exactly. The message is padded into one fresh
 * buffer rather than in place: this also hashes response bodies (the etag in `http/entry.ts`),
 * and mutating a caller's bytes is not on the table.
 *
 * @param {Uint8Array} bytes
 * @returns {Uint8Array}
 */
function sha256(bytes) {
  const h = new Uint32Array([
    0x6a_09_e6_67, 0xbb_67_ae_85, 0x3c_6e_f3_72, 0xa5_4f_f5_3a, 0x51_0e_52_7f, 0x9b_05_68_8c,
    0x1f_83_d9_ab, 0x5b_e0_cd_19,
  ]);

  // `1` bit, then zeros, then the 64-bit big-endian *bit* length in the final 8 bytes.
  const padded = new Uint8Array((((bytes.length + 8) >> 6) << 6) + 64);
  padded.set(bytes);
  padded[bytes.length] = 0x80;
  const view = new DataView(padded.buffer);
  const bits = bytes.length * 8;
  view.setUint32(padded.length - 8, Math.floor(bits / 0x1_00_00_00_00));
  view.setUint32(padded.length - 4, bits >>> 0);

  const w = new Uint32Array(64);
  for (let offset = 0; offset < padded.length; offset += 64) {
    for (let t = 0; t < 16; t++) {
      w[t] = view.getUint32(offset + t * 4);
    }
    for (let t = 16; t < 64; t++) {
      const x = w[t - 15];
      const y = w[t - 2];
      const s0 = rotr(x, 7) ^ rotr(x, 18) ^ (x >>> 3);
      const s1 = rotr(y, 17) ^ rotr(y, 19) ^ (y >>> 10);
      w[t] = (w[t - 16] + s0 + w[t - 7] + s1) | 0;
    }

    // The eight working variables of §6.2.2 (`h` is taken by the state array, hence `i`).
    let a = h[0];
    let b = h[1];
    let c = h[2];
    let d = h[3];
    let e = h[4];
    let f = h[5];
    let g = h[6];
    let i = h[7];
    for (let t = 0; t < 64; t++) {
      const s1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const temp1 = (i + s1 + ch + K[t] + w[t]) | 0;
      const s0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      i = g;
      g = f;
      f = e;
      e = (d + temp1) | 0;
      d = c;
      c = b;
      b = a;
      a = (temp1 + s0 + maj) | 0;
    }
    h[0] = h[0] + a;
    h[1] = h[1] + b;
    h[2] = h[2] + c;
    h[3] = h[3] + d;
    h[4] = h[4] + e;
    h[5] = h[5] + f;
    h[6] = h[6] + g;
    h[7] = h[7] + i;
  }

  const out = new Uint8Array(32);
  const outView = new DataView(out.buffer);
  for (let t = 0; t < 8; t++) {
    outView.setUint32(t * 4, h[t]);
  }
  return out;
}

/**
 * @param {number} value
 * @param {number} bits
 * @returns {number}
 */
function rotr(value, bits) {
  return (value >>> bits) | (value << (32 - bits));
}

// `btoa` sits in the same standard-globals family as `TextEncoder` and `Request`/`Response`,
// which ocache already requires of a runtime. Padding is stripped, matching Node's `base64url`.
/**
 * @param {Uint8Array} bytes
 * @returns {string}
 */
function base64url(bytes) {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}
