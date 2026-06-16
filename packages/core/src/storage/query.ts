import type { LedgerRecord } from '../ledger/record.js';
import type { EventQuery } from './event-store.js';

/** Apply an `EventQuery` to an ordered array of records. Pure; returns a new array. */
export function applyQuery(records: readonly LedgerRecord[], query: EventQuery): LedgerRecord[] {
  const out: LedgerRecord[] = [];
  for (const record of records) {
    if (query.fromSeq !== undefined && record.seq < query.fromSeq) continue;
    if (query.toSeq !== undefined && record.seq > query.toSeq) continue;
    if (query.types !== undefined && !query.types.includes(record.event.type)) continue;
    if (query.actorId !== undefined && record.event.actorId !== query.actorId) continue;
    if (query.correlationId !== undefined && record.event.correlationId !== query.correlationId) {
      continue;
    }
    // Check the limit before pushing so `limit: 0` yields zero records.
    if (query.limit !== undefined && out.length >= query.limit) break;
    out.push(record);
  }
  return out;
}
