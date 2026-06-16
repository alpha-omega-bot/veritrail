import { VeritrailError, type VeritrailErrorCode } from '@veritrail/core';

export interface VeritrailClientOptions {
  baseUrl?: string;
  /** Override the fetch implementation (e.g. for tests). Defaults to global fetch. */
  fetchImpl?: typeof fetch;
  headers?: Record<string, string>;
}

function statusToCode(status: number): VeritrailErrorCode {
  switch (status) {
    case 400:
      return 'VALIDATION';
    case 402:
      return 'BUDGET_EXCEEDED';
    case 403:
      return 'POLICY_DENIED';
    case 404:
      return 'NOT_FOUND';
    case 409:
      return 'CONFLICT';
    case 422:
      return 'INTEGRITY';
    case 501:
      return 'UNSUPPORTED';
    default:
      return 'INTERNAL';
  }
}

function queryString(params?: Record<string, string | number | undefined>): string {
  if (!params) return '';
  const usp = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) usp.set(key, String(value));
  }
  const s = usp.toString();
  return s ? `?${s}` : '';
}

/**
 * A thin, typed client for the Veritrail HTTP server. Errors are surfaced as
 * `VeritrailError` with a `code` mapped from the HTTP status, so callers handle
 * remote and in-process failures uniformly.
 */
export class VeritrailClient {
  readonly #baseUrl: string;
  readonly #fetch: typeof fetch;
  readonly #headers: Record<string, string>;

  constructor(options: VeritrailClientOptions = {}) {
    this.#baseUrl = (options.baseUrl ?? 'http://localhost:8787').replace(/\/$/, '');
    this.#fetch = options.fetchImpl ?? globalThis.fetch;
    this.#headers = { 'content-type': 'application/json', ...(options.headers ?? {}) };
  }

  async #request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const response = await this.#fetch(`${this.#baseUrl}${path}`, {
      method,
      headers: this.#headers,
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const text = await response.text();
    let json: unknown;
    try {
      json = text ? JSON.parse(text) : undefined;
    } catch {
      // Non-JSON body (e.g. a proxy error page): surface as a typed error rather
      // than leaking a raw SyntaxError, preserving the uniform-error contract.
      if (!response.ok) {
        throw new VeritrailError(
          statusToCode(response.status),
          response.statusText || 'request failed',
        );
      }
      throw new VeritrailError('INTERNAL', 'expected JSON response body');
    }
    if (!response.ok) {
      const message =
        (json as { error?: { message?: string } } | undefined)?.error?.message ??
        response.statusText;
      throw new VeritrailError(statusToCode(response.status), message, {
        details: json as never,
      });
    }
    return json as T;
  }

  health(): Promise<{ status: string; name: string; version: string; uptimeMs: number }> {
    return this.#request('GET', '/api/health');
  }

  appendEvent<T = { record: unknown }>(event: unknown): Promise<T> {
    return this.#request('POST', '/api/events', event);
  }

  getEvents<T = unknown[]>(query?: {
    fromSeq?: number;
    toSeq?: number;
    type?: string;
    actorId?: string;
    correlationId?: string;
    limit?: number;
  }): Promise<T> {
    return this.#request('GET', `/api/audit/events${queryString(query)}`);
  }

  auditSummary<T = unknown>(): Promise<T> {
    return this.#request('GET', '/api/audit/summary');
  }

  verifyIntegrity<T = { ok: boolean; checked: number; head: string | null }>(): Promise<T> {
    return this.#request('GET', '/api/audit/verify');
  }

  spendStatus<T = unknown[]>(): Promise<T> {
    return this.#request('GET', '/api/spend/status');
  }

  vendorRiskAssessment<T = unknown[]>(): Promise<T> {
    return this.#request('GET', '/api/vendor-risk/assess');
  }

  incident<T = unknown>(correlationId: string): Promise<T> {
    return this.#request('GET', `/api/forensics/incident${queryString({ correlationId })}`);
  }
}
