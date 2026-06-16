import type { Signer } from '../ports/signer.js';
import { computeRecordHash, GENESIS_HASH, type LedgerRecord } from './record.js';

export type IntegrityIssueKind =
  | 'genesis_mismatch' // the first record does not chain from GENESIS_HASH
  | 'chain_break' // a record's prevHash does not match the previous record's hash
  | 'seq_gap' // sequence numbers are not contiguous and increasing
  | 'hash_mismatch' // a record's stored hash does not match its recomputed hash
  | 'signature_invalid'; // a record's signature does not verify

export interface IntegrityIssue {
  readonly seq: number;
  readonly kind: IntegrityIssueKind;
  readonly detail: string;
}

export interface IntegrityReport {
  /** True only if there are zero issues. */
  readonly ok: boolean;
  /** Number of records examined. */
  readonly checked: number;
  /** Hash of the last record (the chain head), or null if empty. */
  readonly head: string | null;
  readonly issues: readonly IntegrityIssue[];
}

export interface VerifyOptions {
  /** If provided, signatures present on records are verified against this signer. */
  readonly signer?: Signer;
}

/**
 * Verify the integrity of an ordered list of ledger records. Detects four
 * classes of tampering:
 *
 *  1. Mutating a record's content (recomputed hash no longer matches stored hash).
 *  2. Re-hashing a mutated record without rewriting its successors (the next
 *     record's prevHash no longer links).
 *  3. Inserting or deleting records (sequence gaps).
 *  4. Forging records when signing is enabled (signature fails to verify).
 *
 * A fully-rewritten unsigned chain is internally consistent by construction; to
 * detect that, compare the returned `head` against an externally anchored value
 * (see the roadmap on external anchoring). Verification continues past the first
 * issue and chains from each record's *stored* hash, so a single tampered record
 * is localized rather than cascading into every successor.
 */
export function verifyChain(
  records: readonly LedgerRecord[],
  options: VerifyOptions = {},
): IntegrityReport {
  const issues: IntegrityIssue[] = [];
  let prevHash = GENESIS_HASH;
  let expectedSeq = 1;

  for (const record of records) {
    if (record.seq !== expectedSeq) {
      issues.push({
        seq: record.seq,
        kind: 'seq_gap',
        detail: `expected seq ${expectedSeq}, found ${record.seq}`,
      });
      expectedSeq = record.seq; // resync to keep checking downstream links
    }

    if (record.prevHash !== prevHash) {
      issues.push({
        seq: record.seq,
        kind: expectedSeq === 1 ? 'genesis_mismatch' : 'chain_break',
        detail: `prevHash ${record.prevHash} does not link to ${prevHash}`,
      });
    }

    const recomputed = computeRecordHash(record);
    if (recomputed !== record.hash) {
      issues.push({
        seq: record.seq,
        kind: 'hash_mismatch',
        detail: `stored hash ${record.hash} does not match recomputed ${recomputed}`,
      });
    }

    if (options.signer) {
      if (record.signature === undefined) {
        // A signer is configured but this record is unsigned — treat as forgery,
        // not as an accepted record.
        issues.push({
          seq: record.seq,
          kind: 'signature_invalid',
          detail: 'record has no signature but a signer is configured',
        });
      } else if (!options.signer.verify(record.hash, record.signature)) {
        issues.push({
          seq: record.seq,
          kind: 'signature_invalid',
          detail: `signature does not verify for key ${record.signerKeyId ?? 'unknown'}`,
        });
      }
    }

    prevHash = record.hash;
    expectedSeq += 1;
  }

  const last = records.length > 0 ? records[records.length - 1] : undefined;
  return {
    ok: issues.length === 0,
    checked: records.length,
    head: last ? last.hash : null,
    issues,
  };
}
