import { Ledger, type LedgerOptions } from './ledger/ledger.js';
import { FileEventStore } from './storage/file-store.js';
import { InMemoryEventStore } from './storage/memory-store.js';

/** Create a ledger backed by a volatile in-memory store (tests, ephemeral usage). */
export function createInMemoryLedger(options: Omit<LedgerOptions, 'store'> = {}): Ledger {
  return new Ledger({ ...options, store: new InMemoryEventStore() });
}

/** Create a ledger backed by a durable append-only JSON Lines file. */
export async function createFileLedger(
  path: string,
  options: Omit<LedgerOptions, 'store'> = {},
): Promise<Ledger> {
  const store = await FileEventStore.open(path);
  return new Ledger({ ...options, store });
}
