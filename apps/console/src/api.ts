// Typed REST client over the Veritrail server API (mounted at `/api`, proxied
// to :8787 in dev). Every call try/catches and falls back to local mock data
// so the console renders standalone with no server running.

import {
  mockAuditSummary,
  mockHealth,
  mockIncidentReports,
  mockLedgerEventsResponse,
  mockSpendStatus,
  mockVendorRisk,
} from './mocks.ts';
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

/** Result of a single async data fetch consumed by the useAsync hook. */
export interface AsyncState<T> {
  data: T | null;
  loading: boolean;
  error: string | null;
  /** True when the value came from the local mock fallback. */
  fromMock: boolean;
}

interface FetchOutcome<T> {
  data: T;
  fromMock: boolean;
}

async function getJson<T>(path: string, fallback: T): Promise<FetchOutcome<T>> {
  try {
    const res = await fetch(`${API_BASE}${path}`, {
      headers: { Accept: 'application/json' },
    });
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`);
    }
    const data = (await res.json()) as T;
    return { data, fromMock: false };
  } catch {
    // Standalone / offline mode: serve realistic mock data instead of failing.
    return { data: fallback, fromMock: true };
  }
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
