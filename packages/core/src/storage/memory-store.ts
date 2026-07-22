import type { LedgerRecord } from '../ledger/record.js';
import type { VeritrailError } from '../util/errors.js';
import { ok, type Result } from '../util/result.js';
import { ArrayBackedEventStore } from './array-store.js';

/**
 * Volatile, in-process event store. The default for tests and ephemeral usage.
 * Fast and dependency-free; not durable across process restarts.
 */
export class InMemoryEventStore extends ArrayBackedEventStore {
  async append(record: LedgerRecord): Promise<Result<LedgerRecord, VeritrailError>> {
    const stored = this.cloneRecord(record);
    const check = this.checkAppend(stored);
    if (!check.ok) return check;
    this.records.push(stored);
    return ok(this.cloneRecord(stored));
  }
}
