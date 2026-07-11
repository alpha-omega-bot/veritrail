// Typed REST client over the Veritrail server API (mounted at `/api`, proxied
// to :8787 in dev). Calls fall back to local sample data when the API is
// unavailable so the console can render standalone.

import {
  mockAuditSummary,
  mockHealth,
  mockIncidentReports,
  mockLedgerEventsResponse,
  mockSpendStatus,
  mockVendorRisk,
} from './mocks.ts';
import { readLabelScope, readSessionToken, type Session } from './auth/AuthContext.tsx';
import { useEffect, useState } from 'react';
import type {
  AuditSummary,
  HealthStatus,
  IncidentReport,
  LedgerEventsResponse,
  SpendStatusResponse,
  VendorRiskResponse,
} from './types.ts';

const API_BASE = '/api';

/** Build the headers we attach to every request. */
function defaultHeaders(extra?: Record<string, string>): Record<string, string> {
  const token = readSessionToken();
  return {
    Accept: 'application/json',
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    ...(extra ?? {}),
  };
}

/** Append the active project label-scope as `?label.org=...&label.project=...`. */
function withScope(path: string): string {
  const scope = readLabelScope();
  if (!scope) return path;
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(scope)) params.append(`label.${key}`, value);
  return path.includes('?') ? `${path}&${params}` : `${path}?${params}`;
}

// Simple in-memory cache for GET requests (5 minute TTL)
const cache = new Map<string, { data: unknown; timestamp: number }>();
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

function getCached<T>(key: string): T | null {
  const cached = cache.get(key);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
    return cached.data as T;
  }
  cache.delete(key);
  return null;
}

function setCache<T>(key: string, data: T): void {
  cache.set(key, { data, timestamp: Date.now() });
}

/** Result of a single async data fetch consumed by the useAsync hook. */
export interface AsyncState<T> {
  data: T | null;
  loading: boolean;
  error: string | null;
  /** True when the value came from local sample data. */
  fromMock: boolean;
}

interface FetchOutcome<T> {
  data: T;
  fromMock: boolean;
}

async function getJson<T>(path: string, fallback: T): Promise<FetchOutcome<T>> {
  // Check cache first
  const cached = getCached<T>(path);
  if (cached !== null) {
    return { data: cached, fromMock: false };
  }

  try {
    const res = await fetch(`${API_BASE}${withScope(path)}`, {
      headers: defaultHeaders(),
    });
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`);
    }
    const data = (await res.json()) as T;
    setCache(path, data);
    return { data, fromMock: false };
  } catch {
    // Standalone / offline mode: serve local sample data instead of failing.
    return { data: fallback, fromMock: true };
  }
}

async function postJson<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    method: 'POST',
    headers: defaultHeaders({ 'content-type': 'application/json' }),
    body: JSON.stringify(body),
  });
  return parseJsonResponse<T>(res);
}

/** GET a JSON endpoint, throwing on any non-2xx (no sample-data fallback). */
async function getJsonStrict<T>(path: string): Promise<T> {
  const res = await fetch(`${API_BASE}${withScope(path)}`, {
    headers: defaultHeaders(),
  });
  return parseJsonResponse<T>(res);
}

/** Shared response decoder: surfaces the server's structured error message. */
async function parseJsonResponse<T>(res: Response): Promise<T> {
  const text = await res.text();
  let json: unknown;
  try {
    json = text ? JSON.parse(text) : undefined;
  } catch {
    if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
    throw new Error('Expected JSON response');
  }
  if (!res.ok) {
    const message =
      (json as { error?: { message?: string } } | undefined)?.error?.message ?? res.statusText;
    throw new Error(message || `HTTP ${res.status}`);
  }
  return json as T;
}

/** Request a magic-link email be sent. The server hides whether the email exists. */
export async function requestMagicLink(email: string): Promise<void> {
  await postJson<{ ok: true }>('/v1/control/magic-link/request', { email });
}

/** Exchange a magic-link token for a session. */
export async function consumeMagicLink(token: string): Promise<Session> {
  return postJson<Session>('/v1/control/magic-link/consume', { token });
}

export interface ApiKeyPreview {
  readonly id: string;
  readonly prefix: string;
  readonly label: string;
  readonly createdAt: number;
  readonly lastUsedAt: number | null;
  readonly revokedAt: number | null;
}

export interface ApiKeyCreated {
  readonly key: string;
  readonly record: ApiKeyPreview;
}

export async function listApiKeys(projectId: string): Promise<ApiKeyPreview[]> {
  return postJson<ApiKeyPreview[]>('/v1/control/api-keys/list', { projectId });
}

export async function createApiKey(projectId: string, label: string): Promise<ApiKeyCreated> {
  return postJson<ApiKeyCreated>('/v1/control/api-keys/create', { projectId, label });
}

export async function revokeApiKey(id: string): Promise<{ ok: true }> {
  return postJson<{ ok: true }>('/v1/control/api-keys/revoke', { id });
}

export interface WebhookPreview {
  readonly id: string;
  readonly url: string;
  readonly eventsFilter: string;
  readonly status: string;
  readonly createdAt: number;
}

export interface WebhookCreated {
  readonly secret: string;
  readonly record: WebhookPreview;
}

export async function listWebhooks(projectId: string): Promise<WebhookPreview[]> {
  return postJson<WebhookPreview[]>('/v1/control/webhooks/list', { projectId });
}

export async function createWebhook(
  projectId: string,
  url: string,
  eventsFilter: string,
): Promise<WebhookCreated> {
  return postJson<WebhookCreated>('/v1/control/webhooks/create', {
    projectId,
    url,
    eventsFilter,
  });
}

export async function pauseWebhook(id: string): Promise<{ ok: true }> {
  return postJson<{ ok: true }>('/v1/control/webhooks/pause', { id });
}

export async function resumeWebhook(id: string): Promise<{ ok: true }> {
  return postJson<{ ok: true }>('/v1/control/webhooks/resume', { id });
}

export async function deleteWebhook(id: string): Promise<{ ok: true }> {
  return postJson<{ ok: true }>('/v1/control/webhooks/delete', { id });
}

export interface UsageSummary {
  readonly tier: string;
  readonly usage: number;
  readonly limit: number;
  readonly periodStart: number;
  readonly periodEnd: number;
}

export async function getUsage(): Promise<UsageSummary> {
  return postJson<UsageSummary>('/v1/control/usage', {});
}

/** Start a Stripe Checkout session for an upgrade. Returns the URL to redirect to. */
export async function startCheckout(orgId: string, tier: string): Promise<{ url: string }> {
  return postJson<{ url: string }>('/v1/control/billing/checkout', { orgId, tier });
}

export interface SpendForecastResult {
  readonly projectedTotalMinor: number;
  readonly dailyRateMinor: number;
  readonly progress: number;
  readonly actualTotalMinor: number;
}

export interface SpendAnomaly {
  readonly dayMs: number;
  readonly amountMinor: number;
  readonly zScore: number;
  readonly summary: string;
}

export interface ModelSwapRecommendation {
  readonly currentModel: string;
  readonly recommendedModel: string;
  readonly currentSpendMinor: number;
  readonly projectedSavingsMinor: number;
  readonly confidence: number;
  readonly reason: string;
}

export interface CostForecastResponse {
  readonly forecast: SpendForecastResult | null;
  readonly anomalies: ReadonlyArray<SpendAnomaly>;
  readonly recommendations: ReadonlyArray<ModelSwapRecommendation>;
}

export async function getCostForecast(
  periodStartMs: number,
  periodEndMs: number,
): Promise<CostForecastResponse> {
  return postJson<CostForecastResponse>('/v1/cost-optimizer/forecast', {
    periodStartMs,
    periodEndMs,
  });
}

export interface ComplianceFramework {
  readonly id: string;
  readonly name: string;
  readonly version: string;
}

export interface ComplianceControlRow {
  readonly id: string;
  readonly name: string;
  readonly severity: 'critical' | 'high' | 'medium' | 'low' | string;
  readonly evidenceCount: number;
  readonly status: 'pass' | 'fail' | 'partial' | 'not_applicable' | string;
}

export interface ComplianceReport {
  readonly frameworkId: string;
  readonly frameworkName: string;
  readonly frameworkVersion: string;
  readonly generatedAt: number;
  readonly scorePercent: number;
  readonly controls: ReadonlyArray<ComplianceControlRow>;
  readonly markdown: string;
}

export async function listFrameworks(): Promise<ComplianceFramework[]> {
  const res = await getJsonStrict<{ frameworks?: ComplianceFramework[] }>(
    '/v1/compliance/frameworks',
  );
  return res.frameworks ?? [];
}

/** Server-side shape of the compliance report (see compliance-routes.ts). */
interface ServerComplianceReport {
  readonly framework: { readonly id: string; readonly name: string; readonly version: string };
  readonly generatedAtMs: number;
  readonly fromMs: number;
  readonly toMs: number;
  readonly evidence: ReadonlyArray<{
    readonly controlId: string;
    readonly name: string;
    readonly severity: string;
    readonly satisfied: boolean;
    readonly evidenceCount: number;
  }>;
  readonly markdown: string;
  readonly scorePercent: number;
}

/** Map a per-control evidence row to the console's pass/partial/fail status. */
function controlStatus(satisfied: boolean, evidenceCount: number): ComplianceControlRow['status'] {
  if (satisfied) return 'pass';
  return evidenceCount > 0 ? 'partial' : 'fail';
}

export async function generateComplianceReport(
  frameworkId: string,
  fromMs?: number,
  toMs?: number,
): Promise<ComplianceReport> {
  const raw = await postJson<ServerComplianceReport>('/v1/compliance/report', {
    frameworkId,
    fromMs,
    toMs,
  });
  return {
    frameworkId: raw.framework.id,
    frameworkName: raw.framework.name,
    frameworkVersion: raw.framework.version,
    generatedAt: raw.generatedAtMs,
    scorePercent: raw.scorePercent,
    controls: raw.evidence.map((e) => ({
      id: e.controlId,
      name: e.name,
      severity: e.severity,
      evidenceCount: e.evidenceCount,
      status: controlStatus(e.satisfied, e.evidenceCount),
    })),
    markdown: raw.markdown,
  };
}

export function getHealth(): Promise<FetchOutcome<HealthStatus>> {
  return getJson('/health', mockHealth);
}

export function getAuditSummary(): Promise<FetchOutcome<AuditSummary>> {
  return getJson('/audit/summary', mockAuditSummary);
}

export function getLedgerEvents(limit = 50): Promise<FetchOutcome<LedgerEventsResponse>> {
  return getJson(`/audit/events?limit=${encodeURIComponent(limit)}`, mockLedgerEventsResponse);
}

export function getSpendStatus(): Promise<FetchOutcome<SpendStatusResponse>> {
  return getJson('/spend/status', mockSpendStatus);
}

export function getVendorRisk(): Promise<FetchOutcome<VendorRiskResponse>> {
  return getJson('/vendor-risk/assess', mockVendorRisk);
}

export function getIncident(correlationId: string): Promise<FetchOutcome<IncidentReport>> {
  const fallback: IncidentReport = mockIncidentReports[correlationId] ?? {
    correlationId,
    title: `No reconstructable incident for ${correlationId}`,
    openedAt: new Date().toISOString(),
    closedAt: null,
    agents: [],
    peakSeverity: 'info',
    timeline: [],
  };
  return getJson(
    `/forensics/incident?correlationId=${encodeURIComponent(correlationId)}`,
    fallback,
  );
}

export interface AnchorHead {
  readonly anchorId: string;
  readonly seq: number;
  readonly headHash: string;
}

export interface ReceiptEvent {
  readonly seq: number;
  readonly id: string;
}

export interface ReceiptAnchor {
  readonly headHash: string;
}

export interface Receipt {
  readonly event: ReceiptEvent;
  readonly chain: ReadonlyArray<unknown>;
  readonly anchor: ReceiptAnchor;
}

export interface ReceiptVerifyResult {
  readonly ok: boolean;
  readonly failures?: ReadonlyArray<string>;
}

export async function publishAnchor(): Promise<AnchorHead> {
  return postJson<AnchorHead>('/v1/receipt/anchor', {});
}

export interface RcaCausalContributor {
  readonly description: string;
  readonly weight?: number;
  readonly evidenceRef?: string;
}

export interface RcaRecommendation {
  readonly title: string;
  readonly detail?: string;
  readonly priority?: string;
}

export interface RcaReport {
  readonly headline: string;
  readonly summary: string;
  readonly confidence: number;
  readonly causalContributors: ReadonlyArray<RcaCausalContributor>;
  readonly proposedFix?: unknown;
  readonly recommendations: ReadonlyArray<RcaRecommendation>;
}

export interface RcaAnalyzeResponse {
  readonly report: RcaReport;
}

export class AiBackendUnavailableError extends Error {
  constructor(message = 'AI backend not configured') {
    super(message);
    this.name = 'AiBackendUnavailableError';
  }
}

export async function analyzeIncident(
  correlationId: string,
  operatorContext?: string,
): Promise<RcaAnalyzeResponse> {
  const res = await fetch(`${API_BASE}/v1/rca/analyze`, {
    method: 'POST',
    headers: defaultHeaders({ 'content-type': 'application/json' }),
    body: JSON.stringify({ correlationId, operatorContext }),
  });
  if (res.status === 503) {
    throw new AiBackendUnavailableError();
  }
  const text = await res.text();
  let json: unknown;
  try {
    json = text ? JSON.parse(text) : undefined;
  } catch {
    if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
    throw new Error('Expected JSON response');
  }
  if (!res.ok) {
    const message =
      (json as { error?: { message?: string } } | undefined)?.error?.message ?? res.statusText;
    throw new Error(message || `HTTP ${res.status}`);
  }
  return json as RcaAnalyzeResponse;
}

export interface SimulationDeniedSample {
  readonly actorId: string;
  readonly action: { readonly type: string };
  readonly originalEffect: string;
  readonly proposedEffect: string;
}

export interface SimulationResult {
  readonly metrics: {
    readonly eventsReplayed: number;
    readonly eventsChanged: number;
    readonly affectedActorCount: number;
    readonly affectedActionTypeCount: number;
    readonly changeRate: number;
  };
  readonly newlyDeniedSamples: ReadonlyArray<SimulationDeniedSample>;
  readonly diff: unknown;
}

export async function runSimulation(
  proposedPolicies: unknown[],
  window?: { fromMs?: number; toMs?: number },
): Promise<SimulationResult> {
  return postJson<SimulationResult>('/v1/simulator/run', {
    proposedPolicies,
    ...(window ?? {}),
  });
}

export async function generateReceipt(seq: number): Promise<Receipt> {
  return postJson<Receipt>('/v1/receipt/generate', { seq });
}

export async function verifyReceipt(receipt: unknown): Promise<ReceiptVerifyResult> {
  return postJson<ReceiptVerifyResult>('/v1/receipt/verify', receipt as object);
}

/**
 * Run an async producer and track loading / error / data state. The producer
 * is re-run whenever a value in `deps` changes.
 */
export function useAsync<T>(
  producer: () => Promise<FetchOutcome<T>>,
  deps: ReadonlyArray<unknown>,
): AsyncState<T> {
  const [state, setState] = useState<AsyncState<T>>({
    data: null,
    loading: true,
    error: null,
    fromMock: false,
  });

  useEffect(() => {
    let cancelled = false;
    setState((prev) => ({ ...prev, loading: true, error: null }));
    producer()
      .then((outcome) => {
        if (cancelled) return;
        setState({ data: outcome.data, loading: false, error: null, fromMock: outcome.fromMock });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        const message = err instanceof Error ? err.message : 'Unknown error';
        setState({ data: null, loading: false, error: message, fromMock: false });
      });
    return () => {
      cancelled = true;
    };
    // `producer` identity is intentionally not tracked; callers pass deps.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  return state;
}
