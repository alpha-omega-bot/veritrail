/**
 * @veritrail/webhook-worker
 *
 * Background delivery worker for outgoing Veritrail webhooks. Pulls due
 * entries from a pluggable outbox store, signs the payload with HMAC,
 * POSTs to the subscriber's URL, and updates the entry: delivered on 2xx,
 * retried on 5xx or network errors, permanently failed on 4xx or after
 * exhausting `maxAttempts`.
 *
 * The worker is intentionally storage-agnostic so it can run against an
 * in-memory outbox in tests and a Postgres outbox in production.
 */

export { signPayload, verifySignature } from './signing.js';
export { nextAttemptDelay } from './retry.js';
export { InMemoryOutboxStore, type OutboxStore, type WebhookEntry } from './outbox.js';
export { WebhookWorker, type WebhookWorkerOptions } from './worker.js';
