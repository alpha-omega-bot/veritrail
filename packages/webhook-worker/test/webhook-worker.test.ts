import { describe, expect, it } from 'vitest';

import { InMemoryOutboxStore, type WebhookEntry } from '../src/outbox.js';
import { nextAttemptDelay } from '../src/retry.js';
import { signPayload, verifySignature } from '../src/signing.js';
import { WebhookWorker } from '../src/worker.js';

function newEntry(overrides: Partial<WebhookEntry> = {}): WebhookEntry {
  return {
    id: 'whe_1',
    webhookId: 'wh_1',
    url: 'https://example.com/hook',
    secret: 'whsec_test',
    payload: { type: 'policy.violation', data: { actor: 'agent-1' } },
    eventType: 'policy.violation',
    queuedAt: 1_700_000_000_000,
    attempts: 0,
    nextAttemptAt: 1_700_000_000_000,
    deliveredAt: null,
    failedAt: null,
    lastError: null,
    ...overrides,
  };
}

function recordingFetch(status: number, networkError?: string) {
  const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
  const impl: typeof fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : '';
    calls.push({ url, init });
    if (networkError) throw new Error(networkError);
    return new Response('', { status });
  };
  return { impl, calls };
}

describe('signPayload + verifySignature', () => {
  it('round-trips a signature', () => {
    const now = 1_700_000_000_000;
    const { header } = signPayload('s', 'hello', now);
    expect(verifySignature('s', 'hello', header, { nowMs: now })).toBe(true);
  });

  it('rejects a tampered body', () => {
    const now = 1_700_000_000_000;
    const { header } = signPayload('s', 'hello', now);
    expect(verifySignature('s', 'tampered', header, { nowMs: now })).toBe(false);
  });

  it('rejects an expired signature', () => {
    const ts = 1_700_000_000_000;
    const { header } = signPayload('s', 'hello', ts);
    expect(verifySignature('s', 'hello', header, { nowMs: ts + 1_000_000 })).toBe(false);
  });
});

describe('nextAttemptDelay', () => {
  it('grows exponentially and stays positive', () => {
    const delays = [0, 1, 2, 3, 4, 5, 10].map(nextAttemptDelay);
    for (let i = 1; i < delays.length; i += 1) {
      expect(delays[i]).toBeGreaterThan(0);
    }
    expect(delays[3]!).toBeGreaterThan(delays[1]!);
  });
  it('caps at 24 hours', () => {
    const huge = nextAttemptDelay(100);
    expect(huge).toBeLessThanOrEqual(24 * 60 * 60 * 1000 + 100);
  });
});

describe('InMemoryOutboxStore.fetchDue', () => {
  it('returns only entries whose nextAttemptAt has elapsed AND not delivered/failed', async () => {
    const store = new InMemoryOutboxStore();
    await store.enqueue({
      ...newEntry({ id: 'a', nextAttemptAt: 100 }),
    });
    await store.enqueue({
      ...newEntry({ id: 'b', nextAttemptAt: 200 }),
    });
    await store.enqueue({
      ...newEntry({ id: 'c', nextAttemptAt: 300 }),
    });
    const due = await store.fetchDue(200, 10);
    expect(due.map((e) => e.id).sort()).toEqual(['a', 'b']);
  });
});

describe('WebhookWorker.processBatch', () => {
  it('marks delivered on a 2xx response', async () => {
    const store = new InMemoryOutboxStore();
    await store.enqueue(newEntry({ id: 'a' }));
    const { impl } = recordingFetch(200);
    const worker = new WebhookWorker({
      store,
      fetchImpl: impl,
      clock: () => 1_700_000_000_001,
    });
    const result = await worker.processBatch();
    expect(result.delivered).toBe(1);
    expect(store.get('a')?.deliveredAt).not.toBeNull();
  });

  it('marks retry on a 500 response and schedules a next attempt', async () => {
    const store = new InMemoryOutboxStore();
    await store.enqueue(newEntry({ id: 'a' }));
    const { impl } = recordingFetch(503);
    const worker = new WebhookWorker({
      store,
      fetchImpl: impl,
      clock: () => 1_700_000_000_001,
    });
    const result = await worker.processBatch();
    expect(result.retried).toBe(1);
    const updated = store.get('a');
    expect(updated?.attempts).toBe(1);
    expect(updated?.nextAttemptAt).toBeGreaterThan(1_700_000_000_001);
    expect(updated?.deliveredAt).toBeNull();
  });

  it('marks failed on a 4xx response (no retries)', async () => {
    const store = new InMemoryOutboxStore();
    await store.enqueue(newEntry({ id: 'a' }));
    const { impl } = recordingFetch(404);
    const worker = new WebhookWorker({
      store,
      fetchImpl: impl,
      clock: () => 1_700_000_000_001,
    });
    const result = await worker.processBatch();
    expect(result.failed).toBe(1);
    expect(store.get('a')?.failedAt).not.toBeNull();
    expect(store.get('a')?.lastError).toMatch(/404/);
  });

  it('marks failed after maxAttempts of 5xx', async () => {
    const store = new InMemoryOutboxStore();
    await store.enqueue(newEntry({ id: 'a' }));
    const { impl } = recordingFetch(503);
    let now = 1_700_000_000_001;
    const worker = new WebhookWorker({
      store,
      fetchImpl: impl,
      clock: () => now,
      maxAttempts: 3,
    });
    // Attempt 1 — retried
    let result = await worker.processBatch();
    expect(result.retried).toBe(1);
    now += 1_000_000;
    // Attempt 2 — retried
    result = await worker.processBatch();
    expect(result.retried).toBe(1);
    now += 1_000_000;
    // Attempt 3 — reaches maxAttempts, marked failed
    result = await worker.processBatch();
    expect(result.failed).toBe(1);
    expect(store.get('a')?.failedAt).not.toBeNull();
  });

  it('marks retry on network error', async () => {
    const store = new InMemoryOutboxStore();
    await store.enqueue(newEntry({ id: 'a' }));
    const { impl } = recordingFetch(0, 'ECONNREFUSED');
    const worker = new WebhookWorker({
      store,
      fetchImpl: impl,
      clock: () => 1_700_000_000_001,
    });
    const result = await worker.processBatch();
    expect(result.retried).toBe(1);
    expect(store.get('a')?.lastError).toMatch(/ECONNREFUSED/);
  });

  it('attaches signing headers on the outbound request', async () => {
    const store = new InMemoryOutboxStore();
    await store.enqueue(newEntry({ id: 'a' }));
    const { impl, calls } = recordingFetch(200);
    const worker = new WebhookWorker({ store, fetchImpl: impl, clock: () => 1_700_000_000_001 });
    await worker.processBatch();
    const headers = calls[0]?.init?.headers as Record<string, string>;
    expect(headers['x-veritrail-signature']).toMatch(/^v1=[a-f0-9]+,t=\d+$/);
    expect(headers['x-veritrail-event-type']).toBe('policy.violation');
    expect(headers['content-type']).toBe('application/json');
  });

  it('processBatch is a no-op when nothing is due', async () => {
    const store = new InMemoryOutboxStore();
    const { impl, calls } = recordingFetch(200);
    const worker = new WebhookWorker({ store, fetchImpl: impl, clock: () => 1_700_000_000_000 });
    const result = await worker.processBatch();
    expect(result).toEqual({ delivered: 0, retried: 0, failed: 0 });
    expect(calls).toEqual([]);
  });
});

describe('WebhookWorker destination safety', () => {
  it('blocks private destinations before fetch', async () => {
    const store = new InMemoryOutboxStore();
    await store.enqueue(
      newEntry({ id: 'private', url: 'http://169.254.169.254/latest/meta-data' }),
    );
    const { impl, calls } = recordingFetch(200);
    const worker = new WebhookWorker({
      store,
      fetchImpl: impl,
      clock: () => 1_700_000_000_001,
      maxAttempts: 1,
    });
    const result = await worker.processBatch();
    expect(result.failed).toBe(1);
    expect(calls).toHaveLength(0);
    expect(store.get('private')?.lastError).toMatch(/private|reserved/);
  });
});
