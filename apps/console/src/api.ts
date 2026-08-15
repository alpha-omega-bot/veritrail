// Typed REST client over the Veritrail server API (mounted at `/api`, proxied to
// :8787 in dev).
//
// Design constraint specific to this product: the console is a read-only view
// onto a tamper-evident audit ledger, so it must NEVER substitute invented data
// for a failed request. An operator reading "integrity: verified" has to be able
// to trust that the server actually said so. Every failure therefore surfaces as
// an explicit error state; there is no sample-data fallback.

import { useCallback, useEffect, useState } from 'react';
import type {
  ApiErrorBody,
  AuditSummary,
  HealthStatus,
  IncidentReport,
  IntegrityReport,
  LedgerRecord,
  SpendStatus,
  VendorRiskScore,
} from './types.ts';

const API_BASE = '/api';

/**
 * Session-scoped storage key for the operator's API credential.
 *
 * The token is entered at runtime and held in `sessionStorage` so it is never
 * baked into the built bundle, never committed, and does not outlive the browser
 * session. Deployments that terminate auth at a reverse proxy can ignore this
 * entirely — requests simply go out without an `Authorization` header.
 */
const TOKEN_STORAGE_KEY = 'veritrail.console.token';

/** Read the operator API token for this browser session, if one was supplied. */
export function getApiToken(): string | null {
  try {
    const token = window.sessionStorage.getItem(TOKEN_STORAGE_KEY);
    return token !== null && token.length > 0 ? token : null;
  } catch {
    // Storage can be unavailable (private mode, blocked cookies). Treat as absent.
    return null;
  }
}

/** Store or clear the operator API token for this browser session. */
export function setApiToken(token: string | null): void {
  try {
    if (token === null || token.length === 0) {
      window.sessionStorage.removeItem(TOKEN_STORAGE_KEY);
    } else {
      window.sessionStorage.setItem(TOKEN_STORAGE_KEY, token);
    }
  } catch {
    // Non-fatal: requests will just be sent unauthenticated.
  }
}

/** Distinguishes an authentication problem from any other request failure. */
export type ApiFailureKind = 'unauthorized' | 'forbidden' | 'network' | 'server';

/** A request that failed, carrying enough detail for the UI to guide the operator. */
export class ApiError extends Error {
  readonly kind: ApiFailureKind;
  readonly status: number | null;
  readonly code: string | null;

  constructor(message: string, kind: ApiFailureKind, status: number | null, code: string | null) {
    super(message);
    this.name = 'ApiError';
    this.kind = kind;
    this.status = status;
    this.code = code;
  }
}

function kindForStatus(status: number): ApiFailureKind {
  if (status === 401) return 'unauthorized';
  if (status === 403) return 'forbidden';
  return 'server';
}

/** Pull `{ error: { code, message } }` out of a failed response, if present. */
async function describeFailure(res: Response): Promise<{ message: string; code: string | null }> {
  try {
    const body = (await res.json()) as Partial<ApiErrorBody>;
    const error = body.error;
    if (error !== undefined && typeof error.message === 'string' && error.message.length > 0) {
      return { message: error.message, code: typeof error.code === 'string' ? error.code : null };
    }
  } catch {
    // Body was empty or not JSON; fall through to a status-based message.
  }
  return { message: `Request failed with HTTP ${res.status}.`, code: null };
}

async function getJson<T>(path: string): Promise<T> {
  const token = getApiToken();
  let res: Response;
  try {
    res = await fetch(`${API_BASE}${path}`, {
      headers: {
        Accept: 'application/json',
        ...(token !== null ? { Authorization: `Bearer ${token}` } : {}),
      },
    });
  } catch {
    throw new ApiError(
      'Could not reach the Veritrail API. Check that the server is running and reachable.',
      'network',
      null,
      null,
    );
  }

  if (!res.ok) {
    const { message, code } = await describeFailure(res);
    const kind = kindForStatus(res.status);
    if (kind === 'unauthorized') {
      throw new ApiError(
        `${message} Supply an operator API token to view this data.`,
        kind,
        res.status,
        code,
      );
    }
    if (kind === 'forbidden') {
      throw new ApiError(
        `${message} This token lacks the role or scope required for this view.`,
        kind,
        res.status,
        code,
      );
    }
    throw new ApiError(message, kind, res.status, code);
  }

  try {
    return (await res.json()) as T;
  } catch {
    throw new ApiError('The API returned a malformed JSON response.', 'server', res.status, null);
  }
}

// ---- endpoints ------------------------------------------------------------
// Each mirrors a real route. Collection endpoints return bare arrays.

/** Unauthenticated liveness probe. */
export function getHealth(): Promise<HealthStatus> {
  return getJson<HealthStatus>('/health');
}

/** Aggregate ledger state. Requires an *unscoped* operator token. */
export function getAuditSummary(): Promise<AuditSummary> {
  return getJson<AuditSummary>('/audit/summary');
}

/** Full hash-chain verification. Requires an *unscoped* operator token. */
export function getIntegrityReport(): Promise<IntegrityReport> {
  return getJson<IntegrityReport>('/audit/verify');
}

/** A page of ledger records, ascending by `seq`. */
export function getLedgerRecords(limit = 50): Promise<LedgerRecord[]> {
  return getJson<LedgerRecord[]>(`/audit/events?limit=${encodeURIComponent(limit)}`);
}

/** Per-budget spend projections. */
export function getSpendStatus(): Promise<SpendStatus[]> {
  return getJson<SpendStatus[]>('/spend/status');
}

/** Vendor risk assessments, already sorted riskiest-first by the server. */
export function getVendorRisk(): Promise<VendorRiskScore[]> {
  return getJson<VendorRiskScore[]>('/vendor-risk/assess');
}

/**
 * Reconstruct an incident for a correlation id. An unknown id resolves
 * successfully with empty collections — it is not an error.
 */
export function getIncident(correlationId: string): Promise<IncidentReport> {
  return getJson<IncidentReport>(
    `/forensics/incident?correlationId=${encodeURIComponent(correlationId)}`,
  );
}

// ---- async state ----------------------------------------------------------

/** Result of a single data fetch. `data` is non-null only on success. */
export interface AsyncState<T> {
  data: T | null;
  loading: boolean;
  error: ApiError | null;
  /** Increment to re-run the request. */
  reload: () => void;
}

/**
 * Run an async producer and track loading / error / data state, re-running when
 * a value in `deps` changes. Errors are always surfaced, never masked.
 */
export function useAsync<T>(
  producer: () => Promise<T>,
  deps: ReadonlyArray<unknown>,
): AsyncState<T> {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<ApiError | null>(null);
  const [nonce, setNonce] = useState(0);

  const reload = useCallback(() => setNonce((n) => n + 1), []);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    producer()
      .then((value) => {
        if (cancelled) return;
        setData(value);
        setError(null);
        setLoading(false);
      })
      .catch((cause: unknown) => {
        if (cancelled) return;
        // Discard any stale value so a failed refresh cannot leave the previous
        // reading on screen looking current.
        setData(null);
        setError(
          cause instanceof ApiError
            ? cause
            : new ApiError(
                cause instanceof Error ? cause.message : 'Unknown error',
                'server',
                null,
                null,
              ),
        );
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // `producer` identity is intentionally not tracked; callers pass explicit deps.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, nonce]);

  return { data, loading, error, reload };
}
