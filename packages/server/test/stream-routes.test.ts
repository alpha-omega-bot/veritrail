import { describe, expect, it } from 'vitest';
import Fastify from 'fastify';

import { createInMemoryLedger } from '@veritrail/core';

import { buildServer } from '../src/app.js';
import { registerStreamRoutes } from '../src/stream-routes.js';

/**
 * Lightweight SSE integration test using Fastify's `inject` is not enough —
 * inject() doesn't model streaming bodies. We exercise the route by binding
 * to ephemeral port 0 and consuming the response body as a Node Readable
 * stream, parsing SSE frames manually.
 */

interface ReadFramesOptions {
  durationMs?: number;
  onFrame?: (frame: string) => void;
}

async function readFrames(
  url: string,
  options: ReadFramesOptions = {},
): Promise<{
  frames: string[];
  data: string[];
  comments: string[];
  statusCode: number;
  contentType: string | null;
}> {
  const durationMs = options.durationMs ?? 1500;
  const controller = new AbortController();
  const frames: string[] = [];
  const data: string[] = [];
  const comments: string[] = [];
  const timer = setTimeout(() => controller.abort(), durationMs);
  let statusCode = 0;
  let contentType: string | null = null;

  try {
    const res = await fetch(url, { signal: controller.signal });
    statusCode = res.status;
    contentType = res.headers.get('content-type');
    if (!res.body) throw new Error('no body');
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const parts = buf.split('\n\n');
      buf = parts.pop() ?? '';
      for (const frame of parts) {
        frames.push(frame);
        options.onFrame?.(frame);
        if (frame.startsWith('data: ')) {
          data.push(frame.slice('data: '.length));
        }
        if (frame.startsWith(':')) {
          comments.push(frame);
        }
      }
    }
  } catch (err) {
    if ((err as { name?: string }).name !== 'AbortError') throw err;
  } finally {
    clearTimeout(timer);
  }
  return { frames, data, comments, statusCode, contentType };
}

describe('SSE stream route', () => {
  it('serves text/event-stream content type with a connect frame', async () => {
    const app = await buildServer();
    await app.listen({ port: 0, host: '127.0.0.1' });
    const addr = app.server.address();
    const port = typeof addr === 'object' && addr !== null ? addr.port : 0;
    try {
      const { frames, statusCode, contentType } = await readFrames(
        `http://127.0.0.1:${port}/api/audit/events/stream`,
        { durationMs: 500 },
      );
      expect(statusCode).toBe(200);
      expect(contentType ?? '').toMatch(/text\/event-stream/);
      expect(frames.length).toBeGreaterThan(0);
      expect(frames[0]).toMatch(/^: connected/);
    } finally {
      await app.close();
    }
  });

  it('emits new ledger events as SSE data frames in near real time', async () => {
    const app = await buildServer();
    await app.listen({ port: 0, host: '127.0.0.1' });
    const addr = app.server.address();
    const port = typeof addr === 'object' && addr !== null ? addr.port : 0;
    try {
      // Begin streaming, then append an event in parallel.
      const streamPromise = readFrames(`http://127.0.0.1:${port}/api/audit/events/stream`, {
        durationMs: 3000,
      });
      // Give the stream a beat to register before appending.
      await new Promise((r) => setTimeout(r, 150));
      const append = await app.inject({
        method: 'POST',
        url: '/api/events',
        payload: {
          type: 'note',
          actorId: 'agent-stream-test',
          payload: { text: 'streamed' },
        },
      });
      expect(append.statusCode).toBe(201);
      const { data } = await streamPromise;
      expect(data.length).toBeGreaterThanOrEqual(1);
      const found = data.some((d) => d.includes('agent-stream-test'));
      expect(found).toBe(true);
    } finally {
      await app.close();
    }
  });

  it('emits heartbeat comments to keep proxies from closing the connection', async () => {
    // Build a fresh fastify app with a tight heartbeat so the test runs quickly.
    const ledger = createInMemoryLedger();
    const app = Fastify({ logger: false });
    registerStreamRoutes(app, {
      ledger,
      pollIntervalMs: 50,
      heartbeatMs: 100,
    });
    await app.listen({ port: 0, host: '127.0.0.1' });
    const addr = app.server.address();
    const port = typeof addr === 'object' && addr !== null ? addr.port : 0;
    try {
      const { frames, comments } = await readFrames(
        `http://127.0.0.1:${port}/api/audit/events/stream`,
        { durationMs: 600 },
      );
      expect(frames[0]).toMatch(/^: connected/);
      // Expect at least one heartbeat ping comment beyond the initial connect.
      const pings = comments.filter((c) => c.includes('ping'));
      expect(pings.length).toBeGreaterThanOrEqual(1);
    } finally {
      await app.close();
    }
  });

  it('cleans up timers and ends the response when the client closes', async () => {
    const ledger = createInMemoryLedger();
    const app = Fastify({ logger: false });

    // Patch setInterval/clearInterval to observe leaked timers from this route only.
    const originalSetInterval = globalThis.setInterval;
    const originalClearInterval = globalThis.clearInterval;
    const live = new Set<ReturnType<typeof setInterval>>();
    (globalThis as { setInterval: typeof setInterval }).setInterval = ((
      handler: (...args: unknown[]) => void,
      timeout?: number,
      ...args: unknown[]
    ) => {
      const t = originalSetInterval(handler, timeout, ...args);
      live.add(t);
      return t;
    }) as typeof setInterval;
    (globalThis as { clearInterval: typeof clearInterval }).clearInterval = ((
      t: ReturnType<typeof setInterval>,
    ) => {
      live.delete(t);
      return originalClearInterval(t);
    }) as typeof clearInterval;

    registerStreamRoutes(app, {
      ledger,
      pollIntervalMs: 50,
      heartbeatMs: 100,
    });
    await app.listen({ port: 0, host: '127.0.0.1' });
    const addr = app.server.address();
    const port = typeof addr === 'object' && addr !== null ? addr.port : 0;
    try {
      // Open a streaming connection, then abort it explicitly.
      const controller = new AbortController();
      const res = await fetch(`http://127.0.0.1:${port}/api/audit/events/stream`, {
        signal: controller.signal,
      });
      // Consume one chunk so the route writes the ': connected' frame.
      const reader = res.body?.getReader();
      if (reader) {
        await reader.read();
      }
      // Give the route a beat to schedule both intervals.
      await new Promise((r) => setTimeout(r, 200));
      const peak = live.size;
      expect(peak).toBeGreaterThanOrEqual(2);

      // Cancel the reader and abort to simulate the client closing.
      if (reader) {
        await reader.cancel().catch(() => undefined);
      }
      controller.abort();
      // Wait for the server-side 'close' event to fire and cleanup to run.
      await new Promise((r) => setTimeout(r, 300));
      // The route's two intervals should be cleared. Other intervals from
      // unrelated subsystems may still be live, so assert a strict decrease
      // by at least the two the route registered.
      expect(live.size).toBeLessThanOrEqual(peak - 2);
    } finally {
      (globalThis as { setInterval: typeof setInterval }).setInterval = originalSetInterval;
      (globalThis as { clearInterval: typeof clearInterval }).clearInterval = originalClearInterval;
      await app.close();
    }
  });
});
