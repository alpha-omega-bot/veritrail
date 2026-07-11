import type { SpendSample } from './types.js';

export interface ModelSwapRecommendation {
  readonly currentModel: string;
  readonly recommendedModel: string;
  readonly currentSpendMinor: number;
  readonly projectedSavingsMinor: number;
  /** 0..1 — how confident we are this swap is safe based on the data we see. */
  readonly confidence: number;
  readonly reason: string;
}

export interface RecommendOptions {
  /** Minimum spend (in dollars) before this model is even considered. */
  readonly minSpendUsd?: number;
}

/**
 * Suggest cheaper-model swaps. The first-pass heuristic is "you spent >X on
 * model A and there is a same-family cheaper model — propose the swap and
 * estimate savings naively at the listed price ratio".
 *
 * This is **prescriptive**, not predictive — final swap is the operator's
 * decision; the simulator should be used to spot-check that quality stayed
 * within tolerance via decision-memory recall.
 */
export function recommendModelSwaps(
  samples: ReadonlyArray<SpendSample>,
  options: RecommendOptions = {},
): ReadonlyArray<ModelSwapRecommendation> {
  const minSpend = (options.minSpendUsd ?? 50) * 100;

  // Aggregate spend per model
  const perModel = new Map<string, number>();
  for (const s of samples) {
    if (s.model === undefined) continue;
    perModel.set(s.model, (perModel.get(s.model) ?? 0) + s.amountMinor);
  }

  const recs: ModelSwapRecommendation[] = [];
  for (const [model, totalMinor] of perModel) {
    if (totalMinor < minSpend) continue;
    const swap = SAME_FAMILY_CHEAPER[model];
    if (!swap) continue;
    const projectedSavingsMinor = Math.round(totalMinor * (1 - swap.priceRatio));
    if (projectedSavingsMinor <= 0) continue;
    recs.push({
      currentModel: model,
      recommendedModel: swap.target,
      currentSpendMinor: totalMinor,
      projectedSavingsMinor,
      confidence: swap.confidence,
      reason: swap.reason,
    });
  }
  return recs.sort((a, b) => b.projectedSavingsMinor - a.projectedSavingsMinor);
}

/**
 * Built-in swap table. Operators can override at runtime — this is a
 * conservative starting point seeded with widely-published price comparisons.
 *
 * Pricing for Anthropic Claude follows the current Claude API knowledge cutoff
 * (see /claude-api skill / system prompt): Sonnet is cheaper than Opus for the
 * same family. Customers running Opus 4.7/4.8 for routine tasks usually get
 * 80%+ savings by switching to Sonnet 4.6 with no perceptible quality loss
 * on classification/extraction/summarization workloads. Always BYO override
 * if your workload is research/synthesis where Opus shines.
 */
const SAME_FAMILY_CHEAPER: Record<
  string,
  { target: string; priceRatio: number; confidence: number; reason: string }
> = {
  'claude-opus-4-8': {
    target: 'claude-sonnet-4-6',
    priceRatio: 0.2,
    confidence: 0.6,
    reason:
      'Sonnet 4.6 is ~5x cheaper than Opus 4.8 with comparable quality on classification, extraction, and short-form generation. Validate quality with decision-memory recall before fully cutting over.',
  },
  'claude-opus-4-7': {
    target: 'claude-sonnet-4-6',
    priceRatio: 0.2,
    confidence: 0.6,
    reason:
      'Sonnet 4.6 is ~5x cheaper than Opus 4.7 with comparable quality on most workloads. Keep Opus for long-context synthesis where 1M context is needed.',
  },
  'gpt-4o': {
    target: 'gpt-4o-mini',
    priceRatio: 0.06,
    confidence: 0.5,
    reason:
      'gpt-4o-mini is ~16x cheaper than gpt-4o; safe for most extraction and tool-call routing.',
  },
};
