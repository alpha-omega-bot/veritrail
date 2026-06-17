import { randomUUID } from 'node:crypto';
import type { FileHandle } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type * as FsPromises from 'node:fs/promises';

const realFs = await vi.importActual<typeof FsPromises>('node:fs/promises');

const fsyncState = vi.hoisted(() => ({
  failNextFileSync: false,
  fileSyncs: 0,
  currentPath: '',
}));

vi.mock('node:fs/promises', async () => {
  const actual = await vi.importActual<typeof FsPromises>('node:fs/promises');
  return {
    ...actual,
    open: async (...args: Parameters<typeof actual.open>): Promise<FileHandle> => {
      const handle = await actual.open(...args);
      if (args[0] === fsyncState.currentPath && (args[1] === 'a' || args[1] === 'r+')) {
        const originalSync = handle.sync.bind(handle);
        const patched = handle as FileHandle & { sync: FileHandle['sync'] };
        patched.sync = async () => {
          fsyncState.fileSyncs += 1;
          if (fsyncState.failNextFileSync) {
            fsyncState.failNextFileSync = false;
            throw new Error('simulated fsync failure');
          }
          return originalSync();
        };
      }
      return handle;
    },
  };
});

const { FileEventStore, FixedClock, Ledger, SequentialIdGenerator } =
  await import('@veritrail/core');

describe('FileEventStore durable append fsync behavior', () => {
  const paths: string[] = [];
  const tempPath = (): string => {
    const p = join(tmpdir(), `veritrail-durable-${randomUUID()}.ledger.jsonl`);
    paths.push(p);
    return p;
  };

  beforeEach(() => {
    fsyncState.failNextFileSync = false;
    fsyncState.fileSyncs = 0;
    fsyncState.currentPath = tempPath();
  });

  afterEach(async () => {
    await Promise.all(paths.splice(0).map((p) => realFs.rm(p, { force: true })));
  });

  it('fsyncs the ledger file before acknowledging an append', async () => {
    const store = await FileEventStore.open(fsyncState.currentPath);
    fsyncState.fileSyncs = 0;
    const ledger = new Ledger({
      store,
      clock: new FixedClock(1),
      ids: new SequentialIdGenerator(),
    });

    const result = await ledger.append({
      type: 'note',
      actorId: 'a',
      payload: { text: 'durable' },
    });

    expect(result.ok).toBe(true);
    expect(fsyncState.fileSyncs).toBe(1);
    expect(await store.count()).toBe(1);
  });

  it('does not advance the in-memory head when fsync fails after writing', async () => {
    const store = await FileEventStore.open(fsyncState.currentPath);
    const ledger = new Ledger({
      store,
      clock: new FixedClock(1),
      ids: new SequentialIdGenerator(),
    });

    fsyncState.failNextFileSync = true;
    const result = await ledger.append({ type: 'note', actorId: 'a', payload: { text: 'lost' } });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('STORAGE');
    expect(await store.count()).toBe(0);
    expect(await store.head()).toBeNull();
    expect(await realFs.readFile(fsyncState.currentPath, 'utf8')).toBe('');
  });
});
