/**
 * @veritrail/policy-simulator
 *
 * "Pre-crime" replay engine. Given a proposed policy set, replay it against
 * the actual recorded history of `action.*` events on the ledger and report
 * what *would have* happened. This lets security teams ship policy changes
 * with confidence instead of guessing.
 *
 * The replay is provably accurate because:
 *   1. It reads the tamper-evident ledger directly (no sampling, no logs).
 *   2. The same `evaluate()` function used in production decides each replay.
 *
 * No competitor without a hash-chained ledger can promise this.
 */

export {
  simulatePolicies,
  type SimulateOptions,
  type SimulationResult,
  type ReplayDecision,
  type ReplayDiff,
  type BlastRadius,
} from './replay.js';
