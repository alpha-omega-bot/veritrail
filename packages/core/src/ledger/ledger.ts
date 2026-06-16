import type { ZodError } from 'zod';

import { EventInputSchema } from '../domain/event.js';
import { systemClock, type Clock } from '../ports/clock.js';
import { DefaultIdGenerator, type IdGenerator } from '../ports/id.js';
import { noopLogger, type Logger } from '../ports/logger.js';
import type { Signer } from '../ports/signer.js';
import type { EventQuery, EventStore } from '../storage/event-store.js';
import type { JsonValue } from '../util/canonical.js';
import { validationError, type VeritrailError } from '../util/errors.js';
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
}

export interface LedgerOptions {
  store: EventStore;
  clock?: Clock;
  ids?: IdGenerator;
  /** Optional signer; when present, every record is signed and signatures are verified. */
  signer?: Signer;
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
  readonly #logger: Logger;
  readonly #mutex = new Mutex();

  constructor(options: LedgerOptions) {
    this.#store = options.store;
    this.#clock = options.clock ?? systemClock;
    this.#ids = options.ids ?? new DefaultIdGenerator(this.#clock);
    this.#signer = options.signer;
    this.#logger = options.logger ?? noopLogger;
  }

  async append(input: unknown): Promise<Result<LedgerRecord, VeritrailError>> {
    const parsed = EventInputSchema.safeParse(input);
    if (!parsed.success) {
      return err(validationError('event failed validation', { issues: zodIssues(parsed.error) }));
    }
    const event = parsed.data;

    return this.#mutex.run(async () => {
      const head = await this.#store.head();
      const seq = head ? head.seq + 1 : 1;
      const prevHash = head ? head.hash : GENESIS_HASH;
      const timestamp = this.#clock.now();
      const id = this.#ids.next('evt');

      const unhashed = { seq, id, timestamp, event, prevHash };
      const hash = computeRecordHash(unhashed);
      const signature = this.#signer ? this.#signer.sign(hash) : undefined;
      const signerKeyId = this.#signer ? this.#signer.keyId : undefined;

      const record: LedgerRecord = {
        ...unhashed,
        hash,
        ...(signature !== undefined ? { signature } : {}),
        ...(signerKeyId !== undefined ? { signerKeyId } : {}),
      };

      const appended = await this.#store.append(record);
      if (!appended.ok) {
        this.#logger.warn('ledger.append.conflict', { seq, type: event.type });
        return appended;
      }
      this.#logger.debug('ledger.append', { seq, type: event.type, hash });
      return ok(record);
    });
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
    return verifyChain(all, this.#signer ? { signer: this.#signer } : {});
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
