import {
  createInMemoryLedger,
  FixedClock,
  SequentialIdGenerator,
  noopLogger,
  isOk,
  type Ledger,
  type LedgerRecord,
  type ModuleContext,
} from '@veritrail/core';
import { describe, it, expect } from 'vitest';

import { createAuditModule, AuditModule } from '../src/index.js';

const START = 1_700_000_000_000;

function makeContext(): { ctx: ModuleContext; ledger: Ledger; clock: FixedClock } {
  const clock = new FixedClock(START);
  const ledger = createInMemoryLedger({ clock, ids: new SequentialIdGenerator() });
  const ctx: ModuleContext = {
    ledger,
    clock,
    ids: new SequentialIdGenerator(),
    logger: noopLogger,
  };
  return { ctx, ledger, clock };
}

async function appendNote(
  ledger: Ledger,
  actorId: string,
  text: string,
  correlationId?: string,
): Promise<LedgerRecord> {
  const result = await ledger.append({
    type: 'note',
    actorId,
    ...(correlationId !== undefined ? { correlationId } : {}),
    payload: { text },
  });
  if (!isOk(result)) {
    throw new Error(`append failed: ${result.error.message}`);
  }
  return result.value;
}

describe('AuditModule', () => {
  it('exposes module info with the audit capability', () => {
    const { ctx } = makeContext();
    const audit = createAuditModule(ctx);
    expect(audit).toBeInstanceOf(AuditModule);
    expect(audit.info).toEqual({
      name: '@veritrail/audit',
      version: '0.1.0',
      capability: 'audit',
    });
  });

  describe('summary', () => {
    it('reports zeroed bounds and ok integrity on an empty ledger', async () => {
      const { ctx } = makeContext();
      const audit = createAuditModule(ctx);
      const summary = await audit.summary();
      expect(summary).toEqual({
        totalRecords: 0,
        head: null,
        integrityOk: true,
        countsByType: {},
        actorCount: 0,
        firstAt: null,
        lastAt: null,
      });
    });

    it('aggregates counts by type, distinct actors, and time bounds', async () => {
      const { ctx, ledger, clock } = makeContext();
      const audit = createAuditModule(ctx);

      await appendNote(ledger, 'agent-a', 'first');
      clock.advance(1000);
      await appendNote(ledger, 'agent-b', 'second');
      clock.advance(1000);
      // A second event type from a repeated actor.
      const proposed = await ledger.append({
        type: 'action.proposed',
        actorId: 'agent-a',
        payload: {
          action: {
            id: 'act-1',
            actorId: 'agent-a',
            type: 'http.request',
            target: 'https://api.example.com',
            risk: 'low',
          },
        },
      });
      expect(isOk(proposed)).toBe(true);

      const summary = await audit.summary();
      expect(summary.totalRecords).toBe(3);
      expect(summary.countsByType).toEqual({ note: 2, 'action.proposed': 1 });
      expect(summary.actorCount).toBe(2);
      expect(summary.firstAt).toBe(START);
      expect(summary.lastAt).toBe(START + 2000);
      expect(summary.integrityOk).toBe(true);
      expect(summary.head).not.toBeNull();
    });

    it('head matches the ledger head hash', async () => {
      const { ctx, ledger } = makeContext();
      const audit = createAuditModule(ctx);
      await appendNote(ledger, 'agent-a', 'one');
      const head = await ledger.head();
      const summary = await audit.summary();
      expect(summary.head).toBe(head?.hash ?? null);
    });
  });

  describe('timeline', () => {
    it('returns only records for the given correlation id, in seq order', async () => {
      const { ctx, ledger } = makeContext();
      const audit = createAuditModule(ctx);

      const a1 = await appendNote(ledger, 'agent-a', 'run-x first', 'corr-x');
      await appendNote(ledger, 'agent-b', 'run-y first', 'corr-y');
      const a2 = await appendNote(ledger, 'agent-a', 'run-x second', 'corr-x');

      const timeline = await audit.timeline('corr-x');
      expect(timeline.map((r) => r.seq)).toEqual([a1.seq, a2.seq]);
      expect(timeline.every((r) => r.event.correlationId === 'corr-x')).toBe(true);
    });

    it('returns an empty array for an unknown correlation id', async () => {
      const { ctx, ledger } = makeContext();
      const audit = createAuditModule(ctx);
      await appendNote(ledger, 'agent-a', 'one', 'corr-x');
      expect(await audit.timeline('does-not-exist')).toEqual([]);
    });
  });

  describe('search and get', () => {
    it('search delegates to the ledger query filter', async () => {
      const { ctx, ledger } = makeContext();
      const audit = createAuditModule(ctx);
      await appendNote(ledger, 'agent-a', 'a');
      await appendNote(ledger, 'agent-b', 'b');
      const onlyA = await audit.search({ actorId: 'agent-a' });
      expect(onlyA).toHaveLength(1);
      expect(onlyA[0]?.event.actorId).toBe('agent-a');
    });

    it('get returns the record by seq, or null when absent', async () => {
      const { ctx, ledger } = makeContext();
      const audit = createAuditModule(ctx);
      const rec = await appendNote(ledger, 'agent-a', 'a');
      expect((await audit.get(rec.seq))?.hash).toBe(rec.hash);
      expect(await audit.get(999)).toBeNull();
    });
  });

  describe('verify', () => {
    it('reports ok on a clean ledger', async () => {
      const { ctx, ledger } = makeContext();
      const audit = createAuditModule(ctx);
      await appendNote(ledger, 'agent-a', 'one');
      await appendNote(ledger, 'agent-a', 'two');
      const report = await audit.verify();
      expect(report.ok).toBe(true);
      expect(report.checked).toBe(2);
      expect(report.issues).toEqual([]);
    });
  });

  describe('exportNdjson', () => {
    it('emits one record per line and round-trips via JSON.parse', async () => {
      const { ctx, ledger } = makeContext();
      const audit = createAuditModule(ctx);
      const r1 = await appendNote(ledger, 'agent-a', 'one');
      const r2 = await appendNote(ledger, 'agent-b', 'two');

      const ndjson = await audit.exportNdjson();
      const lines = ndjson.split('\n');
      expect(lines).toHaveLength(2);

      const parsed = lines.map((line) => JSON.parse(line) as LedgerRecord);
      expect(parsed.map((r) => r.seq)).toEqual([r1.seq, r2.seq]);
      expect(parsed[0]?.hash).toBe(r1.hash);
      expect(parsed[1]?.event.actorId).toBe('agent-b');
    });

    it('returns an empty string for an empty ledger', async () => {
      const { ctx } = makeContext();
      const audit = createAuditModule(ctx);
      expect(await audit.exportNdjson()).toBe('');
    });
  });
});
