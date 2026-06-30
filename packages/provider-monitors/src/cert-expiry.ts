import { type TLSSocket, connect as tlsConnect } from 'node:tls';

import type { VendorSignal } from '@veritrail/core';

import { ProviderMonitorError } from './errors.js';

export interface CertExpiryMonitorOptions {
  /** Vendor id this monitor tracks. */
  readonly vendorId: string;
  /** Hostname to check (TLS certificate expiry). */
  readonly hostname: string;
  /** Port for TLS connection. Defaults to 443. */
  readonly port?: number;
  /**
   * Warn when the certificate expires within this window (milliseconds).
   * Defaults to 30 days.
   */
  readonly warnThresholdMs?: number;
}

const DAY_MS = 86_400_000;
const DEFAULT_WARN_THRESHOLD_MS = 30 * DAY_MS;

/**
 * TLS certificate expiry monitor. Connects to a hostname, reads the server's
 * certificate, and emits a vendor signal when the cert will expire within the
 * configured threshold (default 30 days).
 *
 * Example:
 * ```ts
 * const monitor = new CertExpiryMonitor({
 *   vendorId: 'ven_openai',
 *   hostname: 'api.openai.com',
 * });
 * const signals = await monitor.poll();
 * // signals[0] if cert expires within 30 days
 * ```
 */
export class CertExpiryMonitor {
  readonly name: string;
  readonly #vendorId: string;
  readonly #hostname: string;
  readonly #port: number;
  readonly #warnThresholdMs: number;

  constructor(options: CertExpiryMonitorOptions) {
    this.name = `cert-expiry:${options.vendorId}:${options.hostname}`;
    this.#vendorId = options.vendorId;
    this.#hostname = options.hostname;
    this.#port = options.port ?? 443;
    this.#warnThresholdMs = options.warnThresholdMs ?? DEFAULT_WARN_THRESHOLD_MS;
  }

  async poll(): Promise<VendorSignal[]> {
    return new Promise((resolve, reject) => {
      const socket = tlsConnect(
        {
          host: this.#hostname,
          port: this.#port,
          servername: this.#hostname,
          rejectUnauthorized: false,
        },
        () => {
          try {
            const cert = (socket as TLSSocket).getPeerCertificate();
            socket.end();

            if (!cert || !cert.valid_to) {
              return reject(
                new ProviderMonitorError(this.name, 'no peer certificate or valid_to date'),
              );
            }

            const expiresAt = new Date(cert.valid_to).getTime();
            const now = Date.now();
            const msUntilExpiry = expiresAt - now;

            if (msUntilExpiry <= this.#warnThresholdMs) {
              const daysUntilExpiry = Math.floor(msUntilExpiry / DAY_MS);
              const severity = msUntilExpiry <= 7 * DAY_MS ? 'critical' : 'high';
              resolve([
                {
                  id: `sig_${this.#vendorId}_cert_expiry_${now}`,
                  vendorId: this.#vendorId,
                  kind: 'certification',
                  severity,
                  summary: `TLS certificate for ${this.#hostname} expires in ${daysUntilExpiry} days (${cert.valid_to})`,
                  source: `tls://${this.#hostname}:${this.#port}`,
                  observedAt: now,
                },
              ]);
            } else {
              resolve([]);
            }
          } catch (cause) {
            socket.end();
            reject(
              new ProviderMonitorError(
                this.name,
                `cert parse failed: ${cause instanceof Error ? cause.message : String(cause)}`,
              ),
            );
          }
        },
      );

      socket.on('error', (error) => {
        reject(new ProviderMonitorError(this.name, `connection failed: ${error.message}`));
      });

      socket.setTimeout(10_000, () => {
        socket.end();
        reject(new ProviderMonitorError(this.name, 'connection timeout'));
      });
    });
  }
}
