/**
 * Storage port for outgoing webhooks. The worker reads pending entries via
 * `fetchDue` and updates lifecycle state via the mark* methods.
 */

export interface WebhookEntry {
  readonly id: string;
  readonly webhookId: string;
  readonly url: string;
  readonly secret: string;
  readonly payload: unknown;
  readonly eventType: string;
  readonly queuedAt: number;
  readonly attempts: number;
  readonly nextAttemptAt: number;
  readonly deliveredAt: number | null;
  readonly failedAt: number | null;
  readonly lastError: string | null;
}

export interface OutboxStore {
  enqueue(
    input: Omit<WebhookEntry, 'attempts' | 'deliveredAt' | 'failedAt' | 'lastError'>,
  ): Promise<WebhookEntry>;
  fetchDue(now: number, limit: number): Promise<ReadonlyArray<WebhookEntry>>;
  markDelivered(id: string, at: number): Promise<void>;
  markFailed(id: string, at: number, error: string): Promise<void>;
  markRetry(
    id: string,
    at: number,
    nextAttemptAt: number,
    attempts: number,
    error: string,
  ): Promise<void>;
}

/** Map-backed outbox for tests and single-node dev. */
export class InMemoryOutboxStore implements OutboxStore {
  #entries = new Map<string, WebhookEntry>();

  async enqueue(
    input: Omit<WebhookEntry, 'attempts' | 'deliveredAt' | 'failedAt' | 'lastError'>,
  ): Promise<WebhookEntry> {
    const entry: WebhookEntry = {
      ...input,
      attempts: 0,
      deliveredAt: null,
      failedAt: null,
      lastError: null,
    };
    this.#entries.set(entry.id, entry);
    return entry;
  }

  async fetchDue(now: number, limit: number): Promise<ReadonlyArray<WebhookEntry>> {
    const due: WebhookEntry[] = [];
    for (const entry of this.#entries.values()) {
      if (entry.deliveredAt !== null || entry.failedAt !== null) continue;
      if (entry.nextAttemptAt <= now) due.push(entry);
      if (due.length >= limit) break;
    }
    return due.sort((a, b) => a.nextAttemptAt - b.nextAttemptAt);
  }

  async markDelivered(id: string, at: number): Promise<void> {
    const e = this.#entries.get(id);
    if (!e) return;
    this.#entries.set(id, { ...e, deliveredAt: at });
  }

  async markFailed(id: string, at: number, error: string): Promise<void> {
    const e = this.#entries.get(id);
    if (!e) return;
    this.#entries.set(id, { ...e, failedAt: at, lastError: error });
  }

  async markRetry(
    id: string,
    _at: number,
    nextAttemptAt: number,
    attempts: number,
    error: string,
  ): Promise<void> {
    const e = this.#entries.get(id);
    if (!e) return;
    this.#entries.set(id, {
      ...e,
      attempts,
      nextAttemptAt,
      lastError: error,
    });
  }

  /** Read-only access for tests. */
  get(id: string): WebhookEntry | null {
    return this.#entries.get(id) ?? null;
  }
}
