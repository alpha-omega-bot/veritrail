import { randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { run, type CliIO } from '../src/cli.js';

function capture(): { io: CliIO; out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  return { io: { out: (l) => out.push(l), err: (l) => err.push(l) }, out, err };
}

describe('veritrail CLI', () => {
  const paths: string[] = [];
  const tempFile = (): string => {
    const p = join(tmpdir(), `veritrail-cli-${randomUUID()}.ledger.jsonl`);
    paths.push(p);
    return p;
  };

  afterEach(async () => {
    await Promise.all(paths.splice(0).map((p) => rm(p, { force: true })));
  });

  const append = async (file: string, event: unknown): Promise<number> => {
    const { io } = capture();
    return run(['append', JSON.stringify(event), '--file', file], io);
  };

  it('appends events, verifies integrity, and summarizes', async () => {
    const file = tempFile();
    expect(await append(file, { type: 'note', actorId: 'a', payload: { text: 'hi' } })).toBe(0);
    expect(
      await append(file, {
        type: 'vendor.registered',
        actorId: 'a',
        payload: { vendor: { id: 'ven_1', name: 'OpenAI', category: 'llm' } },
      }),
    ).toBe(0);
    expect(
      await append(file, {
        type: 'vendor.signal',
        actorId: 'a',
        payload: {
          signal: {
            id: 'sig_1',
            vendorId: 'ven_1',
            kind: 'incident',
            severity: 'high',
            summary: 'outage',
          },
        },
      }),
    ).toBe(0);

    const verify = capture();
    expect(await run(['verify', '--file', file, '--json'], verify.io)).toBe(0);
    expect(JSON.parse(verify.out.join('\n'))).toMatchObject({ ok: true, checked: 3 });

    const summary = capture();
    expect(await run(['summary', '--file', file, '--json'], summary.io)).toBe(0);
    expect(JSON.parse(summary.out.join('\n'))).toMatchObject({
      totalRecords: 3,
      integrityOk: true,
    });
  });

  it('filters events by type', async () => {
    const file = tempFile();
    await append(file, { type: 'note', actorId: 'a', payload: { text: 'one' } });
    await append(file, { type: 'note', actorId: 'a', payload: { text: 'two' } });
    const { io, out } = capture();
    expect(await run(['events', '--file', file, '--type', 'note', '--json'], io)).toBe(0);
    expect(JSON.parse(out.join('\n'))).toHaveLength(2);
  });

  it('assesses vendor risk from the ledger', async () => {
    const file = tempFile();
    await append(file, {
      type: 'vendor.registered',
      actorId: 'a',
      payload: { vendor: { id: 'ven_1', name: 'OpenAI', category: 'llm' } },
    });
    await append(file, {
      type: 'vendor.signal',
      actorId: 'a',
      payload: {
        signal: {
          id: 'sig_1',
          vendorId: 'ven_1',
          kind: 'breach',
          severity: 'critical',
          summary: 'breach',
        },
      },
    });
    const { io, out } = capture();
    expect(await run(['vendor-risk', '--file', file, '--json'], io)).toBe(0);
    const scores = JSON.parse(out.join('\n')) as Array<{ vendorId: string; score: number }>;
    expect(scores).toHaveLength(1);
    expect(scores[0]!.vendorId).toBe('ven_1');
    expect(scores[0]!.score).toBeGreaterThan(0);
  });

  it('reports invalid append input', async () => {
    const file = tempFile();
    const { io, err } = capture();
    expect(await run(['append', '{ not json', '--file', file], io)).toBe(2);
    expect(err.join('\n')).toMatch(/not valid JSON/);
  });

  it('prints usage with no command', async () => {
    const { io, out } = capture();
    expect(await run([], io)).toBe(0);
    expect(out.join('\n')).toMatch(/Usage: veritrail/);
  });
});
