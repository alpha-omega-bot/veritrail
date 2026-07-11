/**
 * Shared types for built-in destination adapters.
 *
 * Adapters consume `NotificationEvent` — a flattened, transport-ready view of a
 * Veritrail ledger fact enriched with a `severity` band. The webhook-worker is
 * expected to project full `EventInput` records into this shape before fan-out
 * so adapter code stays free of ledger-specific schema knowledge.
 */

/** Severity bands recognized by the built-in adapters. */
export type NotificationSeverity = 'critical' | 'error' | 'warn' | 'info';

/** Optional caller-supplied `fetch` implementation; defaults to the global. */
export type FetchImpl = typeof fetch;

/**
 * Wire-ready notification consumed by every destination adapter.
 *
 * `type` and `actorId` mirror the ledger envelope. `incidentId` is used to
 * build deep links into the Veritrail console when the destination supports
 * them (Slack "View incident", PagerDuty `links`).
 */
export interface NotificationEvent {
  readonly type: string;
  readonly actorId: string;
  readonly correlationId?: string;
  readonly causationId?: string;
  readonly severity?: NotificationSeverity;
  readonly occurredAt?: string;
  readonly message?: string;
  readonly incidentId?: string;
  readonly source?: string;
  readonly details?: Readonly<Record<string, unknown>>;
}
