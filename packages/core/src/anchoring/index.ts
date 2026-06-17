import { z, type ZodError } from 'zod';

import { IdSchema, TimestampSchema } from '../domain/common.js';
import type { IntegrityReport } from '../ledger/integrity.js';
import type { LedgerReader } from '../ledger/ledger.js';
import type { Clock } from '../ports/clock.js';
import type { IdGenerator } from '../ports/id.js';
import type { JsonValue } from '../util/canonical.js';
import {
  conflictError,
  notFoundError,
  validationError,
  type VeritrailError,
} from '../util/errors.js';
import { err, ok, type Result } from '../util/result.js';

const HashSchema = z.string().regex(/^[0-9a-f]{64}$/, 'hash must be 64 lowercase hex chars');
const SignatureSchema = z.string().min(1).max(8192);

/**
 * A checkpoint published outside the ledger so a wholesale rewrite can be
 * detected later. Anchors are operational checkpoints, not domain facts.
 */
export const AnchorRecordSchema = z
  .object({
    anchorId: IdSchema,
    anchoredAt: TimestampSchema,
    seq: z.number().int().positive().safe(),
    recordId: IdSchema,
    headHash: HashSchema,
    headTimestamp: TimestampSchema,
    signerKeyId: IdSchema.optional(),
    signature: SignatureSchema.optional(),
  })
  .strict();
export type AnchorRecord = z.infer<typeof AnchorRecordSchema>;

/** External checkpoint store. Implementations should be append-only. */
export interface AnchorStore {
  publish(anchor: unknown): Promise<Result<AnchorRecord, VeritrailError>>;
  latest(): Promise<AnchorRecord | null>;
  list(): Promise<AnchorRecord[]>;
}

function zodIssues(error: ZodError): JsonValue {
  return error.issues.map((issue) => ({
    path: issue.path.map((segment) => String(segment)).join('.'),
    code: issue.code,
    message: issue.message,
  }));
}

/** Volatile anchor store for tests and local development. */
export class InMemoryAnchorStore implements AnchorStore {
  readonly #anchors: AnchorRecord[] = [];

  async publish(anchor: unknown): Promise<Result<AnchorRecord, VeritrailError>> {
    const parsed = AnchorRecordSchema.safeParse(anchor);
    if (!parsed.success) {
      return err(validationError('anchor failed validation', { issues: zodIssues(parsed.error) }));
    }
    const record = parsed.data;
    if (this.#anchors.some((existing) => existing.anchorId === record.anchorId)) {
      return err(conflictError(`anchor ${record.anchorId} already exists`));
    }
    this.#anchors.push(record);
    return ok(record);
  }

  async latest(): Promise<AnchorRecord | null> {
    return this.#anchors.at(-1) ?? null;
  }

  async list(): Promise<AnchorRecord[]> {
    return [...this.#anchors];
  }
}

export interface PublishLedgerHeadAnchorOptions {
  readonly ledger: LedgerReader;
  readonly store: AnchorStore;
  readonly clock: Clock;
  readonly ids: IdGenerator;
}

/** Publish the current ledger head as an external checkpoint. */
export async function publishLedgerHeadAnchor(
  options: PublishLedgerHeadAnchorOptions,
): Promise<Result<AnchorRecord, VeritrailError>> {
  const head = await options.ledger.head();
  if (!head) {
    return err(notFoundError('cannot anchor an empty ledger'));
  }

  return options.store.publish({
    anchorId: options.ids.next('anc'),
    anchoredAt: options.clock.now(),
    seq: head.seq,
    recordId: head.id,
    headHash: head.hash,
    headTimestamp: head.timestamp,
    ...(head.signerKeyId !== undefined ? { signerKeyId: head.signerKeyId } : {}),
    ...(head.signature !== undefined ? { signature: head.signature } : {}),
  });
}

export type AnchorVerificationIssueKind =
  | 'chain_invalid'
  | 'anchored_record_missing'
  | 'anchor_hash_mismatch'
  | 'anchor_record_id_mismatch';

export interface AnchorVerificationIssue {
  readonly kind: AnchorVerificationIssueKind;
  readonly detail: string;
  readonly seq?: number;
}

export interface AnchorVerificationReport {
  readonly ok: boolean;
  readonly anchor: AnchorRecord;
  readonly integrity: IntegrityReport;
  readonly currentSeq: number | null;
  readonly currentHeadHash: string | null;
  readonly anchoredRecordHash: string | null;
  readonly issues: readonly AnchorVerificationIssue[];
}

export interface VerifyLedgerAgainstLatestAnchorOptions {
  readonly ledger: LedgerReader;
  readonly store: AnchorStore;
}

/** Verify the ledger is internally valid and still contains the latest anchor. */
export async function verifyLedgerAgainstLatestAnchor(
  options: VerifyLedgerAgainstLatestAnchorOptions,
): Promise<Result<AnchorVerificationReport, VeritrailError>> {
  const anchor = await options.store.latest();
  if (!anchor) {
    return err(notFoundError('no external ledger anchor has been published'));
  }

  const [integrity, anchoredRecord, currentHead] = await Promise.all([
    options.ledger.verify(),
    options.ledger.getBySeq(anchor.seq),
    options.ledger.head(),
  ]);
  const issues: AnchorVerificationIssue[] = [];

  if (!integrity.ok) {
    for (const issue of integrity.issues) {
      issues.push({
        kind: 'chain_invalid',
        seq: issue.seq,
        detail: `${issue.kind}: ${issue.detail}`,
      });
    }
  }

  if (!anchoredRecord) {
    issues.push({
      kind: 'anchored_record_missing',
      seq: anchor.seq,
      detail: `anchor ${anchor.anchorId} references missing ledger seq ${anchor.seq}`,
    });
  } else {
    if (anchoredRecord.hash !== anchor.headHash) {
      issues.push({
        kind: 'anchor_hash_mismatch',
        seq: anchor.seq,
        detail: `anchor head ${anchor.headHash} does not match ledger hash ${anchoredRecord.hash}`,
      });
    }
    if (anchoredRecord.id !== anchor.recordId) {
      issues.push({
        kind: 'anchor_record_id_mismatch',
        seq: anchor.seq,
        detail: `anchor record ${anchor.recordId} does not match ledger record ${anchoredRecord.id}`,
      });
    }
  }

  return ok({
    ok: issues.length === 0,
    anchor,
    integrity,
    currentSeq: currentHead?.seq ?? null,
    currentHeadHash: currentHead?.hash ?? null,
    anchoredRecordHash: anchoredRecord?.hash ?? null,
    issues,
  });
}
