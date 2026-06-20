import type { ZodError } from 'zod';

import { EventInputSchema, type EventInput } from '../domain/event.js';
import { systemClock, type Clock } from '../ports/clock.js';
import { DefaultIdGenerator, type IdGenerator } from '../ports/id.js';
import { noopLogger, type Logger } from '../ports/logger.js';
import type { Signer } from '../ports/signer.js';
import type { EventRedactor } from '../redaction/index.js';
import type { EventQuery, EventStore } from '../storage/event-store.js';
import type { JsonValue } from '../util/canonical.js';
import { storageError, validationError, type VeritrailError } from '../util/errors.js';
import { Mutex } from '../util/mutex.js';
import { err, ok, type Result } from '../util/result.js';
import { verifyChain, type IntegrityReport } from './integrity.js';
import { computeRecordHash, GENESIS_HASH, type LedgerRecord } from './record.js';

/** Read-only view of the ledger. Modules that only project should depend on this. */
export interface LedgerReader {
  query(query?: EventQuery): Promise<LedgerRecord[]>;
  readAll(): Promise<LedgerRecord[]>;
  getBySeq(seq: number): Promise<LedgerRecord | null>;
  head(): Promise<LedgerRecord | null>;
  count(): Promise<number>;
  verify(): Promise<IntegrityReport>;
  replay<S>(reducer: (state: S, record: LedgerRecord) => S, initial: S): Promise<S>;
}

/** Write side of the ledger. */
export interface LedgerWriter {
  append(input: unknown): Promise<Result<LedgerRecord, VeritrailError>>;
  /** Append many events as one contiguous, single-flush batch (see ADR-0006). */
  appendMany(inputs: readonly unknown[]): Promise<Result<LedgerRecord, VeritrailError>[]>;
}

export interface LedgerOptions {
  store: EventStore;
  clock?: Clock;
  ids?: IdGenerator;
  /** Optional signer; when present, every record is signed and signatures are verified. */
  signer?: Signer;
  /** Optional append-boundary event redactor. Runs before hashing/signing/persistence. */
  redactor?: EventRedactor;
  logger?: Logger;
}

function zodIssues(error: ZodError): JsonValue {
  return error.issues.map((issue) => ({
    path: issue.path.map((segment) => String(segment)).join('.'),
    code: issue.code,
    message: issue.message,
  }));
}

/**
 * The Ledger is the single system of record. It validates every event, assigns a
 * monotonic sequence and authoritative timestamp, chains it to the previous
 * record by hash, optionally signs it, and persists it through an `EventStore`.
 * Appends are serialized so the chain is always linear and gap-free.
 */
export class Ledger implements LedgerReader, LedgerWriter {
  readonly #store: EventStore;
  readonly #clock: Clock;
  readonly #ids: IdGenerator;
  readonly #signer: Signer | undefined;
  readonly #redactor: EventRedactor | undefined;
  readonly #logger: Logger;
  readonly #mutex = new Mutex();

  constructor(options: LedgerOptions) {
    this.#store = options.store;
    this.#clock = options.clock ?? systemClock;
    this.#ids = options.ids ?? new DefaultIdGenerator(this.#clock);
    this.#signer = options.signer;
    this.#redactor = options.redactor;
    this.#logger = options.logger ?? noopLogger;
  }

  async append(input: unknown): Promise<Result<LedgerRecord, VeritrailError>> {
    const prepared = this.#prepareEvent(input);
    if (!prepared.ok) return prepared;
    const event = prepared.value;

    return this.#mutex.run(async () => {
      const head = await this.#store.head();
      const seq = head ? head.seq + 1 : 1;
      const prevHash = head ? head.hash : GENESIS_HASH;
      const built = await this.#buildRecord(event, seq, prevHash);
      if (!built.ok) return built;

      const appended = await this.#store.append(built.value);
      if (!appended.ok) {
        this.#logger.warn('ledger.append.conflict', { seq, type: event.type });
        return appended;
      }
      this.#logger.debug('ledger.append', { seq, type: event.type, hash: built.value.hash });
      return ok(built.value);
    });
  }

  /**
   * Append many events as one contiguous run, coalescing the durability barrier
   * into a single store round-trip (see ADR-0006). Each input is validated and
   * redacted independently; an input that fails is reported at its position and
   * excluded from the committed batch, while the remaining valid inputs commit
   * together. Returns one {@link Result} per input position, in order.
   */
  async appendMany(inputs: readonly unknown[]): Promise<Result<LedgerRecord, VeritrailError>[]> {
    const results: Result<LedgerRecord, VeritrailError>[] = new Array(inputs.length);
    const pending: Array<{ index: number; event: EventInput }> = [];
    inputs.forEach((input, index) => {
      const prepared = this.#prepareEvent(input);
      if (prepared.ok) pending.push({ index, event: prepared.value });
      else results[index] = prepared;
    });
    if (pending.length === 0) return results;

    await this.#mutex.run(async () => {
      const head = await this.#store.head();
      let seq = head ? head.seq + 1 : 1;
      let prevHash = head ? head.hash : GENESIS_HASH;

      const built: LedgerRecord[] = [];
      const builtIndices: number[] = [];
      for (const { index, event } of pending) {
        const record = await this.#buildRecord(event, seq, prevHash);
        if (!record.ok) {
          // A signing failure aborts the batch from this point; everything
          // already chained is dropped (nothing persisted yet) and reported.
          results[index] = record;
          break;
        }
        built.push(record.value);
        builtIndices.push(index);
        seq = record.value.seq + 1;
        prevHash = record.value.hash;
      }
      if (built.length === 0) return;

      const persisted = await this.#persistBatch(built);
      built.forEach((record, i) => {
        results[builtIndices[i]!] = persisted.ok ? ok(record) : persisted;
      });
      if (persisted.ok) {
        this.#logger.debug('ledger.appendMany', { count: built.length, head: prevHash });
      } else {
        this.#logger.warn('ledger.appendMany.failed', { count: built.length });
      }
    });

    return results;
  }

  /** Validate and (if configured) redact an input into a committable event. */
  #prepareEvent(input: unknown): Result<EventInput, VeritrailError> {
    const parsed = EventInputSchema.safeParse(input);
    if (!parsed.success) {
      return err(validationError('event failed validation', { issues: zodIssues(parsed.error) }));
    }
    let event = parsed.data;
    if (this.#redactor) {
      try {
        event = this.#redactor.redact(event);
      } catch (cause) {
        this.#logger.warn('ledger.append.redaction_failed', { type: event.type });
        return err(storageError('failed to redact ledger event', cause));
      }
      const redacted = EventInputSchema.safeParse(event);
      if (!redacted.success) {
        return err(
          validationError('redacted event failed validation', {
            issues: zodIssues(redacted.error),
          }),
        );
      }
      event = redacted.data;
    }
    return ok(event);
  }

  /** Assign hash/signature for an event at a given chain position. */
  async #buildRecord(
    event: EventInput,
    seq: number,
    prevHash: string,
  ): Promise<Result<LedgerRecord, VeritrailError>> {
    const timestamp = this.#clock.now();
    const id = this.#ids.next('evt');
    const unhashed = { seq, id, timestamp, event, prevHash };
    const hash = computeRecordHash(unhashed);
    let signature: string | undefined;
    let signerKeyId: string | undefined;
    if (this.#signer) {
      try {
        signature = await this.#signer.sign(hash);
        signerKeyId = this.#signer.keyId;
      } catch (cause) {
        this.#logger.warn('ledger.append.sign_failed', { seq, type: event.type });
        return err(storageError('failed to sign ledger record', cause));
      }
    }
    return ok({
      ...unhashed,
      hash,
      ...(signature !== undefined ? { signature } : {}),
      ...(signerKeyId !== undefined ? { signerKeyId } : {}),
    });
  }

  /** Persist a pre-chained run via the store's batch path, or sequentially. */
  async #persistBatch(records: LedgerRecord[]): Promise<Result<LedgerRecord[], VeritrailError>> {
    if (this.#store.appendBatch) {
      return this.#store.appendBatch(records);
    }
    for (const record of records) {
      const appended = await this.#store.append(record);
      if (!appended.ok) return appended;
    }
    return ok(records);
  }

  async query(query: EventQuery = {}): Promise<LedgerRecord[]> {
    return this.#store.query(query);
  }

  async readAll(): Promise<LedgerRecord[]> {
    return this.#store.readAll();
  }

  async getBySeq(seq: number): Promise<LedgerRecord | null> {
    return this.#store.getBySeq(seq);
  }

  async head(): Promise<LedgerRecord | null> {
    return this.#store.head();
  }

  async count(): Promise<number> {
    return this.#store.count();
  }

  async verify(): Promise<IntegrityReport> {
    const all = await this.#store.readAll();
    return this.verifyRecords(all);
  }

  /**
   * Verify an already-read record snapshot with this ledger's verifier
   * configuration. Use this when a projection must aggregate and verify the
   * same immutable read snapshot rather than performing a second store read.
   */
  verifyRecords(records: readonly LedgerRecord[]): IntegrityReport {
    return verifyChain(records, this.#signer ? { signer: this.#signer } : {});
  }

  async replay<S>(reducer: (state: S, record: LedgerRecord) => S, initial: S): Promise<S> {
    const all = await this.#store.readAll();
    let state = initial;
    for (const record of all) {
      state = reducer(state, record);
    }
    return state;
  }
}
