import { asJson, canonicalize, GENESIS_HASH, applyQuery, type LedgerRecord } from '@veritrail/core';
import type { EventQuery, EventStore } from '@veritrail/core';
import {
  conflictError,
  err,
  ok,
  storageError,
  type Result,
  type VeritrailError,
} from '@veritrail/core';

import { migrationStatements } from './schema.js';
import type { SqlConnection, SqlDatabase, SqlDialect, SqlRow, SqlValue } from './sql.js';

export interface RelationalEventStoreOptions {
  readonly dialect: SqlDialect;
  readonly migrate?: boolean;
}

function asRecord(row: SqlRow): LedgerRecord {
  const raw = row.record_json;
  if (typeof raw !== 'string') {
    throw storageError('relational event row is missing record_json');
  }
  return JSON.parse(raw) as LedgerRecord;
}

function sqlValue(value: unknown): SqlValue {
  if (typeof value === 'string' || typeof value === 'number' || value === null) return value;
  throw storageError('unsupported SQL value type');
}

function orderBySeq(rows: readonly SqlRow[]): LedgerRecord[] {
  return rows.map(asRecord).sort((a, b) => a.seq - b.seq);
}

function conflict(
  message: string,
  details?: Record<string, SqlValue>,
): Result<never, VeritrailError> {
  return err(conflictError(message, details));
}

function storage(message: string, cause: unknown): Result<never, VeritrailError> {
  return err(storageError(message, cause));
}

function appendColumns(record: LedgerRecord): readonly SqlValue[] {
  return [
    record.seq,
    record.id,
    record.timestamp,
    record.prevHash,
    record.hash,
    record.signature ?? null,
    record.signerKeyId ?? null,
    record.event.type,
    record.event.actorId,
    record.event.correlationId ?? null,
    canonicalize(asJson(record)),
  ];
}

function eventTypes(values: readonly string[] | undefined): readonly string[] | undefined {
  return values === undefined || values.length > 0 ? values : ['__veritrail_no_event_types__'];
}

export class RelationalEventStore implements EventStore {
  readonly #db: SqlDatabase;
  readonly #dialect: SqlDialect;

  private constructor(db: SqlDatabase, dialect: SqlDialect) {
    this.#db = db;
    this.#dialect = dialect;
  }

  static async open(
    db: SqlDatabase,
    options: RelationalEventStoreOptions,
  ): Promise<RelationalEventStore> {
    const migrate = options.migrate ?? true;
    if (migrate) {
      for (const statement of migrationStatements(options.dialect)) {
        await db.execute(statement);
      }
    }
    return new RelationalEventStore(db, options.dialect);
  }

  async append(record: LedgerRecord): Promise<Result<LedgerRecord, VeritrailError>> {
    try {
      return await this.#db.transaction(async (tx) => {
        const head = await this.#head(tx);
        const expectedSeq = head ? head.seq + 1 : 1;
        const expectedPrevHash = head ? head.hash : GENESIS_HASH;

        if (record.seq !== expectedSeq) {
          return conflict(
            `append out of sequence: expected seq ${expectedSeq}, got ${record.seq}`,
            {
              expectedSeq,
              gotSeq: record.seq,
            },
          );
        }
        if (record.prevHash !== expectedPrevHash) {
          return conflict(`append prevHash mismatch at seq ${record.seq}`, {
            expectedPrevHash,
            gotPrevHash: record.prevHash,
          });
        }

        const placeholders = appendColumns(record).map((_, i) => this.#dialect.placeholder(i + 1));
        try {
          await tx.execute({
            text: `
              INSERT INTO veritrail_events (
                seq, id, timestamp, prev_hash, hash, signature, signer_key_id,
                event_type, actor_id, correlation_id, record_json
              )
              VALUES (${placeholders.join(', ')})
            `,
            values: appendColumns(record),
          });
        } catch (cause) {
          if (this.#dialect.isConflict(cause)) {
            return conflict(`append conflict at seq ${record.seq}`, { seq: record.seq });
          }
          return storage('failed to insert relational ledger record', cause);
        }

        return ok(record);
      });
    } catch (cause) {
      return storage('failed to append relational ledger record', cause);
    }
  }

  async head(): Promise<LedgerRecord | null> {
    return this.#head(this.#db);
  }

  async getBySeq(seq: number): Promise<LedgerRecord | null> {
    const result = await this.#db.execute({
      text: `SELECT record_json FROM veritrail_events WHERE seq = ${this.#dialect.placeholder(1)}`,
      values: [seq],
    });
    const row = result.rows[0];
    return row === undefined ? null : asRecord(row);
  }

  async readAll(): Promise<LedgerRecord[]> {
    const result = await this.#db.execute({
      text: 'SELECT record_json FROM veritrail_events ORDER BY seq ASC',
    });
    return orderBySeq(result.rows);
  }

  async query(query: EventQuery): Promise<LedgerRecord[]> {
    const values: SqlValue[] = [];
    const clauses: string[] = [];
    const add = (value: SqlValue): string => {
      values.push(value);
      return this.#dialect.placeholder(values.length);
    };

    if (query.fromSeq !== undefined) clauses.push(`seq >= ${add(query.fromSeq)}`);
    if (query.toSeq !== undefined) clauses.push(`seq <= ${add(query.toSeq)}`);
    const types = eventTypes(query.types);
    if (types !== undefined) {
      const placeholders = types.map((type) => add(type));
      clauses.push(`event_type IN (${placeholders.join(', ')})`);
    }
    if (query.actorId !== undefined) clauses.push(`actor_id = ${add(query.actorId)}`);
    if (query.correlationId !== undefined) {
      clauses.push(`correlation_id = ${add(query.correlationId)}`);
    }

    const where = clauses.length === 0 ? '' : `WHERE ${clauses.join(' AND ')}`;
    const limit =
      query.limit === undefined || query.labels !== undefined
        ? ''
        : `LIMIT ${add(Math.max(0, query.limit))}`;
    const result = await this.#db.execute({
      text: `SELECT record_json FROM veritrail_events ${where} ORDER BY seq ASC ${limit}`,
      values,
    });
    const records = orderBySeq(result.rows);
    return query.labels === undefined ? records : applyQuery(records, query);
  }

  async count(): Promise<number> {
    const result = await this.#db.execute({
      text: 'SELECT COUNT(*) AS count FROM veritrail_events',
    });
    const count = result.rows[0]?.count;
    return typeof count === 'number' ? count : Number(sqlValue(count ?? 0));
  }

  async #head(db: SqlConnection): Promise<LedgerRecord | null> {
    const result = await db.execute({
      text: 'SELECT record_json FROM veritrail_events ORDER BY seq DESC LIMIT 1',
    });
    const row = result.rows[0];
    return row === undefined ? null : asRecord(row);
  }
}

export async function createRelationalEventStore(
  db: SqlDatabase,
  options: RelationalEventStoreOptions,
): Promise<RelationalEventStore> {
  return RelationalEventStore.open(db, options);
}
