/**
 * Tiny UUIDv4 / UUIDv5 implementations. We avoid the `uuid` npm package to
 * keep the dependency tree at zero (only TypeScript devDeps).
 */

import { createHash, randomUUID } from "node:crypto";

export function v4(): string {
  // Node 18+ has crypto.randomUUID which is RFC 4122 compliant.
  return randomUUID();
}

/**
 * Name-based UUID (RFC 4122 v5) — SHA-1 of (namespace+name), with fixed bits.
 * Used to make conversationIds deterministic from the first user prompt so
 * AWS Builder ID retains its conversation/context cache.
 */
export function v5(name: string, namespace: string): string {
  const nsBytes = parseUuid(namespace);
  const nameBytes = Buffer.from(name, "utf-8");
  const hash = createHash("sha1");
  hash.update(nsBytes);
  hash.update(nameBytes);
  const digest = hash.digest();
  const bytes = Buffer.alloc(16);
  digest.copy(bytes, 0, 0, 16);
  // Set version (5) in time_hi_and_version.
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  // Set variant (RFC 4122) in clock_seq_hi_and_reserved.
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  return formatUuid(bytes);
}

function parseUuid(s: string): Buffer {
  const hex = s.replace(/-/g, "");
  if (hex.length !== 32) throw new Error(`invalid uuid: ${s}`);
  return Buffer.from(hex, "hex");
}

function formatUuid(b: Buffer): string {
  const hex = b.toString("hex");
  return (
    hex.substring(0, 8) +
    "-" +
    hex.substring(8, 12) +
    "-" +
    hex.substring(12, 16) +
    "-" +
    hex.substring(16, 20) +
    "-" +
    hex.substring(20, 32)
  );
}

export const v4Compat = v4;
export const v5Compat = v5;
// Aliases used by translator code so we can keep API parity with `uuid` lib.
export { v4 as uuidv4, v5 as uuidv5 };
