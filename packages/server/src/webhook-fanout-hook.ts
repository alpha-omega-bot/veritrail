/**
 * Webhook fanout wiring for the Veritrail HTTP server. Installs a pair of
 * Fastify hooks that observe successful POST /api/events appends and call
 * dispatchToWebhooks for each newly appended record. Delivery itself is
 * deferred to the webhook worker — this layer only writes outbox entries.
 *
 * The hook is split across two stages because Fastify consumes reply bodies
 * before onResponse fires. The onSend hook parses the JSON payload while it
 * is still in flight, stashes the appended record on the request, and
 * onResponse dispatches once the status code is known.
 */

import type { LedgerRecord } from '@veritrail/core';
import type { ControlPlane } from '@veritrail/control-plane';
import type { FastifyInstance } from 'fastify';

import { dispatchToWebhooks, type OutboxWriter } from './webhook-dispatch.js';

/** Configuration for {@link installWebhookFanout}. */
export interface WebhookFanoutOptions {
  /**
   * Control plane that owns webhook subscriptions. Only the underlying
   * store is read — the fanout hook never mutates subscription state.
   */
  readonly controlPlane: Pick<ControlPlane, 'store'>;
  /**
   * Outbox the dispatcher writes pending deliveries into. The webhook
   * worker drains it asynchronously.
   */
  readonly outbox: OutboxWriter;
}

declare module 'fastify' {
  interface FastifyRequest {
    /**
     * Ledger record appended by a successful POST /api/events call. Set by
     * the onSend hook and consumed by onResponse to drive webhook fanout.
     */
    veritrailAppendedRecord?: LedgerRecord;
  }
  interface FastifyInstance {
    /**
     * Promise that resolves once every in-flight fanout dispatch has
     * settled. Tests and shutdown paths await this so they observe the
     * outbox after the response has been sent. Always available after
     * {@link installWebhookFanout} runs.
     */
    veritrailFanoutSettled?: () => Promise<void>;
  }
}

/**
 * Wire webhook fanout into the ledger append hot path. After this call,
 * every successful POST /api/events (status 2xx) triggers a best-effort
 * call to {@link dispatchToWebhooks}. Dispatch errors are logged but never
 * surface to the client — webhook delivery is at-least-once via the
 * worker's retry loop, not the original request.
 */
export function installWebhookFanout(app: FastifyInstance, opts: WebhookFanoutOptions): void {
  const { controlPlane, outbox } = opts;
  const inFlight = new Set<Promise<unknown>>();

  app.addHook('onSend', async (request, _reply, payload) => {
    if (!isEventsAppendRoute(request.method, request.url)) return payload;
    const record = extractAppendedRecord(payload);
    if (record) request.veritrailAppendedRecord = record;
    return payload;
  });

  app.addHook('onResponse', async (request, reply) => {
    const record = request.veritrailAppendedRecord;
    if (!record) return;
    if (reply.statusCode < 200 || reply.statusCode >= 300) return;
    const task = dispatchToWebhooks(record, {
      subscriptions: controlPlane.store,
      outbox,
      clock: Date.now,
    }).catch((err: unknown) => {
      app.log.error({ err }, 'webhook fanout failed');
    });
    inFlight.add(task);
    void task.finally(() => inFlight.delete(task));
  });

  app.decorate('veritrailFanoutSettled', async () => {
    while (inFlight.size > 0) {
      await Promise.allSettled([...inFlight]);
    }
  });
}

/**
 * True when the request targets the raw ledger ingest endpoint. Fastify
 * normalizes query strings onto request.url, so we only compare the path.
 */
function isEventsAppendRoute(method: string, url: string): boolean {
  if (method !== 'POST') return false;
  const pathEnd = url.indexOf('?');
  const path = pathEnd === -1 ? url : url.slice(0, pathEnd);
  return path === '/api/events';
}

/**
 * Pull the appended LedgerRecord out of a Fastify reply payload. The
 * /api/events handler always responds with `{ record: <LedgerRecord> }`
 * on success; everything else (error envelopes, non-JSON, streams) is
 * silently ignored — fanout is best-effort.
 */
function extractAppendedRecord(payload: unknown): LedgerRecord | undefined {
  if (typeof payload !== 'string') return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch {
    return undefined;
  }
  if (parsed === null || typeof parsed !== 'object') return undefined;
  const record = (parsed as { record?: unknown }).record;
  if (record === null || typeof record !== 'object') return undefined;
  const candidate = record as { event?: unknown; seq?: unknown };
  if (typeof candidate.seq !== 'number') return undefined;
  if (candidate.event === null || typeof candidate.event !== 'object') return undefined;
  return record as LedgerRecord;
}
