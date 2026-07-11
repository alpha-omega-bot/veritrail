# @veritrail/cost-optimizer

**Predictive + prescriptive cost control for AI agent workloads.**

The Spend Guard module already hard-stops at your budget. This adds:

1. **Forecast** — project end-of-month total from spend so far this period (linear + EMA blend that doesn't get fooled by single-day spikes).
2. **Anomaly detection** — flag days where spend is more than N robust standard deviations above the median (median+MAD, not Z-score, so it handles spiky AI workloads).
3. **Model swap recommendations** — surface specific "swap Opus → Sonnet for $X savings" suggestions based on actual spend per model in your ledger.

## Use

```ts
import { forecast, detectSpendAnomalies, recommendModelSwaps } from '@veritrail/cost-optimizer';

const samples = events.map((e) => ({
  atMs: e.timestamp,
  amountMinor: e.payload.amount.minorUnits,
  model: e.payload.labels?.model,
}));

const projection = forecast({
  samples,
  periodStartMs: monthStart,
  periodEndMs: monthEnd,
});
if (projection && projection.projectedTotalMinor > budgetMinor) {
  alert(`On pace to overshoot budget by $${(projection.projectedTotalMinor - budgetMinor) / 100}`);
}

const anomalies = detectSpendAnomalies(samples);
for (const a of anomalies) console.warn(a.summary);

const swaps = recommendModelSwaps(samples);
for (const s of swaps) {
  console.log(
    `${s.currentModel} → ${s.recommendedModel}: save ~$${s.projectedSavingsMinor / 100}/period`,
  );
}
```

## Defaults are conservative

- Recommendations require ≥$50/period spend on the source model before they fire (no noise for trial workloads).
- Anomaly z-score threshold is 3σ above the median (≈99.7th percentile).
- Forecast requires non-zero period progress; otherwise returns `null` so the UI shows "insufficient data" rather than a fake number.

All thresholds are configurable.
