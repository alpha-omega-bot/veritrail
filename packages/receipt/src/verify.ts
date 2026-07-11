import { computeRecordHash } from '@veritrail/core';

import { ReceiptSchema, type Receipt, type ReceiptChainStep } from './schema.js';

export type VerifyFailureKind =
  | 'schema_invalid'
  | 'event_hash_mismatch'
  | 'chain_break'
  | 'chain_hash_mismatch'
  | 'anchor_mismatch'
  | 'anchor_reference_mismatch';

export interface VerifyFailure {
  readonly kind: VerifyFailureKind;
  readonly detail: string;
  readonly seq?: number;
}

export interface VerifyResult {
  readonly ok: boolean;
  readonly failures: readonly VerifyFailure[];
  /** When ok=true: the head hash the receipt proves was anchored. */
  readonly anchoredHeadHash?: string;
}

export interface VerifyOptions {
  /**
   * The trusted anchor reference fetched independently of the receipt (e.g.
   * from Sigstore/Rekor, an L1 blockchain, or an object store). The receipt's
   * embedded anchor must match this — otherwise the receipt is meaningless
   * because the issuer chose its own anchor.
   *
   * If omitted, the receipt is checked for internal consistency only and
   * `ok=true` only certifies that the receipt is well-formed and the chain
   * recomputes correctly — NOT that the anchor was actually published.
   */
  readonly trustedAnchorHeadHash?: string;
}

/**
 * Verify a receipt entirely offline. Returns `{ ok: true }` only when:
 *
 *   1. The receipt parses against its schema.
 *   2. The event's `hash` recomputes from its declared core fields.
 *   3. Every chain step's `hash` recomputes from its core fields.
 *   4. Each step's `prevHash` equals the previous step's `hash` (chain
 *      unbroken; first step's prevHash equals the event's hash).
 *   5. The last hash in the chain (or the event's hash if the chain is empty)
 *      equals the anchor's headHash.
 *   6. If `trustedAnchorHeadHash` is supplied, it equals the anchor's headHash.
 */
export function verifyReceipt(receiptInput: unknown, options: VerifyOptions = {}): VerifyResult {
  const parsed = ReceiptSchema.safeParse(receiptInput);
  if (!parsed.success) {
    return {
      ok: false,
      failures: [{ kind: 'schema_invalid', detail: parsed.error.message }],
    };
  }
  const receipt: Receipt = parsed.data;
  const failures: VerifyFailure[] = [];

  // 1. Event hash recomputes.
  const eventHash = computeStepHash(receipt.event);
  if (eventHash !== receipt.event.hash) {
    failures.push({
      kind: 'event_hash_mismatch',
      seq: receipt.event.seq,
      detail: `event hash ${receipt.event.hash} does not match recomputed hash ${eventHash}`,
    });
    // continue verifying so we surface all failures
  }

  // 2. Each chain step hashes correctly and links to the previous step.
  let priorHash = receipt.event.hash;
  let priorSeq = receipt.event.seq;
  for (const step of receipt.chain) {
    if (step.seq !== priorSeq + 1) {
      failures.push({
        kind: 'chain_break',
        seq: step.seq,
        detail: `chain step seq ${step.seq} does not follow seq ${priorSeq}`,
      });
    }
    if (step.prevHash !== priorHash) {
      failures.push({
        kind: 'chain_break',
        seq: step.seq,
        detail: `step prevHash ${step.prevHash} does not match prior hash ${priorHash}`,
      });
    }
    const stepHash = computeStepHash(step);
    if (stepHash !== step.hash) {
      failures.push({
        kind: 'chain_hash_mismatch',
        seq: step.seq,
        detail: `step hash ${step.hash} does not match recomputed hash ${stepHash}`,
      });
    }
    priorHash = step.hash;
    priorSeq = step.seq;
  }

  // 3. Final hash terminates at the anchor.
  if (priorHash !== receipt.anchor.headHash) {
    failures.push({
      kind: 'anchor_mismatch',
      detail: `chain terminates at ${priorHash} but anchor head is ${receipt.anchor.headHash}`,
    });
  }
  if (priorSeq !== receipt.anchor.seq) {
    failures.push({
      kind: 'anchor_mismatch',
      detail: `chain terminates at seq ${priorSeq} but anchor seq is ${receipt.anchor.seq}`,
    });
  }

  // 4. Trusted anchor reference (if supplied) matches.
  if (
    options.trustedAnchorHeadHash !== undefined &&
    options.trustedAnchorHeadHash !== receipt.anchor.headHash
  ) {
    failures.push({
      kind: 'anchor_reference_mismatch',
      detail: `trusted anchor ${options.trustedAnchorHeadHash} differs from receipt anchor ${receipt.anchor.headHash}`,
    });
  }

  if (failures.length === 0) {
    return { ok: true, failures: [], anchoredHeadHash: receipt.anchor.headHash };
  }
  return { ok: false, failures };
}

function computeStepHash(step: ReceiptChainStep): string {
  return computeRecordHash({
    seq: step.seq,
    id: step.id,
    timestamp: step.timestamp,
    prevHash: step.prevHash,
    // Cast: schema declares event as unknown to keep receipts schema-agnostic
    // across event-shape evolution. `computeRecordHash` canonicalizes whatever
    // is here, so the verifier-side typing doesn't need to match the source.
    event: step.event as never,
  });
}
