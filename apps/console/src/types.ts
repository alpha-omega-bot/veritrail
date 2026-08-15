// TypeScript interfaces mirroring the actual `@veritrail/server` REST payloads.
//
// These are derived from the server's real response shapes — see
// `packages/server/src/app.ts` and the module engines it delegates to. Two
// conventions matter and are easy to get wrong:
//
//   1. Every timestamp is an epoch-millisecond `number`, never an ISO string.
//   2. Collection endpoints return bare JSON arrays, not `{ items: [...] }`
//      envelopes, and carry no pagination metadata.
//
// Money is always integer minor units (cents) plus an ISO-4217 currency — there
// are no floating-point amounts anywhere in the API.

/** An ISO-4217 currency amount in integer minor units (e.g. cents). */
export interface Money {
  /** Three-letter ISO-4217 code, e.g. `USD`. */
  currency: string;
  /** Amount in minor units. Integer; may be negative. */
  amountMinor: number;
}

/** The closed set of event types the ledger accepts. */
export type EventType =
  | 'action.proposed'
  | 'action.authorized'
  | 'action.denied'
  | 'action.executed'
  | 'action.failed'
  | 'action.rolled_back'
  | 'decision.recorded'
  | 'evidence.attached'
  | 'policy.evaluated'
  | 'budget.charged'
  | 'budget.exceeded'
  | 'admin.action'
  | 'vendor.registered'
  | 'vendor.signal'
  | 'note';

/**
 * The event envelope stored inside a ledger record. `payload` is intentionally
 * left as an opaque record: it is a discriminated union keyed on `type`, and the
 * console only ever renders it as formatted JSON.
 */
export interface EventInput {
  type: EventType;
  actorId: string;
  correlationId?: string;
  causationId?: string;
  /** Always present; defaults to `{}` server-side. */
  labels: Record<string, string>;
  /** Optional source-system time, epoch ms. Distinct from record `timestamp`. */
  occurredAt?: number;
  payload: Record<string, unknown>;
}

/**
 * One append-only ledger entry, as returned by `GET /api/audit/events`.
 * `prevHash` is always a string — the genesis record points at a constant
 * genesis hash rather than `null`.
 */
export interface LedgerRecord {
  /** 1-based, contiguous, monotonic sequence number. */
  seq: number;
  id: string;
  /** Ledger receipt time, epoch ms. This is the authoritative timestamp. */
  timestamp: number;
  event: EventInput;
  prevHash: string;
  hash: string;
  /** Present only when the server is configured with a signing secret. */
  signature?: string;
  signerKeyId?: string;
}

/** Aggregate ledger state from `GET /api/audit/summary`. */
export interface AuditSummary {
  totalRecords: number;
  /** Hash of the chain head, or `null` when the ledger is empty. */
  head: string | null;
  integrityOk: boolean;
  /** Histogram of records keyed by event type. */
  countsByType: Record<string, number>;
  /** Number of distinct actor ids seen. */
  actorCount: number;
  /** Epoch ms of the first record, or `null` when empty. */
  firstAt: number | null;
  /** Epoch ms of the most recent record, or `null` when empty. */
  lastAt: number | null;
}

/** A single integrity violation reported by `GET /api/audit/verify`. */
export interface IntegrityIssue {
  seq: number;
  kind: string;
  detail: string;
}

/** Full chain verification result from `GET /api/audit/verify`. */
export interface IntegrityReport {
  ok: boolean;
  checked: number;
  head: string | null;
  issues: IntegrityIssue[];
}

/** How a budget's scope is matched against incoming charges. */
export interface BudgetScope {
  kind: 'global' | 'actor' | 'label';
  /** `''` for global, an actor id for `actor`, `key=value` for `label`. */
  value: string;
}

/** Rolling window a budget's limit applies over. */
export type BudgetWindow = 'total' | 'daily' | 'weekly' | 'monthly';

/** A configured spend budget. */
export interface Budget {
  id: string;
  name: string;
  scope: BudgetScope;
  limit: Money;
  window: BudgetWindow;
  /** When true, charges past the limit are rejected rather than warned about. */
  hardStop: boolean;
  enabled: boolean;
  createdAt?: number;
}

/** Per-budget spend projection from `GET /api/spend/status`. */
export interface SpendStatus {
  budget: Budget;
  spent: Money;
  /** `limit - spent`. Negative once a soft budget is overspent. */
  remaining: Money;
  /** True once spend has passed the limit. */
  exceeded: boolean;
}

/** Qualitative vendor risk band. Note: `medium`, not `moderate`/`elevated`. */
export type RiskBand = 'low' | 'medium' | 'high' | 'critical';

/** Kinds of observation that feed a vendor's risk score. */
export type VendorSignalKind =
  | 'incident'
  | 'breach'
  | 'degradation'
  | 'policy_change'
  | 'certification'
  | 'deprecation'
  | 'availability'
  | 'other';

/** Severity attached to a vendor signal. */
export type VendorSignalSeverity = 'info' | 'low' | 'medium' | 'high' | 'critical';

/** A single observed vendor risk signal. */
export interface VendorSignal {
  id: string;
  vendorId: string;
  kind: VendorSignalKind;
  severity: VendorSignalSeverity;
  summary: string;
  source: string;
  /** Epoch ms. */
  observedAt?: number;
}

/**
 * Vendor risk assessment from `GET /api/vendor-risk/assess`, returned sorted by
 * `score` descending. `score` is an unbounded non-negative number — it is *not*
 * a 0–100 percentage, so never render it as `score/100`.
 */
export interface VendorRiskScore {
  vendorId: string;
  name: string;
  score: number;
  band: RiskBand;
  signalCount: number;
  /** Up to three highest-severity signals. */
  topSignals: VendorSignal[];
}

/** One step in a reconstructed incident timeline. */
export interface TimelineEntry {
  seq: number;
  /** Epoch ms, taken from the ledger record's receipt time. */
  at: number;
  type: string;
  actorId: string;
  /** Human-readable summary generated server-side. */
  summary: string;
}

/**
 * Incident reconstruction from `GET /api/forensics/incident`. An unknown
 * correlation id yields HTTP 200 with empty collections rather than a 404, so
 * callers must treat "no entries" as a valid, non-error result.
 */
export interface IncidentReport {
  correlationId: string;
  entries: TimelineEntry[];
  /** Distinct actor ids, in first-seen order. */
  actors: string[];
  /** Histogram keyed by event type. */
  counts: Record<string, number>;
  failures: number;
  denials: number;
  rollbacks: number;
  firstAt: number | null;
  lastAt: number | null;
}

/** Unauthenticated liveness probe from `GET /api/health`. */
export interface HealthStatus {
  status: string;
  name: string;
  version: string;
  /** Process uptime in milliseconds. */
  uptimeMs: number;
}

/** The error envelope every failing endpoint returns. */
export interface ApiErrorBody {
  error: {
    name: string;
    code: string;
    message: string;
    details?: unknown;
  };
}
