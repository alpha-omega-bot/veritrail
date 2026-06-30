import type { VendorSignal, VendorSignalSeverity } from '@veritrail/core';

import { ProviderMonitorError } from './errors.js';

/**
 * A StatusPage.io-compatible status page API response shape. This covers the
 * common JSON structure many providers expose (Atlassian StatusPage, custom
 * implementations, etc.).
 */
export interface StatusPageSummary {
  readonly status?: {
    readonly indicator?: string;
    readonly description?: string;
  };
  readonly components?: Array<{
    readonly id?: string;
    readonly name?: string;
    readonly status?: string;
  }>;
  readonly incidents?: Array<{
    readonly id?: string;
    readonly name?: string;
    readonly status?: string;
    readonly impact?: string;
  }>;
}

export interface StatusPageMonitorOptions {
  /** Vendor id this monitor tracks. */
  readonly vendorId: string;
  /** Status page summary API URL (e.g., `https://status.example.com/api/v2/summary.json`). */
  readonly url: string;
  /** Optional fetch-compatible client. Defaults to global fetch. */
  readonly fetch?: typeof globalThis.fetch;
}

/**
 * StatusPage.io-compatible status monitor. Polls a provider's status page API,
 * parses the common JSON shape (status indicator, incidents, components), and
 * maps each degradation/incident into a vendor signal.
 *
 * Example:
 * ```ts
 * const monitor = new StatusPageMonitor({
 *   vendorId: 'ven_openai',
 *   url: 'https://status.openai.com/api/v2/summary.json',
 * });
 * const signals = await monitor.poll();
 * ```
 */
export class StatusPageMonitor {
  readonly name: string;
  readonly #vendorId: string;
  readonly #url: string;
  readonly #fetch: typeof globalThis.fetch;

  constructor(options: StatusPageMonitorOptions) {
    this.name = `status-page:${options.vendorId}`;
    this.#vendorId = options.vendorId;
    this.#url = options.url;
    this.#fetch = options.fetch ?? globalThis.fetch;
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

    let summary: StatusPageSummary;
    try {
      summary = (await response.json()) as StatusPageSummary;
    } catch (cause) {
      throw new ProviderMonitorError(
        this.name,
        `JSON parse failed: ${cause instanceof Error ? cause.message : String(cause)}`,
      );
    }

    const signals: VendorSignal[] = [];
    const now = Date.now();

    if (summary.status?.indicator && summary.status.indicator !== 'none') {
      const severity = this.#indicatorToSeverity(summary.status.indicator);
      signals.push({
        id: `sig_${this.#vendorId}_status_${now}`,
        vendorId: this.#vendorId,
        kind: 'incident',
        severity,
        summary: summary.status.description ?? `Status: ${summary.status.indicator}`,
        source: this.#url,
        observedAt: now,
      });
    }

    if (summary.incidents) {
      for (const incident of summary.incidents) {
        if (!incident.id || !incident.name) continue;
        if (incident.status === 'resolved' || incident.status === 'postmortem') continue;

        const severity = this.#impactToSeverity(incident.impact);
        signals.push({
          id: `sig_${this.#vendorId}_incident_${incident.id}`,
          vendorId: this.#vendorId,
          kind: 'incident',
          severity,
          summary: `${incident.name} (${incident.status ?? 'ongoing'})`,
          source: this.#url,
          observedAt: now,
        });
      }
    }

    if (summary.components) {
      for (const component of summary.components) {
        if (!component.id || !component.name) continue;
        if (
          component.status === 'operational' ||
          !component.status ||
          component.status === 'maintenance'
        )
          continue;

        const severity = this.#componentStatusToSeverity(component.status);
        signals.push({
          id: `sig_${this.#vendorId}_component_${component.id}_${now}`,
          vendorId: this.#vendorId,
          kind: 'degradation',
          severity,
          summary: `${component.name}: ${component.status}`,
          source: this.#url,
          observedAt: now,
        });
      }
    }

    return signals;
  }

  #indicatorToSeverity(indicator: string): VendorSignalSeverity {
    const lower = indicator.toLowerCase();
    if (lower.includes('critical') || lower === 'major') return 'critical';
    if (lower.includes('major') || lower === 'minor') return 'high';
    if (lower.includes('minor') || lower.includes('degraded')) return 'medium';
    return 'low';
  }

  #impactToSeverity(impact: string | undefined): VendorSignalSeverity {
    if (!impact) return 'medium';
    const lower = impact.toLowerCase();
    if (lower === 'critical') return 'critical';
    if (lower === 'major') return 'high';
    if (lower === 'minor') return 'medium';
    return 'low';
  }

  #componentStatusToSeverity(status: string): VendorSignalSeverity {
    const lower = status.toLowerCase();
    if (lower.includes('outage') || lower.includes('major')) return 'critical';
    if (lower.includes('degraded') || lower.includes('partial')) return 'high';
    return 'medium';
  }
}
