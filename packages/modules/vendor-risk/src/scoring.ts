import type {
  Vendor,
  VendorSignal,
  VendorCriticality,
  VendorSignalSeverity,
} from '@veritrail/core';

/** Coarse risk classification derived from a numeric score. */
export type RiskBand = 'low' | 'medium' | 'high' | 'critical';

/** The computed risk position of a single vendor at a point in time. */
export interface VendorRiskScore {
  vendorId: string;
  name: string;
  /** Non-negative, rounded composite risk score. Higher is worse. */
  score: number;
  band: RiskBand;
  signalCount: number;
  /** Up to three highest-severity signals contributing to the score. */
  topSignals: VendorSignal[];
}

/** Baseline risk contributed by a vendor's declared criticality. */
const CRITICALITY_BASE: Record<VendorCriticality, number> = {
  low: 5,
  medium: 10,
  high: 20,
  critical: 35,
};

/** Per-signal weight by severity. */
const SEVERITY_WEIGHT: Record<VendorSignalSeverity, number> = {
  info: 1,
  low: 2,
  medium: 5,
  high: 10,
  critical: 20,
};

const DAY_MS = 86_400_000;
/** Risk half-life: a signal's contribution halves every 30 days. */
const HALF_LIFE_DAYS = 30;

/** Order severities so the most severe signals can be ranked first. */
const SEVERITY_RANK: Record<VendorSignalSeverity, number> = {
  info: 0,
  low: 1,
  medium: 2,
  high: 3,
  critical: 4,
};

/** Map a numeric score to a risk band. */
export function bandFor(score: number): RiskBand {
  if (score < 20) return 'low';
  if (score < 50) return 'medium';
  if (score < 100) return 'high';
  return 'critical';
}

/** Time-decay multiplier for a signal observed `ageDays` ago. */
function decay(ageDays: number): number {
  return Math.pow(0.5, ageDays / HALF_LIFE_DAYS);
}

/**
 * Compute a vendor's time-decayed risk score.
 *
 * `score = criticalityBase + Σ severityWeight(signal) * decay(ageDays(signal))`,
 * where age is measured from the signal's ledger timestamp to `now`.
 */
export function computeScore(
  vendor: Vendor,
  signals: ReadonlyArray<{ signal: VendorSignal; timestamp: number }>,
  now: number,
): VendorRiskScore {
  let total = CRITICALITY_BASE[vendor.criticality];
  for (const { signal, timestamp } of signals) {
    const ageDays = Math.max(0, (now - timestamp) / DAY_MS);
    total += SEVERITY_WEIGHT[signal.severity] * decay(ageDays);
  }
  const score = Math.round(total);

  const topSignals = [...signals]
    .sort((a, b) => SEVERITY_RANK[b.signal.severity] - SEVERITY_RANK[a.signal.severity])
    .slice(0, 3)
    .map((s) => s.signal);

  return {
    vendorId: vendor.id,
    name: vendor.name,
    score,
    band: bandFor(score),
    signalCount: signals.length,
    topSignals,
  };
}
