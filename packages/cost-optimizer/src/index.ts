/**
 * @veritrail/cost-optimizer
 *
 * Projects month-end spend, flags daily anomalies, and recommends cheaper-
 * model swaps over the existing Veritrail spend events. Directly closes the
 * loop from "you're about to overshoot" to "here's the one-click fix".
 *
 * All math is small, transparent, and deterministic — no external service,
 * no opaque model. Callers feed in spend samples; the package returns
 * structured forecasts, anomalies, and swap recommendations.
 */

export { forecast, type ForecastInput, type ForecastResult } from './forecast.js';
export { detectSpendAnomalies, type Anomaly, type AnomalyOptions } from './anomaly.js';
export {
  recommendModelSwaps,
  type ModelSwapRecommendation,
  type RecommendOptions,
} from './recommend.js';
export type { SpendSample } from './types.js';
