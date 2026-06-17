import {
  FixedClock,
  GENESIS_HASH,
  Ledger,
  SequentialIdGenerator,
  type LedgerRecord,
} from '@veritrail/core';
import { describe, expect, it } from 'vitest';

import {
  RelationalEventStore,
  sqliteDialect,
  type SqlConnection,
  type SqlResult,
  type SqlStatement,
} from '../src/index.js';

class SqliteConstraintError extends Error {
  readonly code = 'SQLITE_CONSTRAINT_UNIQUE';
}

class FakeSqlDatabase implements SqlConnection {
  readonly records: LedgerRecord[] = [];
  readonly statements: string[] = [];
  beforeInsert: (() => void) | undefined;
  readonly #owner: FakeSqlDatabase;

  constructor(owner?: FakeSqlDatabase) {
    this.#owner = owner ?? this;
  }

  async transaction<T>(fn: (tx: SqlConnection) => Promise<T>): Promise<T> {
    return fn(new FakeSqlDatabase(this.#owner));
  }

  async execute(statement: SqlStatement): Promise<SqlResult> {
    const text = statement.text.replace(/\s+/g, ' ').trim();
    this.#owner.statements.push(text);

    if (text.startsWith('CREATE ') || text.startsWith('INSERT INTO veritrail_schema_version')) {
      return { rows: [] };
    }

    if (text.startsWith('SELECT record_json FROM veritrail_events ORDER BY seq DESC LIMIT 1')) {
      const head = this.#owner.records.at(-1);
      return { rows: head === undefined ? [] : [{ record_json: JSON.stringify(head) }] };
    }

    if (text.startsWith('INSERT INTO veritrail_events')) {
      this.#owner.beforeInsert?.();
      this.#owner.beforeInsert = undefined;
      const values = statement.values ?? [];
      const seq = values[0];
      const id = values[1];
      const hash = values[4];
      const recordJson = values[10];
      if (
        this.#owner.records.some(
          (record) => record.seq === seq || record.id === id || record.hash === hash,
        )
      ) {
        throw new SqliteConstraintError('duplicate ledger record');
      }
      if (typeof recordJson !== 'string') throw new Error('missing record_json');
      this.#owner.records.push(JSON.parse(recordJson) as LedgerRecord);
      this.#owner.records.sort((a, b) => a.seq - b.seq);
      return { rows: [] };
    }

    if (text.startsWith('SELECT record_json FROM veritrail_events WHERE seq = ?')) {
      const seq = statement.values?.[0];
      const record = this.#owner.records.find((candidate) => candidate.seq === seq);
      return { rows: record === undefined ? [] : [{ record_json: JSON.stringify(record) }] };
    }

    if (text.startsWith('SELECT record_json FROM veritrail_events')) {
      return {
        rows: this.#query(statement).map((record) => ({ record_json: JSON.stringify(record) })),
      };
    }

    if (text.startsWith('SELECT COUNT(*) AS count FROM veritrail_events')) {
      return { rows: [{ count: this.#owner.records.length }] };
    }

    throw new Error(`unexpected SQL: ${text}`);
  }

  #query(statement: SqlStatement): LedgerRecord[] {
    let records = [...this.#owner.records];
    const values = statement.values ?? [];
    let cursor = 0;
    const text = statement.text;
    const take = (): unknown => values[cursor++];

    if (text.includes('seq >= ?')) {
      const fromSeq = take();
      if (typeof fromSeq !== 'number') throw new Error('fromSeq must be a number');
      records = records.filter((record) => record.seq >= fromSeq);
    }
    if (text.includes('seq <= ?')) {
      const toSeq = take();
      if (typeof toSeq !== 'number') throw new Error('toSeq must be a number');
      records = records.filter((record) => record.seq <= toSeq);
    }
    if (text.includes('event_type IN')) {
      const match = /event_type IN \(([^)]+)\)/.exec(text);
      const count = match === null ? 0 : match[1]!.split(',').length;
      const types = new Set(Array.from({ length: count }, () => take()));
      records = records.filter((record) => types.has(record.event.type));
    }
    if (text.includes('actor_id = ?')) {
      const actorId = take();
      records = records.filter((record) => record.event.actorId === actorId);
    }
    if (text.includes('correlation_id = ?')) {
      const correlationId = take();
      records = records.filter((record) => record.event.correlationId === correlationId);
    }
    if (text.includes('LIMIT ?')) {
      const limit = Number(values.at(-1));
      records = records.slice(0, limit);
    }
    return records.sort((a, b) => a.seq - b.seq);
  }
}

async function createLedger(db = new FakeSqlDatabase()): Promise<Ledger> {
  const store = await RelationalEventStore.open(db, { dialect: sqliteDialect });
  return new Ledger({
    store,
    clock: new FixedClock(1000),
    ids: new SequentialIdGenerator(),
  });
}

describe('RelationalEventStore', () => {
  it('runs migrations and supports the EventStore read surface', async () => {
    const db = new FakeSqlDatabase();
    const ledger = await createLedger(db);

    await ledger.append({
      type: 'note',
      actorId: 'agent_a',
      correlationId: 'run_1',
      payload: { text: 'one' },
    });
    await ledger.append({
      type: 'note',
      actorId: 'agent_b',
      correlationId: 'run_1',
      payload: { text: 'two' },
    });

    expect(
      db.statements.some((statement) =>
        statement.includes('CREATE TABLE IF NOT EXISTS veritrail_events'),
      ),
    ).toBe(true);
    expect(await ledger.count()).toBe(2);
    expect((await ledger.head())?.seq).toBe(2);
    expect((await ledger.getBySeq(1))?.event.actorId).toBe('agent_a');
    expect(await ledger.query({ actorId: 'agent_a' })).toHaveLength(1);
    expect(await ledger.query({ correlationId: 'run_1', limit: 1 })).toHaveLength(1);
    expect(await ledger.query({ limit: 0 })).toHaveLength(0);
    expect((await ledger.verify()).ok).toBe(true);
  });

  it('enforces append-only sequencing at the relational store layer', async () => {
    const db = new FakeSqlDatabase();
    const ledger = await createLedger(db);
    const first = await ledger.append({ type: 'note', actorId: 'a', payload: { text: 'one' } });
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    const store = await RelationalEventStore.open(db, { dialect: sqliteDialect, migrate: false });
    const replay = await store.append(first.value);

    expect(replay.ok).toBe(false);
    if (!replay.ok) expect(replay.error.code).toBe('CONFLICT');
  });

  it('maps relational uniqueness races to CONFLICT', async () => {
    const db = new FakeSqlDatabase();
    const ledger = await createLedger(db);
    db.beforeInsert = () => {
      db.records.push({
        seq: 1,
        id: 'evt_race',
        timestamp: 999,
        event: { type: 'note', actorId: 'other', labels: {}, payload: { text: 'winner' } },
        prevHash: GENESIS_HASH,
        hash: '1'.repeat(64),
      });
    };

    const result = await ledger.append({ type: 'note', actorId: 'a', payload: { text: 'loser' } });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('CONFLICT');
    expect(await ledger.count()).toBe(1);
  });
});
