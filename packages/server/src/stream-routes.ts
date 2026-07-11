/**
 * Server-Sent Events tail of the audit ledger.
 *
 * Mounted under GET /api/audit/events/stream. The route is intentionally
 * scoped to read-only ledger projection: any caller authorised to call
 * /api/audit/events is also authorised here. The stream respects the
 * caller's `labelScope` so tenant partitioning is preserved.
 *
 * Implementation: rather than relying on Postgres LISTEN/NOTIFY (which
 * requires a Postgres deployment), we poll `ledger.query` every
 * `pollIntervalMs` and emit only records past the last seen `seq`. This
 * keeps the route transport-agnostic (works against in-memory, file, or
 * relational ledgers).
 */

import type { LedgerReader, LedgerRecord } from '@veritrail/core';
import type { FastifyInstance, FastifyRequest } from 'fastify';

export interface StreamRoutesConfig {
  readonly ledger: LedgerReader;
  /** Read principal label scope from the request. */
  readonly getLabelScope?: (req: FastifyRequest) => Readonly<Record<string, string>> | undefined;
  /** Poll interval. Defaults to 1000ms. */
  readonly pollIntervalMs?: number;
  /** Heartbeat interval for keep-alive comments. Defaults to 30000ms. */
  readonly heartbeatMs?: number;
  /** Max records emitted per poll tick. Defaults to 100. */
  readonly batchSize?: number;
}

export function registerStreamRoutes(app: FastifyInstance, config: StreamRoutesConfig): void {
  const pollIntervalMs = config.pollIntervalMs ?? 1000;
  const heartbeatMs = config.heartbeatMs ?? 30_000;
  const batchSize = config.batchSize ?? 100;

  app.get('/api/audit/events/stream', async (request, reply) => {
    const labelScope = config.getLabelScope?.(request);
    const query = request.query as { fromSeq?: string };
    const initial = Number(query.fromSeq ?? '0') || 0;
    let lastSeq = initial;

    reply.raw.setHeader('content-type', 'text/event-stream');
    reply.raw.setHeader('cache-control', 'no-cache');
    reply.raw.setHeader('connection', 'keep-alive');
    reply.raw.setHeader('x-accel-buffering', 'no');
    // First frame: open the connection so the client transitions to 'open'.
    reply.raw.write(': connected\n\n');

    let closed = false;
    const writeFrame = (data: string): boolean => {
      if (closed) return false;
      try {
        return reply.raw.write(data);
      } catch {
        closed = true;
        return false;
      }
    };

    const poll = async () => {
      if (closed) return;
      try {
        const records = await config.ledger.query({
          fromSeq: lastSeq + 1,
          limit: batchSize,
          ...(labelScope ? { labels: labelScope as Record<string, string> } : {}),
        });
        for (const record of records as readonly LedgerRecord[]) {
          if (closed) return;
          lastSeq = Math.max(lastSeq, record.seq);
          writeFrame(`data: ${JSON.stringify(record)}\n\n`);
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : 'unknown error';
        writeFrame(`event: error\ndata: ${JSON.stringify({ message })}\n\n`);
        // Don't break the loop — transient errors can recover on next tick.
      }
    };

    const pollTimer = setInterval(() => {
      void poll();
    }, pollIntervalMs);
    const heartbeatTimer = setInterval(() => {
      writeFrame(': ping\n\n');
    }, heartbeatMs);

    const cleanup = () => {
      closed = true;
      clearInterval(pollTimer);
      clearInterval(heartbeatTimer);
      try {
        reply.raw.end();
      } catch {
        // ignore
      }
    };

    request.raw.on('close', cleanup);
    request.raw.on('error', cleanup);
    reply.raw.on('error', cleanup);
    // Kick once immediately to flush backlog past the requested fromSeq.
    void poll();

    return reply;
  });
}
