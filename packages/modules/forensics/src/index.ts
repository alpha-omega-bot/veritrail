/**
 * `@veritrail/forensics` — Incident Forensics engine (scaffold baseline).
 *
 * Reconstructs incident timelines and causal chains as read-only projections
 * over the single tamper-evident ledger. No separate store: every answer is
 * derived from ledger records on demand.
 */

export {
  ForensicsModule,
  createForensicsModule,
  type TimelineEntry,
  type IncidentReport,
  type BlastRadiusReport,
  type RootCauseCandidate,
} from './engine.js';
export { summarize } from './summarize.js';
