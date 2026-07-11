/**
 * Webhook fanout helper.
 *
 * When a ledger record is appended, this helper looks up matching webhook
 * subscriptions for the project (from event labels) and writes one outbox
 * entry per match. The actual HTTP delivery is then performed by
 * @veritrail/webhook-worker — this layer is pure dispatch.
 *
 * Wiring: the server route that handles POST /api/events calls
 * `dispatchToWebhooks(record, opts)` after a successful append. Storing the
 * outbox entry is fast (single in-memory or DB write); the worker drains it
 * asynchronously.
 */

import type { LedgerRecord } from '@veritrail/core';

/** Tiny shape that the dispatch helper needs from the control plane. */
export interface WebhookSubscriptionsReader {
  listWebhooksForProject(projectId: string): Promise<
    ReadonlyArray<{
      readonly id: string;
      readonly projectId: string;
      readonly url: string;
      readonly secret: string;
      readonly eventsFilter: string | ReadonlyArray<string>;
      readonly pausedAt: number | null;
    }>
  >;
}

/** Tiny shape of the outbox the helper writes into. */
export interface OutboxWriter {
  enqueue(input: {
    readonly id: string;
    readonly webhookId: string;
    readonly url: string;
    readonly secret: string;
    readonly payload: unknown;
    readonly eventType: string;
    readonly queuedAt: number;
    readonly nextAttemptAt: number;
  }): Promise<unknown>;
}

export interface DispatchOptions {
  readonly subscriptions: WebhookSubscriptionsReader;
  readonly outbox: OutboxWriter;
  /** Override for tests. Defaults to Date.now(). */
  readonly clock?: () => number;
  /** Override for tests. Defaults to crypto.randomUUID(). */
  readonly newId?: () => string;
}

/**
 * Return the projectId encoded in this record, if any. The control plane
 * stamps `labels.project` on every event coming through an API key, so this
 * mirrors that convention. Records without a project label are skipped
 * because they cannot be routed to a webhook.
 */
function projectIdFor(record: LedgerRecord): string | null {
  const labels = (record.event as { labels?: Record<string, string> }).labels;
  return labels?.['project'] ?? null;
}

/**
 * True when the subscription's filter accepts this event type. The filter
 * grammar:
 *   - "*" matches everything
 *   - "type.a,type.b" matches either type.a or type.b
 *   - "tool.*" matches any type beginning with "tool."
 */
export function filterMatches(filter: string | ReadonlyArray<string>, eventType: string): boolean {
  if (typeof filter === 'string') {
    if (filter === '*' || filter === '') return true;
    for (const raw of filter
      .split(',')
      .map((t) => t.trim())
      .filter(Boolean)) {
      if (raw === eventType) return true;
      if (raw.endsWith('*') && eventType.startsWith(raw.slice(0, -1))) return true;
    }
    return false;
  }
  // Array form (control-plane Webhook): empty array means "all".
  if (filter.length === 0) return true;
  for (const raw of filter.map((t) => t.trim()).filter(Boolean)) {
    if (raw === '*') return true;
    if (raw === eventType) return true;
    if (raw.endsWith('*') && eventType.startsWith(raw.slice(0, -1))) return true;
  }
  return false;
}

/**
 * Dispatch a single ledger record to matching webhook subscriptions. Returns
 * the number of outbox entries written (zero if no project label or no
 * matching subscriptions). Errors during dispatch are surfaced — the caller
 * decides whether to log-and-continue or fail the append.
 */
export async function dispatchToWebhooks(
  record: LedgerRecord,
  options: DispatchOptions,
): Promise<number> {
  const projectId = projectIdFor(record);
  if (!projectId) return 0;
  const subs = await options.subscriptions.listWebhooksForProject(projectId);
  const now = (options.clock ?? Date.now)();
  let written = 0;
  for (const sub of subs) {
    if (sub.pausedAt !== null) continue;
    if (!filterMatches(sub.eventsFilter, record.event.type)) continue;
    const id = options.newId ? options.newId() : globalThis.crypto.randomUUID();
    await options.outbox.enqueue({
      id,
      webhookId: sub.id,
      url: sub.url,
      secret: sub.secret,
      payload: {
        event_type: record.event.type,
        seq: record.seq,
        timestamp: record.timestamp,
        record,
      },
      eventType: record.event.type,
      queuedAt: now,
      nextAttemptAt: now,
    });
    written += 1;
  }
  return written;
}
