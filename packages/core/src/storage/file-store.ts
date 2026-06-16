import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import type { LedgerRecord } from '../ledger/record.js';
import { storageError, type VeritrailError } from '../util/errors.js';
import { ok, type Result } from '../util/result.js';
import { ArrayBackedEventStore } from './array-store.js';

interface ErrnoLike {
  code?: string;
}

/**
 * Durable, append-only ledger backed by a JSON Lines file. One record per line;
 * the file is only ever appended to, which mirrors the ledger's own semantics
 * and makes the on-disk form trivially auditable (and `tail -f`-able). Pure JS,
 * no native dependencies — the safe default for self-hosting.
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

  /** Open (and create the parent directory of) a ledger file, loading any existing records. */
  static async open(path: string): Promise<FileEventStore> {
    await mkdir(dirname(path), { recursive: true });
    let records: LedgerRecord[] = [];
    try {
      const content = await readFile(path, 'utf8');
      const lines = content.split('\n').filter((line) => line.trim().length > 0);
      records = [];
      for (let i = 0; i < lines.length; i += 1) {
        const line = lines[i] as string;
        try {
          records.push(JSON.parse(line) as LedgerRecord);
        } catch (cause) {
          // A torn final line is the normal crash-during-append failure mode:
          // recover the committed prefix by dropping it. Interior corruption is
          // unrecoverable and is surfaced as an error.
          if (i === lines.length - 1) break;
          throw storageError(`corrupt ledger line ${i + 1} in ${path}`, cause);
        }
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
      await appendFile(this.#path, `${JSON.stringify(record)}\n`, 'utf8');
    } catch (cause) {
      return { ok: false, error: storageError(`failed to append to ${this.#path}`, cause) };
    }
    this.records.push(record);
    return ok(record);
  }

  /** The file this store persists to. */
  get path(): string {
    return this.#path;
  }
}
