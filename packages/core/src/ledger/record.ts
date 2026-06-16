import type { EventInput } from '../domain/event.js';
import { asJson, type JsonValue } from '../util/canonical.js';
import { GENESIS_HASH, hashJson } from '../util/hash.js';

export { GENESIS_HASH };

/**
 * A `LedgerRecord` is one immutable link in the chain. The fields covered by the
 * hash (`seq`, `id`, `timestamp`, `event`, `prevHash`) are exactly the unhashed
 * record; `hash` and the optional `signature`/`signerKeyId` are derived and are
 * NOT part of the hashed core (hashing the hash would be circular).
 */
export interface LedgerRecord {
  /** 1-based, contiguous, monotonically increasing sequence number. */
  readonly seq: number;
  /** Unique record id. */
  readonly id: string;
  /** Ledger-assigned receipt time (epoch ms) — the authoritative timestamp. */
  readonly timestamp: number;
  /** The validated event this record commits. */
  readonly event: EventInput;
  /** Hash of the previous record (GENESIS_HASH for the first). */
  readonly prevHash: string;
  /** SHA-256 over the canonical form of the unhashed record. */
  readonly hash: string;
  /** Optional detached signature over `hash`. */
  readonly signature?: string;
  /** Identifier of the key that produced `signature`. */
  readonly signerKeyId?: string;
}

/** The portion of a record that is covered by the hash. */
export interface UnhashedRecord {
  readonly seq: number;
  readonly id: string;
  readonly timestamp: number;
  readonly event: EventInput;
  readonly prevHash: string;
}

/** Build the canonical JSON object that gets hashed. */
export function recordCore(record: UnhashedRecord): JsonValue {
  return {
    seq: record.seq,
    id: record.id,
    timestamp: record.timestamp,
    prevHash: record.prevHash,
    event: asJson(record.event),
  };
}

/** Compute a record's hash from its hashed core. */
export function computeRecordHash(record: UnhashedRecord): string {
  return hashJson(recordCore(record));
}
