/**
 * Compute the next-attempt delay for a webhook delivery in milliseconds.
 *
 *   - base = 1000ms
 *   - factor = 2 → exponential growth
 *   - jitter ~ 20% (deterministic via the index) to avoid thundering herds
 *   - cap = 24h (86_400_000ms)
 *
 * Attempt 1 → ~1s, 2 → ~2s, 3 → ~4s, ... 17 → 24h. Subsequent attempts stay
 * capped at 24h.
 */
const BASE_MS = 1000;
const FACTOR = 2;
const CAP_MS = 24 * 60 * 60 * 1000;

export function nextAttemptDelay(attempt: number): number {
  if (attempt < 0 || !Number.isFinite(attempt)) return BASE_MS;
  const ideal = Math.min(CAP_MS, BASE_MS * FACTOR ** attempt);
  // Deterministic jitter: a tiny pseudo-random offset derived from `attempt`
  // alone so tests stay reproducible. Range: ±20% of `ideal`.
  const jitter = (((attempt * 2654435761) >>> 0) % 1000) / 1000; // [0, 1)
  const offset = ideal * (jitter - 0.5) * 0.4;
  return Math.max(0, Math.round(ideal + offset));
}
