import { createHash } from 'node:crypto';

import { canonicalize, type JsonValue } from './canonical.js';

/** SHA-256 of a UTF-8 string, hex-encoded. */
export function sha256Hex(data: string): string {
  return createHash('sha256').update(data, 'utf8').digest('hex');
}

/** SHA-256 over the canonical form of a JSON value, hex-encoded. */
export function hashJson(value: JsonValue): string {
  return sha256Hex(canonicalize(value));
}

/** The hash that precedes the first record in a chain (no predecessor). */
export const GENESIS_HASH = '0'.repeat(64);

/** A hash is a 64-character lowercase hex string. */
export function isHash(value: string): boolean {
  return /^[0-9a-f]{64}$/.test(value);
}
