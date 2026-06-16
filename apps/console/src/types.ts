// Shared TypeScript interfaces mirroring the Veritrail server/module payloads.
// These are intentionally narrow and explicit so the read-only console can
// render predictably with either live API data or local mocks.

/** Result of verifying the append-only audit ledger. */
export interface AuditSummary {
  /** Total number of events recorded in the ledger. */
  totalEvents: number;
  /** Whether the hash chain verified end-to-end. */
  integrityOk: boolean;
  /** Hash of the most recent ledger entry (hex). */
  lastHash: string;
  /** ISO-8601 timestamp of the first recorded event, if any. */
  firstEventAt: string | null;
  /** ISO-8601 timestamp of the most recent event, if any. */
  lastEventAt: string | null;
  /** Number of distinct agents seen in the ledger. */
  distinctAgents: number;
}

/** Severity levels attached to ledger events. */
export type EventSeverity = 'info' | 'warn' | 'error' | 'critical';

/** A single append-only audit ledger entry. */
export interface LedgerEvent {
  /** Monotonic sequence number within the ledger. */
  seq: number;
  /** ISO-8601 timestamp the event was recorded. */
  timestamp: string;
  /** Dotted event type, e.g. "agent.tool.invoke". */
  type: string;
  /** Identifier of the agent that produced the event. */
  agentId: string;
  /** Correlation id linking related events across modules. */
  correlationId: string;
  severity: EventSeverity;
  /** This entry's content hash (hex). */
  hash: string;
  /** Hash of the previous entry, forming the chain (hex, null for genesis). */
  prevHash: string | null;
  /** Free-form structured payload describing what happened. */
  detail: string;
}

/** Response wrapper for a page of ledger events. */
export interface LedgerEventsResponse {
  events: LedgerEvent[];
  limit: number;
  total: number;
}

/** Lifecycle state of a tracked budget. */
export type BudgetState = 'ok' | 'warning' | 'exceeded';

/** Spend tracking for a single budget scope (agent, project, or org). */
export interface SpendStatus {
  /** Scope identifier, e.g. an agent id or project key. */
  scope: string;
  /** Human-readable scope label. */
  label: string;
  /** Hard budget limit in USD. */
  limitUsd: number;
  /** Amount spent so far in USD. */
  spentUsd: number;
  /** Remaining budget in USD (may be negative when exceeded). */
  remainingUsd: number;
  /** ISO-8601 period start. */
  periodStart: string;
  /** ISO-8601 period end. */
  periodEnd: string;
  state: BudgetState;
}

/** Wrapper for the spend status endpoint. */
export interface SpendStatusResponse {
  budgets: SpendStatus[];
  totalLimitUsd: number;
  totalSpentUsd: number;
}

/** Qualitative risk band derived from a numeric score. */
export type RiskBand = 'low' | 'moderate' | 'elevated' | 'high';

/** Risk assessment for a single external vendor / model provider. */
export interface VendorRiskScore {
  vendorId: string;
  name: string;
  /** Composite risk score 0–100 (higher is riskier). */
  score: number;
  band: RiskBand;
  /** Notable contributing factors to the score. */
  factors: string[];
  /** ISO-8601 timestamp of the most recent assessment. */
  assessedAt: string;
}

/** Wrapper for the vendor risk assessment endpoint. */
export interface VendorRiskResponse {
  vendors: VendorRiskScore[];
}

/** A single step in a forensic incident timeline. */
export interface IncidentTimelineEntry {
  timestamp: string;
  type: string;
  severity: EventSeverity;
  summary: string;
}

/** Reconstructed incident report for a correlation id. */
export interface IncidentReport {
  correlationId: string;
  /** Short title describing the incident. */
  title: string;
  /** ISO-8601 timestamp the incident opened. */
  openedAt: string;
  /** ISO-8601 timestamp the incident closed, if resolved. */
  closedAt: string | null;
  /** Agents implicated in the incident. */
  agents: string[];
  /** Highest severity observed across the timeline. */
  peakSeverity: EventSeverity;
  timeline: IncidentTimelineEntry[];
}

/** Health probe response. */
export interface HealthStatus {
  ok: boolean;
  version: string;
  uptimeSeconds: number;
}
