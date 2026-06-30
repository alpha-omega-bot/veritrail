import type { VendorSignal } from '@veritrail/core';

import { ProviderMonitorError } from './errors.js';

export interface HttpStatusCheckOptions {
  /** Vendor id this monitor tracks. */
  readonly vendorId: string;
  /** URL to check (e.g., a provider's status page endpoint returning JSON). */
  readonly url: string;
  /** Optional fetch-compatible client. Defaults to global fetch. */
  readonly fetch?: typeof globalThis.fetch;
  /**
   * Transform the fetched response body into vendor signals. Receives the
   * parsed JSON (when content-type is JSON) or text; must return an array of
   * signals. Throw `ProviderMonitorError` on malformed responses.
   */
  readonly transform: (body: unknown) => VendorSignal[];
}

/**
 * HTTP-based status check monitor. Fetches a URL (typically a provider's status
 * page API), transforms the response into vendor signals via a deployment-supplied
 * callback, and returns them for ingestion.
 *
 * Example:
 * ```ts
 * const monitor = new HttpStatusCheckMonitor({
 *   vendorId: 'ven_anthropic',
 *   url: 'https://status.anthropic.com/api/v2/summary.json',
 *   transform: (body) => {
 *     const data = body as { status: { indicator: string } };
 *     if (data.status.indicator === 'none') return [];
 *     return [{
 *       id: 'sig_anthropic_incident',
 *       vendorId: 'ven_anthropic',
 *       kind: 'incident',
 *       severity: data.status.indicator === 'critical' ? 'critical' : 'medium',
 *       summary: `Status page reports ${data.status.indicator}`,
 *       source: 'https://status.anthropic.com',
 *     }];
 *   },
 * });
 * ```
 */
export class HttpStatusCheckMonitor {
  readonly name: string;
  readonly #url: string;
  readonly #fetch: typeof globalThis.fetch;
  readonly #transform: (body: unknown) => VendorSignal[];

  constructor(options: HttpStatusCheckOptions) {
    this.name = `http-status-check:${options.vendorId}`;
    this.#url = options.url;
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#transform = options.transform;
  }

  async poll(): Promise<VendorSignal[]> {
    let response: Response;
    try {
      response = await this.#fetch(this.#url);
    } catch (cause) {
      throw new ProviderMonitorError(
        this.name,
        `fetch failed: ${cause instanceof Error ? cause.message : String(cause)}`,
      );
    }

    if (!response.ok) {
      throw new ProviderMonitorError(this.name, `HTTP ${response.status} ${response.statusText}`);
    }

    const contentType = response.headers.get('content-type') ?? '';
    let body: unknown;
    try {
      if (contentType.includes('application/json')) {
        body = await response.json();
      } else {
        body = await response.text();
      }
    } catch (cause) {
      throw new ProviderMonitorError(
        this.name,
        `response parse failed: ${cause instanceof Error ? cause.message : String(cause)}`,
      );
    }

    try {
      return this.#transform(body);
    } catch (cause) {
      if (cause instanceof ProviderMonitorError) throw cause;
      throw new ProviderMonitorError(
        this.name,
        `transform failed: ${cause instanceof Error ? cause.message : String(cause)}`,
      );
    }
  }
}
