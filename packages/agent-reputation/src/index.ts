/**
 * @veritrail/agent-reputation
 *
 * Per-agent reputation projection over the tamper-evident Veritrail ledger.
 *
 * Every agent earns a public, non-spoofable score derived from its own
 * append-only history: number of decisions, denial vs. authorization rate,
 * spend, distinct incident correlations, and longevity. The composite is
 * bounded `0..100`, bucketed into a three-state badge for at-a-glance UI,
 * and accompanied by a transparent factor list so callers can explain the
 * score to end users.
 *
 * This package is a read-only projection; it never appends to the ledger and
 * holds no state of its own. Identical input always produces identical
 * output, which is what makes the score externally auditable.
 */

export {
  computeReputation,
  type AgentReputationProfile,
  type ComputeReputationOptions,
  type ReputationBadge,
  type ReputationFactor,
} from './reputation.js';
