import { GENESIS_HASH, type LedgerRecord } from '../ledger/record.js';
import { conflictError, type VeritrailError } from '../util/errors.js';
import { ok, err, type Result } from '../util/result.js';
import type { EventQuery, EventStore } from './event-store.js';
import { applyQuery } from './query.js';

/**
 * Shared base for array-backed stores. Holds the records in memory and implements
 * every read method plus the append-only invariant check, leaving only the
 * durability concern (if any) to subclasses' `append`.
 */
export abstract class ArrayBackedEventStore implements EventStore {
  protected readonly records: LedgerRecord[] = [];

  /**
   * Detach records at every store boundary so callers can never mutate the
   * append-only in-memory chain through a record returned from an API.
   */
  protected cloneRecord(record: LedgerRecord): LedgerRecord {
    return structuredClone(record);
  }

  protected cloneRecords(records: readonly LedgerRecord[]): LedgerRecord[] {
    return records.map((record) => this.cloneRecord(record));
  }

  abstract append(record: LedgerRecord): Promise<Result<LedgerRecord, VeritrailError>>;

  /** The seq and prevHash a valid next append must carry. */
  protected expectedNext(): { seq: number; prevHash: string } {
    const head = this.records.at(-1);
    return head ? { seq: head.seq + 1, prevHash: head.hash } : { seq: 1, prevHash: GENESIS_HASH };
  }

  /** Enforce append-only sequencing and chain linkage. */
  protected checkAppend(record: LedgerRecord): Result<void, VeritrailError> {
    const { seq, prevHash } = this.expectedNext();
    if (record.seq !== seq) {
      return err(
        conflictError(`append out of sequence: expected seq ${seq}, got ${record.seq}`, {
          expectedSeq: seq,
          gotSeq: record.seq,
        }),
      );
    }
    if (record.prevHash !== prevHash) {
      return err(
        conflictError(`append prevHash mismatch at seq ${record.seq}`, {
          expectedPrevHash: prevHash,
          gotPrevHash: record.prevHash,
        }),
      );
    }
    return ok(undefined);
  }

  /**
   * Validate a contiguous run: the first record chains to the current head and
   * each subsequent record chains to its predecessor. Returns ok only when the
   * whole batch is a valid extension of the chain.
   */
  protected checkBatch(records: readonly LedgerRecord[]): Result<void, VeritrailError> {
    let { seq, prevHash } = this.expectedNext();
    for (const record of records) {
      if (record.seq !== seq) {
        return err(
          conflictError(`batch append out of sequence: expected seq ${seq}, got ${record.seq}`, {
            expectedSeq: seq,
            gotSeq: record.seq,
          }),
        );
      }
      if (record.prevHash !== prevHash) {
        return err(
          conflictError(`batch append prevHash mismatch at seq ${record.seq}`, {
            expectedPrevHash: prevHash,
            gotPrevHash: record.prevHash,
          }),
        );
      }
      seq = record.seq + 1;
      prevHash = record.hash;
    }
    return ok(undefined);
  }

  /**
   * Append a contiguous run atomically into the in-memory array. Subclasses with
   * a durability concern override this to flush once for the whole batch; the
   * default is the volatile commit. An empty batch is a no-op success.
   */
  async appendBatch(
    records: readonly LedgerRecord[],
  ): Promise<Result<LedgerRecord[], VeritrailError>> {
    if (records.length === 0) return ok([]);
    const stored = this.cloneRecords(records);
    const check = this.checkBatch(stored);
    if (!check.ok) return check;
    this.records.push(...stored);
    return ok(this.cloneRecords(stored));
  }

  async head(): Promise<LedgerRecord | null> {
    const head = this.records.at(-1);
    return head === undefined ? null : this.cloneRecord(head);
  }

  async getBySeq(seq: number): Promise<LedgerRecord | null> {
    const record = this.records[seq - 1];
    return record === undefined ? null : this.cloneRecord(record);
  }

  async readAll(): Promise<LedgerRecord[]> {
    return this.cloneRecords(this.records);
  }

  async query(query: EventQuery): Promise<LedgerRecord[]> {
    return this.cloneRecords(applyQuery(this.records, query));
  }

  async count(): Promise<number> {
    return this.records.length;
  }
}
