import type { SpendSample } from './types.js';

/**
 * Project end-of-month spend from the samples seen so far this period.
 *
 * The algorithm intentionally stays simple. Veritrail customers want
 * "will I overshoot my budget?" not a research-grade ARIMA model. We use:
 *
 *   - elapsed / total = period progress (0..1)
 *   - actualSpend / progress = naive linear projection
 *   - blend with EMA of recent daily spend rate to dampen one-day spikes
 *
 * Returns `null` when there is not enough data (no samples or zero progress)
 * — callers should display "insufficient data" rather than a fake number.
 */
export interface ForecastInput {
  /** Spend samples in chronological order (must be non-empty). */
  readonly samples: ReadonlyArray<SpendSample>;
  /** Current period start (epoch ms). */
  readonly periodStartMs: number;
  /** Current period end (epoch ms). */
  readonly periodEndMs: number;
  /** "Now" — defaults to Date.now(). Inject for tests. */
  readonly nowMs?: number;
}

export interface ForecastResult {
  /** Projected total spend at period end, in minor units (cents). */
  readonly projectedTotalMinor: number;
  /** Daily run-rate (minor units / day). */
  readonly dailyRateMinor: number;
  /** Period progress 0..1 used in the projection. */
  readonly progress: number;
  /** Total spent so far. */
  readonly actualTotalMinor: number;
}

export function forecast(input: ForecastInput): ForecastResult | null {
  const { samples, periodStartMs, periodEndMs } = input;
  const now = input.nowMs ?? Date.now();
  if (samples.length === 0) return null;
  if (periodEndMs <= periodStartMs) return null;

  const progress = Math.min(1, Math.max(0, (now - periodStartMs) / (periodEndMs - periodStartMs)));
  if (progress <= 0) return null;

  const actualTotalMinor = samples.reduce((sum, s) => sum + s.amountMinor, 0);

  // Linear projection assuming run rate continues
  const linearProjection = actualTotalMinor / progress;

  // EMA-smoothed daily rate (alpha = 0.3) — recent days weighted more
  const dailyMs = 86_400_000;
  const buckets = new Map<number, number>();
  for (const s of samples) {
    const day = Math.floor(s.atMs / dailyMs);
    buckets.set(day, (buckets.get(day) ?? 0) + s.amountMinor);
  }
  const days = [...buckets.keys()].sort((a, b) => a - b);
  let ema = 0;
  for (const day of days) {
    const value = buckets.get(day) ?? 0;
    ema = ema === 0 ? value : 0.3 * value + 0.7 * ema;
  }
  const periodDays = (periodEndMs - periodStartMs) / dailyMs;
  const emaProjection = ema * periodDays;

  // Blend 60/40 linear/EMA — linear is more accurate when usage is steady,
  // EMA cushions against single-day bursts dominating the early projection.
  const projectedTotalMinor = Math.round(0.6 * linearProjection + 0.4 * emaProjection);
  const dailyRateMinor = ema || actualTotalMinor / Math.max(1, days.length);

  return {
    projectedTotalMinor,
    dailyRateMinor: Math.round(dailyRateMinor),
    progress,
    actualTotalMinor,
  };
}
