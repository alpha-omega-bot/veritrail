import type { BudgetWindow } from '@veritrail/core';

/**
 * Fixed-length durations (in milliseconds) for each budget window, used to
 * compute the lower bound of the spend-accounting interval relative to "now".
 *
 * v1 approximation: `daily`/`weekly`/`monthly` are sliding windows of a fixed
 * length ending at `now`, NOT calendar-aligned boundaries. `monthly` is a flat
 * 30-day window regardless of the actual month length. `total` has no lower
 * bound (all history counts). This is intentional — see the README — and keeps
 * the projection deterministic and clock-agnostic.
 */
export const WINDOW_MS: Record<Exclude<BudgetWindow, 'total'>, number> = {
  daily: 86_400_000,
  weekly: 7 * 86_400_000,
  monthly: 30 * 86_400_000,
};

/**
 * Inclusive lower bound (epoch ms) for records that count toward a window's
 * spend, given the current time. Returns `0` for `total` (the whole history).
 */
export function windowStart(window: BudgetWindow, now: number): number {
  if (window === 'total') return 0;
  const span = WINDOW_MS[window];
  const start = now - span;
  return start < 0 ? 0 : start;
}

/** True when `timestamp` falls within the budget window relative to `now`. */
export function withinWindow(window: BudgetWindow, timestamp: number, now: number): boolean {
  return timestamp >= windowStart(window, now) && timestamp <= now;
}
