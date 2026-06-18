import type { EventType } from '../domain/event.js';
import type { LedgerRecord } from '../ledger/record.js';
import type { VeritrailError } from '../util/errors.js';
import type { Result } from '../util/result.js';

/** A read filter over the ledger. All conditions are ANDed. */
export interface EventQuery {
  /** Inclusive lower bound on sequence number. */
  fromSeq?: number;
  /** Inclusive upper bound on sequence number. */
  toSeq?: number;
  /** Restrict to these event types. */
  types?: readonly EventType[];
  /** Restrict to a single actor. */
  actorId?: string;
  /** Restrict to a single correlation (run/incident/trace) id. */
  correlationId?: string;
  /** Restrict to records whose event labels contain these exact key/value pairs. */
  labels?: Readonly<Record<string, string>>;
  /** Cap the number of returned records (applied after filtering, in seq order). */
  limit?: number;
}

/**
 * Persistence port for the append-only ledger. Adapters MUST enforce the
 * append-only invariant: a record may only be appended at `head.seq + 1` with
 * `prevHash === head.hash`; anything else is a `CONFLICT`. This keeps integrity
 * guarantees independent of any single adapter implementation.
 */
export interface EventStore {
  /** Append a record, or fail with CONFLICT/STORAGE. */
  append(record: LedgerRecord): Promise<Result<LedgerRecord, VeritrailError>>;
  /** The last record, or null if the ledger is empty. */
  head(): Promise<LedgerRecord | null>;
  /** The record at a sequence number, or null. */
  getBySeq(seq: number): Promise<LedgerRecord | null>;
  /** All records in sequence order (defensive copy). */
  readAll(): Promise<LedgerRecord[]>;
  /** Records matching a query, in sequence order. */
  query(query: EventQuery): Promise<LedgerRecord[]>;
  /** Total number of records. */
  count(): Promise<number>;
}
