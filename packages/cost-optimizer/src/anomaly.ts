import type { SpendSample } from './types.js';

export interface AnomalyOptions {
  /** Z-score threshold above which a daily total is flagged. Default: 3. */
  readonly threshold?: number;
  /** Minimum days of history required before any anomaly fires. Default: 7. */
  readonly minHistoryDays?: number;
}

export interface Anomaly {
  /** Day boundary (epoch ms, floored to midnight UTC). */
  readonly dayMs: number;
  /** Daily total spend in minor units. */
  readonly amountMinor: number;
  /** How many standard deviations above the mean (positive = high). */
  readonly zScore: number;
  /** Plain-English description for UI/alerts. */
  readonly summary: string;
}

/**
 * Median-based anomaly detection for daily spend. Classical Z-score is too
 * sensitive to outliers — using the median and MAD (median absolute deviation)
 * is more robust for spend series, which are often spiky.
 *
 * Returns the days that exceed `threshold` standard deviations above the
 * historical median.
 */
export function detectSpendAnomalies(
  samples: ReadonlyArray<SpendSample>,
  options: AnomalyOptions = {},
): ReadonlyArray<Anomaly> {
  const threshold = options.threshold ?? 3;
  const minHistory = options.minHistoryDays ?? 7;

  if (samples.length === 0) return [];

  // Bucket by UTC day
  const dailyMs = 86_400_000;
  const buckets = new Map<number, number>();
  for (const s of samples) {
    const day = Math.floor(s.atMs / dailyMs) * dailyMs;
    buckets.set(day, (buckets.get(day) ?? 0) + s.amountMinor);
  }
  const entries = [...buckets.entries()].sort((a, b) => a[0] - b[0]);
  if (entries.length < minHistory) return [];

  const values = entries.map(([, v]) => v);
  const median = quantile(values, 0.5);
  const mad = quantile(
    values.map((v) => Math.abs(v - median)),
    0.5,
  );

  // Robust z-score: 0.6745 is the constant that makes MAD a consistent
  // estimator of σ under a normal distribution.
  if (mad === 0) return [];
  const scale = mad / 0.6745;

  const anomalies: Anomaly[] = [];
  for (const [dayMs, amountMinor] of entries) {
    const z = (amountMinor - median) / scale;
    if (z >= threshold) {
      anomalies.push({
        dayMs,
        amountMinor,
        zScore: round(z, 2),
        summary: `Daily spend of $${(amountMinor / 100).toFixed(2)} is ${round(z, 1)}σ above the median ($${(median / 100).toFixed(2)}).`,
      });
    }
  }
  return anomalies;
}

function quantile(values: ReadonlyArray<number>, q: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  const pos = (sorted.length - 1) * q;
  const base = Math.floor(pos);
  const rest = pos - base;
  const next = sorted[base + 1];
  if (next !== undefined) {
    return sorted[base]! + rest * (next - sorted[base]!);
  }
  return sorted[base]!;
}

function round(n: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round(n * factor) / factor;
}
