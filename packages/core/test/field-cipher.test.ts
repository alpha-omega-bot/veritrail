import { describe, expect, it } from 'vitest';

import {
  AesGcmKeyring,
  EncryptingEventRedactor,
  FixedClock,
  SequentialIdGenerator,
  computeRecordHash,
  createInMemoryLedger,
  decryptEventFields,
  isEncryptedToken,
} from '@veritrail/core';

describe('AesGcmKeyring', () => {
  it('round-trips a plaintext through encrypt/decrypt', () => {
    const ring = AesGcmKeyring.generate('k1');
    const token = ring.encrypt('alice@example.com');
    expect(isEncryptedToken(token)).toBe(true);
    expect(token).not.toContain('alice@example.com');
    const out = ring.decrypt(token);
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.value).toBe('alice@example.com');
  });

  it('produces a distinct ciphertext per call (random IV)', () => {
    const ring = AesGcmKeyring.generate('k1');
    expect(ring.encrypt('same')).not.toBe(ring.encrypt('same'));
  });

  it('returns NOT_FOUND after the key is erased (cryptographic erasure)', () => {
    const ring = AesGcmKeyring.generate('k1');
    const token = ring.encrypt('secret');
    expect(ring.eraseKey('k1')).toBe(true);
    const out = ring.decrypt(token);
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.error.code).toBe('NOT_FOUND');
  });

  it('rejects a malformed token with VALIDATION', () => {
    const ring = AesGcmKeyring.generate('k1');
    const out = ring.decrypt('not-a-token');
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.error.code).toBe('VALIDATION');
  });

  it('fails authentication (VALIDATION) on a tampered token', () => {
    const ring = AesGcmKeyring.generate('k1');
    const token = ring.encrypt('secret');
    const parts = token.split('.');
    // Flip the ciphertext segment.
    parts[4] = Buffer.from('tampered-ciphertext').toString('base64url');
    const out = ring.decrypt(parts.join('.'));
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.error.code).toBe('VALIDATION');
  });

  it('decrypts across rotation until the old key is erased', () => {
    const ring = AesGcmKeyring.generate('k1');
    const old = ring.encrypt('v1 data');
    ring.setActiveKey('k2', Buffer.alloc(32, 7));
    const fresh = ring.encrypt('v2 data');
    // Both decrypt while both keys are present.
    expect(ring.decrypt(old).ok).toBe(true);
    expect(ring.decrypt(fresh).ok).toBe(true);
    // Erase the old key: only v2 survives.
    ring.eraseKey('k1');
    expect(ring.decrypt(old).ok).toBe(false);
    expect(ring.decrypt(fresh).ok).toBe(true);
  });

  it('rejects keys of the wrong size', () => {
    expect(() => new AesGcmKeyring({ k1: Buffer.alloc(16) })).toThrow();
  });
});

describe('EncryptingEventRedactor at the append boundary', () => {
  it('commits only ciphertext and keeps the chain verifiable after erasure', async () => {
    const ring = AesGcmKeyring.generate('subject-1');
    const ledger = createInMemoryLedger({
      clock: new FixedClock(1000),
      ids: new SequentialIdGenerator(),
      redactor: new EncryptingEventRedactor(ring, ['payload.data.email', 'payload.data.notes.*']),
    });

    const result = await ledger.append({
      type: 'note',
      actorId: 'agent_1',
      payload: {
        text: 'safe metadata',
        data: { email: 'alice@example.com', notes: ['pii one', 'pii two'] },
      },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const record = result.value;
    if (record.event.type !== 'note') return;

    const data = record.event.payload.data as { email: string; notes: string[] };
    // The committed record holds tokens, not plaintext.
    expect(isEncryptedToken(data.email)).toBe(true);
    expect(data.notes.every(isEncryptedToken)).toBe(true);
    expect(JSON.stringify(record.event)).not.toContain('alice@example.com');

    // Hash is over the (encrypted) committed bytes.
    expect(computeRecordHash(record)).toBe(record.hash);

    // An authorized reader recovers the plaintext.
    const decrypted = decryptEventFields(record.event, ring, [
      'payload.data.email',
      'payload.data.notes.*',
    ]);
    if (decrypted.type !== 'note') return;
    const dd = decrypted.payload.data as { email: string; notes: string[] };
    expect(dd.email).toBe('alice@example.com');
    expect(dd.notes).toEqual(['pii one', 'pii two']);

    // Cryptographic erasure: destroy the key. The chain still verifies…
    ring.eraseKey('subject-1');
    const report = await ledger.verify();
    expect(report.ok).toBe(true);
    // …and the plaintext is gone, surfaced as [ERASED].
    const afterErase = decryptEventFields(record.event, ring, ['payload.data.email']);
    if (afterErase.type !== 'note') return;
    expect((afterErase.payload.data as { email: string }).email).toBe('[ERASED]');
  });

  it('leaves non-string targets unchanged (schema re-validation is the backstop)', async () => {
    const ring = AesGcmKeyring.generate('k1');
    const redactor = new EncryptingEventRedactor(ring, ['payload.count']);
    const out = redactor.redact({
      type: 'note',
      actorId: 'a',
      labels: {},
      payload: { text: 'x', count: 5 },
    } as Parameters<typeof redactor.redact>[0]);
    if (out.type !== 'note') return;
    expect((out.payload as unknown as { count: number }).count).toBe(5);
  });
});
