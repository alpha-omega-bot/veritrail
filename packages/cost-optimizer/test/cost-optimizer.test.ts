import { describe, expect, it } from 'vitest';

import { detectSpendAnomalies } from '../src/anomaly.js';
import { forecast } from '../src/forecast.js';
import { recommendModelSwaps } from '../src/recommend.js';
import type { SpendSample } from '../src/types.js';

const dayMs = 86_400_000;

function makeSamples(
  start: number,
  dailyAmounts: ReadonlyArray<number>,
  model?: string,
): SpendSample[] {
  return dailyAmounts.map((amount, i) => ({
    atMs: start + i * dayMs,
    amountMinor: amount,
    ...(model !== undefined ? { model } : {}),
  }));
}

describe('forecast', () => {
  it('projects total spend with linear+EMA blend', () => {
    const start = 1_700_000_000_000;
    const samples = makeSamples(start, [1000, 1000, 1000, 1000, 1000]); // 5 days, $10/day
    const result = forecast({
      samples,
      periodStartMs: start,
      periodEndMs: start + 30 * dayMs,
      nowMs: start + 5 * dayMs,
    });
    expect(result).not.toBeNull();
    // Linear projection: $10/day * 30 days = $300 = 30,000 minor
    // EMA also stabilises to ~$10/day * 30 days = 30,000 minor
    // Blend: also ~30,000
    expect(result!.projectedTotalMinor).toBeGreaterThan(25_000);
    expect(result!.projectedTotalMinor).toBeLessThan(35_000);
    expect(result!.progress).toBeCloseTo(5 / 30, 3);
  });

  it('returns null when there are no samples', () => {
    const start = 1_700_000_000_000;
    const result = forecast({
      samples: [],
      periodStartMs: start,
      periodEndMs: start + dayMs,
      nowMs: start + 1,
    });
    expect(result).toBeNull();
  });

  it('returns null when progress is zero', () => {
    const start = 1_700_000_000_000;
    const result = forecast({
      samples: makeSamples(start, [100]),
      periodStartMs: start,
      periodEndMs: start + dayMs,
      nowMs: start,
    });
    expect(result).toBeNull();
  });
});

describe('detectSpendAnomalies', () => {
  it('flags a 10x spike against a steady baseline', () => {
    const start = 1_700_000_000_000;
    // 10 baseline days with slight variation (so MAD > 0), then a spike on day 11
    const amounts = [100, 110, 105, 95, 100, 115, 90, 100, 105, 100, 5_000];
    const samples = makeSamples(start, amounts);
    const anomalies = detectSpendAnomalies(samples, { minHistoryDays: 7, threshold: 3 });
    expect(anomalies.length).toBeGreaterThanOrEqual(1);
    expect(anomalies[0]?.amountMinor).toBe(5_000);
    expect(anomalies[0]?.zScore).toBeGreaterThan(3);
  });

  it('returns nothing when history is too short', () => {
    const start = 1_700_000_000_000;
    const samples = makeSamples(start, [100, 100, 5_000]);
    expect(detectSpendAnomalies(samples, { minHistoryDays: 7 })).toEqual([]);
  });

  it('returns nothing when there is no variance', () => {
    const start = 1_700_000_000_000;
    const samples = makeSamples(
      start,
      Array.from({ length: 10 }, () => 100),
    );
    expect(detectSpendAnomalies(samples)).toEqual([]);
  });
});

describe('recommendModelSwaps', () => {
  it('recommends Sonnet 4.6 when Opus 4.7 spend exceeds the threshold', () => {
    const start = 1_700_000_000_000;
    const samples = [
      ...makeSamples(start, [6_000], 'claude-opus-4-7'), // $60 in Opus
      ...makeSamples(start, [200], 'claude-sonnet-4-6'),
    ];
    const recs = recommendModelSwaps(samples, { minSpendUsd: 50 });
    expect(recs).toHaveLength(1);
    expect(recs[0]?.currentModel).toBe('claude-opus-4-7');
    expect(recs[0]?.recommendedModel).toBe('claude-sonnet-4-6');
    expect(recs[0]?.projectedSavingsMinor).toBeGreaterThan(0);
  });

  it('skips models that are below the threshold', () => {
    const start = 1_700_000_000_000;
    const samples = makeSamples(start, [100], 'claude-opus-4-7'); // $1 of Opus
    expect(recommendModelSwaps(samples, { minSpendUsd: 50 })).toEqual([]);
  });

  it('returns nothing when no model is in the swap table', () => {
    const start = 1_700_000_000_000;
    const samples = makeSamples(start, [10_000], 'some-private-model');
    expect(recommendModelSwaps(samples, { minSpendUsd: 50 })).toEqual([]);
  });
});
