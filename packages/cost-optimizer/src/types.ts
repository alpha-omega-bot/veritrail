/**
 * Minimal spend sample shape. The package is intentionally agnostic of the
 * Veritrail event model so it can be used over any projection, including
 * downstream warehouses (BigQuery, Snowflake) that already mirror the ledger.
 */
export interface SpendSample {
  /** When the spend was recorded (epoch ms). */
  readonly atMs: number;
  /** Amount in integer minor units (cents). */
  readonly amountMinor: number;
  /** Optional model identifier used for swap recommendations. */
  readonly model?: string;
  /** Optional scope (project / agent) for grouping in higher-level views. */
  readonly scope?: string;
}
