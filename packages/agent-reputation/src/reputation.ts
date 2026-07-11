/**
 * Computes a per-agent reputation profile from the tamper-evident Veritrail
 * ledger. The score blends behaviour signals (denial rate, incident count),
 * volume (total decisions), and longevity (verified-since).
 *
 * Non-spoofable: every input event is hash-chained, so the same profile can
 * be recomputed by anyone with read access to the ledger.
 */

import type { EventInput, LedgerReader, LedgerRecord } from '@veritrail/core';

/** Coarse UI band derived from the composite score. */
export type ReputationBadge = 'verified' | 'caution' | 'unverified';

/** A single signed adjustment that contributed to the composite score. */
export interface ReputationFactor {
  /** Short identifier for the factor (e.g. `low-denial-rate`). */
  readonly name: string;
  /** Signed contribution to the composite score. Positive values are bonuses. */
  readonly impact: number;
  /** Human-readable explanation suitable for display in a tooltip or row. */
  readonly reason: string;
}

/** Public reputation snapshot for one agent. */
export interface AgentReputationProfile {
  readonly agentId: string;
  /** Count of `decision.recorded` events authored by this agent. */
  readonly totalDecisions: number;
  /** Count of `action.proposed` events authored by this agent. */
  readonly totalActions: number;
  /** `denied / (denied + authorized)` in `[0, 1]`. Zero when neither has occurred. */
  readonly denialRate: number;
  /** Sum of `budget.charged.amount.amountMinor` attributed to this agent. */
  readonly spendUsdMinor: number;
  /**
   * Distinct `correlationId` values whose timeline includes a denial,
   * failure, or rollback event for this agent. Treated as a coarse proxy for
   * incidents.
   */
  readonly incidentCount: number;
  /** ISO-8601 timestamp of the agent's earliest observed event, or `""` if none. */
  readonly verifiedSince: string;
  /** Composite score in `[0, 100]`. Neutral baseline is `50`. */
  readonly score: number;
  /** Coarse badge derived from `score`. */
  readonly badge: ReputationBadge;
  /** Per-factor breakdown showing how each adjustment moved the score. */
  readonly factors: ReadonlyArray<ReputationFactor>;
}

/** Options for {@link computeReputation}. */
export interface ComputeReputationOptions {
  /** Agent envelope id to project over. */
  readonly agentId: string;
  /**
   * Override for the current time, in epoch milliseconds. Defaults to
   * `Date.now()`. Tests should pass an explicit value to keep results
   * deterministic.
   */
  readonly nowMs?: number;
}

const INCIDENT_EVENT_TYPES = new Set<EventInput['type']>([
  'action.denied',
  'action.failed',
  'action.rolled_back',
]);

const DAY_MS = 86_400_000;
const LONGEVITY_THRESHOLD_DAYS = 30;
const INCIDENT_PENALTY_PER_EVENT = 6;
const INCIDENT_PENALTY_CAP = 30;
const NEUTRAL_SCORE = 50;
const VERIFIED_SCORE = 80;
const CAUTION_SCORE = 30;

interface Accumulator {
  totalDecisions: number;
  totalActions: number;
  authorized: number;
  denied: number;
  spendUsdMinor: number;
  incidentCorrelations: Set<string>;
  firstAt: number | null;
}

function emptyAccumulator(): Accumulator {
  return {
    totalDecisions: 0,
    totalActions: 0,
    authorized: 0,
    denied: 0,
    spendUsdMinor: 0,
    incidentCorrelations: new Set<string>(),
    firstAt: null,
  };
}

function accumulate(state: Accumulator, record: LedgerRecord): Accumulator {
  if (state.firstAt === null || record.timestamp < state.firstAt) {
    state.firstAt = record.timestamp;
  }
  const event = record.event;
  switch (event.type) {
    case 'decision.recorded':
      state.totalDecisions += 1;
      return state;
    case 'action.proposed':
      state.totalActions += 1;
      return state;
    case 'action.authorized':
      state.authorized += 1;
      return state;
    case 'action.denied':
      state.denied += 1;
      if (event.correlationId !== undefined) {
        state.incidentCorrelations.add(event.correlationId);
      }
      return state;
    case 'action.failed':
    case 'action.rolled_back':
      if (event.correlationId !== undefined) {
        state.incidentCorrelations.add(event.correlationId);
      }
      return state;
    case 'budget.charged':
      state.spendUsdMinor += event.payload.amount.amountMinor;
      return state;
    default:
      if (INCIDENT_EVENT_TYPES.has(event.type) && event.correlationId !== undefined) {
        state.incidentCorrelations.add(event.correlationId);
      }
      return state;
  }
}

/**
 * Compute the agent's reputation profile by replaying every ledger event
 * whose envelope `actorId` matches `agentId`. The function is deterministic:
 * identical inputs always produce identical output, which is what makes the
 * score externally verifiable.
 */
export async function computeReputation(
  ledger: LedgerReader,
  options: ComputeReputationOptions,
): Promise<AgentReputationProfile> {
  const { agentId } = options;
  const now = options.nowMs ?? Date.now();

  const records = await ledger.query({ actorId: agentId });

  const state = emptyAccumulator();
  for (const record of records) {
    accumulate(state, record);
  }

  const totalDecided = state.authorized + state.denied;
  const denialRate = totalDecided === 0 ? 0 : state.denied / totalDecided;
  const incidentCount = state.incidentCorrelations.size;

  const factors: ReputationFactor[] = [];
  let score = NEUTRAL_SCORE;

  if (totalDecided > 0 && denialRate < 0.05) {
    const impact = 10;
    factors.push({
      name: 'low-denial-rate',
      impact,
      reason: `Denial rate ${(denialRate * 100).toFixed(1)}% is below the 5% well-behaved threshold.`,
    });
    score += impact;
  }
  if (denialRate > 0.3) {
    const impact = -20;
    factors.push({
      name: 'high-denial-rate',
      impact,
      reason: `Denial rate ${(denialRate * 100).toFixed(1)}% exceeds the 30% caution threshold.`,
    });
    score += impact;
  }
  if (state.totalDecisions > 100) {
    const impact = 10;
    factors.push({
      name: 'sufficient-track-record',
      impact,
      reason: `${state.totalDecisions} recorded decisions establish a sufficient track record.`,
    });
    score += impact;
  }
  if (incidentCount > 0) {
    const impact = -Math.min(INCIDENT_PENALTY_CAP, incidentCount * INCIDENT_PENALTY_PER_EVENT);
    factors.push({
      name: 'incidents-on-record',
      impact,
      reason: `${incidentCount} distinct incident correlation${incidentCount === 1 ? '' : 's'} recorded.`,
    });
    score += impact;
  }
  if (state.firstAt !== null && now - state.firstAt > LONGEVITY_THRESHOLD_DAYS * DAY_MS) {
    const impact = 5;
    factors.push({
      name: 'longevity-bonus',
      impact,
      reason: 'Agent has been observed for more than 30 days.',
    });
    score += impact;
  }

  score = Math.max(0, Math.min(100, score));

  const badge: ReputationBadge =
    score >= VERIFIED_SCORE ? 'verified' : score <= CAUTION_SCORE ? 'caution' : 'unverified';

  return {
    agentId,
    totalDecisions: state.totalDecisions,
    totalActions: state.totalActions,
    denialRate,
    spendUsdMinor: state.spendUsdMinor,
    incidentCount,
    verifiedSince: state.firstAt === null ? '' : new Date(state.firstAt).toISOString(),
    score,
    badge,
    factors,
  };
}
