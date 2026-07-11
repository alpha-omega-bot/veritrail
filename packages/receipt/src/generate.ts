import type { AnchorRecord, LedgerReader, LedgerRecord } from '@veritrail/core';

import type { Receipt, ReceiptChainStep } from './schema.js';

export interface GenerateReceiptOptions {
  /** The ledger to read records from. */
  readonly ledger: LedgerReader;
  /** The anchor we are terminating the chain at. */
  readonly anchor: AnchorRecord;
  /** Sequence number of the target event. Must be <= anchor.seq. */
  readonly seq: number;
  /** Optional project id to stamp on the receipt for downstream routing. */
  readonly projectId?: string;
  /** Optional pointer to where the anchor was published. */
  readonly anchorReference?: string;
  /** Override the ISO timestamp on the receipt (defaults to new Date().toISOString()). */
  readonly issuedAt?: string;
}

/**
 * Build a portable Receipt by reading the target record and every intermediate
 * record up to the anchor. The receipt is independently verifiable — see
 * `verifyReceipt`.
 *
 * Throws if `seq > anchor.seq` (you cannot prove an event the anchor does not
 * yet cover) or if any record in the range is missing (a corrupt ledger).
 */
export async function generateReceipt(options: GenerateReceiptOptions): Promise<Receipt> {
  const { ledger, anchor, seq, projectId, anchorReference } = options;

  if (seq < 1 || !Number.isSafeInteger(seq)) {
    throw new RangeError(`invalid seq ${seq}: must be a positive safe integer`);
  }
  if (seq > anchor.seq) {
    throw new RangeError(
      `cannot generate receipt: event seq ${seq} is beyond anchor seq ${anchor.seq}`,
    );
  }

  const target = await ledger.getBySeq(seq);
  if (!target) {
    throw new Error(`ledger has no record at seq ${seq}`);
  }
  const event = toStep(target);

  const chain: ReceiptChainStep[] = [];
  // chain contains records from seq+1 up to anchor.seq (inclusive)
  for (let s = seq + 1; s <= anchor.seq; s += 1) {
    const record = await ledger.getBySeq(s);
    if (!record) {
      throw new Error(`ledger has no record at seq ${s}; cannot build chain to anchor`);
    }
    chain.push(toStep(record));
  }

  return {
    version: 1,
    ...(projectId !== undefined ? { projectId } : {}),
    issuedAt: options.issuedAt ?? new Date().toISOString(),
    event,
    chain,
    anchor: {
      anchorId: anchor.anchorId,
      anchoredAt: anchor.anchoredAt,
      seq: anchor.seq,
      recordId: anchor.recordId,
      headHash: anchor.headHash,
      headTimestamp: anchor.headTimestamp,
      ...(anchor.signerKeyId !== undefined ? { signerKeyId: anchor.signerKeyId } : {}),
      ...(anchor.signature !== undefined ? { signature: anchor.signature } : {}),
    },
    ...(anchorReference !== undefined ? { anchorReference } : {}),
  };
}

function toStep(record: LedgerRecord): ReceiptChainStep {
  return {
    seq: record.seq,
    id: record.id,
    timestamp: record.timestamp,
    prevHash: record.prevHash,
    hash: record.hash,
    event: record.event,
  };
}
