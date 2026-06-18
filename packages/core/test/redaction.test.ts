import { describe, expect, it } from 'vitest';

import {
  computeRecordHash,
  createInMemoryLedger,
  FixedClock,
  HmacSigner,
  PathEventRedactor,
  SequentialIdGenerator,
  type EventRedactor,
  type LedgerRecord,
} from '@veritrail/core';

describe('PathEventRedactor', () => {
  it('redacts configured fields before hashing, signing, and persistence', async () => {
    const signer = new HmacSigner('a-sufficiently-long-secret');
    const ledger = createInMemoryLedger({
      clock: new FixedClock(1000),
      ids: new SequentialIdGenerator(),
      signer,
      redactor: new PathEventRedactor([
        { path: 'payload.data.email' },
        { path: 'payload.data.tokens.*.secret', replacement: null },
      ]),
    });
    const input = {
      type: 'note',
      actorId: 'agent_1',
      payload: {
        text: 'contains sensitive metadata',
        data: {
          email: 'alice@example.com',
          tokens: [{ secret: 'tok_1', last4: '1234' }],
        },
      },
    };

    const result = await ledger.append(input);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const record = result.value;
    expect(record.event.type).toBe('note');
    if (record.event.type !== 'note') return;
    expect((record.event.payload.data as { email: string }).email).toBe('[REDACTED]');
    expect(
      (record.event.payload.data as { tokens: Array<{ secret: null; last4: string }> }).tokens[0],
    ).toEqual({ secret: null, last4: '1234' });
    expect(input.payload.data.email).toBe('alice@example.com');

    expect(computeRecordHash(record)).toBe(record.hash);
    expect(signer.verify(record.hash, record.signature!, record.signerKeyId)).toBe(true);

    const unredacted: LedgerRecord = {
      ...record,
      event: {
        type: 'note',
        actorId: 'agent_1',
        labels: {},
        payload: input.payload,
      },
    };
    expect(computeRecordHash(unredacted)).not.toBe(record.hash);
  });

  it('rejects invalid redacted events without persisting', async () => {
    const invalidRedactor: EventRedactor = {
      redact(event) {
        return { ...event, payload: {} } as ReturnType<EventRedactor['redact']>;
      },
    };
    const ledger = createInMemoryLedger({
      clock: new FixedClock(1000),
      ids: new SequentialIdGenerator(),
      redactor: invalidRedactor,
    });

    const result = await ledger.append({
      type: 'note',
      actorId: 'agent_1',
      payload: { text: 'hello' },
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('VALIDATION');
    expect(await ledger.count()).toBe(0);
  });

  it('returns STORAGE when redaction fails before persistence', async () => {
    const failingRedactor: EventRedactor = {
      redact() {
        throw new Error('redaction unavailable');
      },
    };
    const ledger = createInMemoryLedger({
      clock: new FixedClock(1000),
      ids: new SequentialIdGenerator(),
      redactor: failingRedactor,
    });

    const result = await ledger.append({
      type: 'note',
      actorId: 'agent_1',
      payload: { text: 'hello' },
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('STORAGE');
    expect(await ledger.count()).toBe(0);
  });
});
