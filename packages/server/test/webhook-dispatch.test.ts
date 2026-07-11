import type { LedgerRecord } from '@veritrail/core';
import { describe, expect, it } from 'vitest';

import { dispatchToWebhooks, filterMatches } from '../src/webhook-dispatch.js';

function fakeRecord(opts: { type: string; projectId?: string }): LedgerRecord {
  return {
    seq: 1,
    id: 'rec_1',
    timestamp: 1_700_000_000_000,
    prevHash: '0'.repeat(64),
    hash: '1'.repeat(64),
    event: {
      type: opts.type as 'note',
      actorId: 'agent-1',
      payload: { text: 'hi' },
      labels: opts.projectId ? { project: opts.projectId } : {},
    } as LedgerRecord['event'],
  };
}

describe('filterMatches', () => {
  it('returns true for the "*" wildcard', () => {
    expect(filterMatches('*', 'anything')).toBe(true);
  });
  it('returns true for the empty filter', () => {
    expect(filterMatches('', 'foo')).toBe(true);
  });
  it('returns true for an exact event-type match in a CSV', () => {
    expect(filterMatches('policy.violation,budget.exceeded', 'policy.violation')).toBe(true);
  });
  it('returns false for an unrelated event type', () => {
    expect(filterMatches('policy.violation', 'note')).toBe(false);
  });
  it('matches a prefix wildcard like "tool.*"', () => {
    expect(filterMatches('tool.*', 'tool.invoke')).toBe(true);
    expect(filterMatches('tool.*', 'tool.result')).toBe(true);
    expect(filterMatches('tool.*', 'http.request')).toBe(false);
  });
});

describe('dispatchToWebhooks', () => {
  function makeOutbox() {
    const entries: Array<Record<string, unknown>> = [];
    return {
      entries,
      enqueue: async (input: Record<string, unknown>) => {
        entries.push(input);
        return input;
      },
    };
  }

  it('skips records without a project label', async () => {
    const outbox = makeOutbox();
    const written = await dispatchToWebhooks(fakeRecord({ type: 'note' }), {
      subscriptions: {
        listWebhooksForProject: async () => [],
      },
      outbox,
      clock: () => 1_700_000_000_010,
      newId: () => 'whe_1',
    });
    expect(written).toBe(0);
    expect(outbox.entries).toEqual([]);
  });

  it('enqueues one outbox entry per matching subscription', async () => {
    const outbox = makeOutbox();
    const written = await dispatchToWebhooks(
      fakeRecord({ type: 'policy.evaluated', projectId: 'proj_1' }),
      {
        subscriptions: {
          listWebhooksForProject: async (id) => {
            expect(id).toBe('proj_1');
            return [
              {
                id: 'wh_1',
                projectId: 'proj_1',
                url: 'https://example.com/a',
                secret: 's1',
                eventsFilter: '*',
                pausedAt: null,
              },
              {
                id: 'wh_2',
                projectId: 'proj_1',
                url: 'https://example.com/b',
                secret: 's2',
                eventsFilter: 'policy.*',
                pausedAt: null,
              },
            ];
          },
        },
        outbox,
        clock: () => 1_700_000_000_010,
        newId: (() => {
          let i = 0;
          return () => `whe_${++i}`;
        })(),
      },
    );
    expect(written).toBe(2);
    expect(outbox.entries[0]?.url).toBe('https://example.com/a');
    expect(outbox.entries[1]?.url).toBe('https://example.com/b');
    expect(outbox.entries[0]?.eventType).toBe('policy.evaluated');
  });

  it('skips paused subscriptions', async () => {
    const outbox = makeOutbox();
    await dispatchToWebhooks(fakeRecord({ type: 'note', projectId: 'proj_1' }), {
      subscriptions: {
        listWebhooksForProject: async () => [
          {
            id: 'wh_1',
            projectId: 'proj_1',
            url: 'https://example.com/a',
            secret: 's',
            eventsFilter: '*',
            pausedAt: 1_700_000_000_000,
          },
        ],
      },
      outbox,
      clock: () => 1_700_000_000_010,
      newId: () => 'whe_1',
    });
    expect(outbox.entries).toEqual([]);
  });

  it('skips subscriptions whose filter does not match the event type', async () => {
    const outbox = makeOutbox();
    await dispatchToWebhooks(fakeRecord({ type: 'note', projectId: 'proj_1' }), {
      subscriptions: {
        listWebhooksForProject: async () => [
          {
            id: 'wh_1',
            projectId: 'proj_1',
            url: 'https://example.com/a',
            secret: 's',
            eventsFilter: 'policy.*',
            pausedAt: null,
          },
        ],
      },
      outbox,
      clock: () => 1_700_000_000_010,
      newId: () => 'whe_1',
    });
    expect(outbox.entries).toEqual([]);
  });
});
