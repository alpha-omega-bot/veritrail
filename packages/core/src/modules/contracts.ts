import type { Ledger } from '../ledger/ledger.js';
import type { Clock } from '../ports/clock.js';
import type { IdGenerator } from '../ports/id.js';
import type { Logger } from '../ports/logger.js';

/** The eight governance capabilities the platform unifies. */
export type Capability =
  | 'audit'
  | 'permissions'
  | 'spend-guard'
  | 'rollback'
  | 'forensics'
  | 'evidence'
  | 'decision-memory'
  | 'vendor-risk';

export const CAPABILITIES: readonly Capability[] = [
  'audit',
  'permissions',
  'spend-guard',
  'rollback',
  'forensics',
  'evidence',
  'decision-memory',
  'vendor-risk',
] as const;

export interface ModuleInfo {
  readonly name: string;
  readonly version: string;
  readonly capability: Capability;
}

/**
 * Every governance engine implements `VeritrailModule`. This keeps the modules
 * uniform (discoverable, describable) and lets the server mount them generically.
 */
export interface VeritrailModule {
  readonly info: ModuleInfo;
}

/**
 * The shared dependency bundle every module is constructed with. Centralizing
 * this means all modules read/write the *same* ledger and observe the *same*
 * clock and logger — which is what makes the eight capabilities one coherent
 * system rather than eight independent tools.
 */
export interface ModuleContext {
  readonly ledger: Ledger;
  readonly clock: Clock;
  readonly ids: IdGenerator;
  readonly logger: Logger;
}
