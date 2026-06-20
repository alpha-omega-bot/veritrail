import { mkdir, open as openFile, readFile, stat, truncate } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { dirname } from 'node:path';

import type { LedgerRecord } from '../ledger/record.js';
import { storageError, type VeritrailError } from '../util/errors.js';
import { ok, type Result } from '../util/result.js';
import { ArrayBackedEventStore } from './array-store.js';

interface ErrnoLike {
  code?: string;
}

async function withHandle<T>(
  path: string,
  flags: string,
  fn: (handle: FileHandle) => Promise<T>,
): Promise<T> {
  let handle: FileHandle | undefined;
  let thrown: unknown;
  let value: T | undefined;

  try {
    handle = await openFile(path, flags);
    value = await fn(handle);
  } catch (cause) {
    thrown = cause;
  } finally {
    if (handle !== undefined) {
      try {
        await handle.close();
      } catch (cause) {
        thrown ??= cause;
      }
    }
  }

  if (thrown !== undefined) throw thrown;
  return value as T;
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (cause) {
    if ((cause as ErrnoLike).code === 'ENOENT') return false;
    throw cause;
  }
}

function isUnsupportedDirectorySync(cause: unknown): boolean {
  const code = (cause as ErrnoLike).code;
  return code === 'EINVAL' || code === 'ENOTSUP' || code === 'EPERM' || code === 'EISDIR';
}

async function syncParentDirectory(path: string): Promise<void> {
  try {
    await withHandle(dirname(path), 'r', async (handle) => {
      await handle.sync();
    });
  } catch (cause) {
    // Some platforms/filesystems do not expose directory fsync. File fsync below
    // remains mandatory; directory fsync is best-effort for cross-platform use.
    if (!isUnsupportedDirectorySync(cause)) throw cause;
  }
}

async function createFileDurably(path: string): Promise<void> {
  if (await exists(path)) return;
  await withHandle(path, 'a', async (handle) => {
    await handle.sync();
  });
  await syncParentDirectory(path);
}

async function appendLineDurably(path: string, line: string): Promise<void> {
  const previousLength = (await stat(path)).size;
  try {
    await withHandle(path, 'a', async (handle) => {
      await handle.writeFile(line, 'utf8');
      await handle.sync();
    });
  } catch (cause) {
    try {
      await truncateDurably(path, previousLength);
    } catch {
      // Preserve the original write/fsync failure for callers. The store does
      // not advance its in-memory head unless the durable append succeeds.
    }
    throw cause;
  }
}

async function truncateDurably(path: string, length: number): Promise<void> {
  await truncate(path, length);
  await withHandle(path, 'r+', async (handle) => {
    await handle.sync();
  });
}

/**
 * Append a payload of one or more serialized lines with a SINGLE fsync, rolling
 * the file back to its previous length if the write or flush fails — so a batch
 * is durable in full or not at all (ADR-0006).
 */
async function appendBatchDurably(path: string, payload: string): Promise<void> {
  const previousLength = (await stat(path)).size;
  try {
    await withHandle(path, 'a', async (handle) => {
      await handle.writeFile(payload, 'utf8');
      await handle.sync();
    });
  } catch (cause) {
    try {
      await truncateDurably(path, previousLength);
    } catch {
      // Preserve the original failure; the in-memory head is not advanced unless
      // the durable batch append fully succeeds.
    }
    throw cause;
  }
}

function parseRecords(
  content: string,
  path: string,
): { records: LedgerRecord[]; truncateAt: number | undefined } {
  const records: LedgerRecord[] = [];
  const lines = content.split('\n');
  let lastNonEmptyLine = -1;
  let offset = 0;

  for (let i = lines.length - 1; i >= 0; i -= 1) {
    if ((lines[i] as string).trim().length > 0) {
      lastNonEmptyLine = i;
      break;
    }
  }

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] as string;
    const hasTerminator = i < lines.length - 1;
    const lineBytes = Buffer.byteLength(line, 'utf8') + (hasTerminator ? 1 : 0);

    if (line.trim().length === 0) {
      offset += lineBytes;
      continue;
    }

    try {
      records.push(JSON.parse(line) as LedgerRecord);
    } catch (cause) {
      // A torn final line is the normal crash-during-append failure mode:
      // recover the committed prefix by dropping it. Interior corruption is
      // unrecoverable and is surfaced as an error.
      if (i === lastNonEmptyLine) {
        return { records, truncateAt: offset };
      }
      throw storageError(`corrupt ledger line ${i + 1} in ${path}`, cause);
    }

    offset += lineBytes;
  }

  return { records, truncateAt: undefined };
}

/**
 * Durable, append-only ledger backed by a JSON Lines file. One record per line;
 * the file is only ever appended to, which mirrors the ledger's own semantics
 * and makes the on-disk form trivially auditable (and `tail -f`-able). Appends
 * are flushed with fsync before they are acknowledged. Pure JS, no native
 * dependencies — the safe default for self-hosting.
 *
 * For high-throughput or relational querying, a SQLite/Postgres adapter
 * implementing the same `EventStore` port is on the roadmap.
 */
export class FileEventStore extends ArrayBackedEventStore {
  readonly #path: string;

  private constructor(path: string, records: LedgerRecord[]) {
    super();
    this.#path = path;
    this.records.push(...records);
  }

  /** Open (and create) a ledger file, loading any existing records. */
  static async open(path: string): Promise<FileEventStore> {
    await mkdir(dirname(path), { recursive: true });
    let records: LedgerRecord[] = [];
    try {
      await createFileDurably(path);
      const content = await readFile(path, 'utf8');
      const parsed = parseRecords(content, path);
      records = parsed.records;
      if (parsed.truncateAt !== undefined) {
        await truncateDurably(path, parsed.truncateAt);
      }
    } catch (error) {
      if ((error as ErrnoLike).code !== 'ENOENT') {
        if (error instanceof Error && error.name === 'VeritrailError') throw error;
        throw storageError(`failed to read ledger file ${path}`, error);
      }
    }
    return new FileEventStore(path, records);
  }

  async append(record: LedgerRecord): Promise<Result<LedgerRecord, VeritrailError>> {
    const check = this.checkAppend(record);
    if (!check.ok) return check;
    try {
      await appendLineDurably(this.#path, `${JSON.stringify(record)}\n`);
    } catch (cause) {
      return { ok: false, error: storageError(`failed to append to ${this.#path}`, cause) };
    }
    this.records.push(record);
    return ok(record);
  }

  override async appendBatch(
    records: readonly LedgerRecord[],
  ): Promise<Result<LedgerRecord[], VeritrailError>> {
    if (records.length === 0) return ok([]);
    const check = this.checkBatch(records);
    if (!check.ok) return check;
    const payload = records.map((record) => `${JSON.stringify(record)}\n`).join('');
    try {
      await appendBatchDurably(this.#path, payload);
    } catch (cause) {
      return { ok: false, error: storageError(`failed to append batch to ${this.#path}`, cause) };
    }
    this.records.push(...records);
    return ok([...records]);
  }

  /** The file this store persists to. */
  get path(): string {
    return this.#path;
  }
}
