import {
  createControlPlane,
  InMemoryControlPlaneStore,
  UsageTracker,
  type EmailAdapter,
  type EmailMessage,
} from '@veritrail/control-plane';
import { describe, expect, it } from 'vitest';

import { buildServer } from '../src/app.js';

/**
 * Recording email adapter used to capture the magic-link body so the test
 * can extract the consume token without depending on a real mailer.
 */
class RecordingEmail implements EmailAdapter {
  readonly sent: Array<EmailMessage & { id: string }> = [];
  async send(msg: EmailMessage): Promise<{ id: string }> {
    const id = `em_${this.sent.length}`;
    this.sent.push({ ...msg, id });
    return { id };
  }
}

interface SseReadResult {
  readonly frames: string[];
  readonly status: number;
  readonly contentType: string | null;
}

/**
 * Open an SSE connection, read until the first complete frame arrives or
 * the deadline elapses, then abort. Mirrors readFrames in
 * stream-routes.test.ts but exits on first frame.
 */
async function readFirstFrame(url: string, durationMs: number): Promise<SseReadResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), durationMs);
  const frames: string[] = [];
  let status = 0;
  let contentType: string | null = null;
  try {
    const res = await fetch(url, { signal: controller.signal });
    status = res.status;
    contentType = res.headers.get('content-type');
    if (res.body) {
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const parts = buf.split('\n\n');
        buf = parts.pop() ?? '';
        for (const frame of parts) frames.push(frame);
        if (frames.length > 0) {
          await reader.cancel().catch(() => undefined);
          controller.abort();
          break;
        }
      }
    }
  } catch (err) {
    if ((err as { name?: string }).name !== 'AbortError') throw err;
  } finally {
    clearTimeout(timer);
  }
  return { frames, status, contentType };
}

describe('end-to-end smoke', () => {
  it('signup → API key → usage → ingest → audit → SSE → openapi', async () => {
    // 1. Build a server wired with the in-memory control plane and
    //    recording email adapter, adapted from control-plane-routes.test.ts.
    const store = new InMemoryControlPlaneStore();
    const controlPlane = createControlPlane({ store });
    const usage = new UsageTracker({ flush: async () => {} });
    const email = new RecordingEmail();
    const app = await buildServer({
      controlPlane: {
        controlPlane,
        usage,
        email,
        consoleUrl: 'http://localhost:5173',
      },
    });

    try {
      // 2. Request a magic link for smoke@example.com.
      const magicReq = await app.inject({
        method: 'POST',
        url: '/api/v1/control/magic-link/request',
        payload: { email: 'smoke@example.com' },
      });
      expect(magicReq.statusCode).toBe(200);

      // 3. Extract the link from the recorded email body.
      const body = email.sent[0]?.text ?? email.sent[0]?.html ?? '';
      const tokenMatch = body.match(/token=([A-Za-z0-9_-]+)/);
      expect(tokenMatch).not.toBeNull();
      const magicToken = decodeURIComponent(tokenMatch![1]!);

      // 4. Consume the link and capture the session bearer.
      const consume = await app.inject({
        method: 'POST',
        url: '/api/v1/control/magic-link/consume',
        payload: { token: magicToken },
      });
      expect(consume.statusCode).toBe(200);
      const session = JSON.parse(consume.body) as {
        token: string;
        currentProjectId: string;
      };

      // 5. Use the session bearer to mint a new API key.
      const apiKeyRes = await app.inject({
        method: 'POST',
        url: '/api/v1/control/api-keys/create',
        headers: { authorization: `Bearer ${session.token}` },
        payload: { projectId: session.currentProjectId, label: 'smoke' },
      });
      expect(apiKeyRes.statusCode).toBe(201);

      // 6. Query usage and assert the free-tier defaults are wired up.
      const usageRes = await app.inject({
        method: 'POST',
        url: '/api/v1/control/usage',
        headers: { authorization: `Bearer ${session.token}` },
        payload: {},
      });
      const usageBody = JSON.parse(usageRes.body) as { tier: string; limit: number };
      expect(usageBody.tier === 'free' && usageBody.limit > 0).toBe(true);

      // 7. Append a note event through the ingest route.
      const append = await app.inject({
        method: 'POST',
        url: '/api/events',
        payload: {
          type: 'note',
          actorId: 'agent-smoke',
          payload: { text: 'smoke' },
        },
      });
      expect(append.statusCode).toBe(201);

      // 8. Query the audit summary. The runtime field is `totalRecords`;
      //    fall back to it if a future rename to `totalEvents` lands.
      const summary = await app.inject({ method: 'GET', url: '/api/audit/summary' });
      const summaryBody = JSON.parse(summary.body) as {
        totalRecords?: number;
        totalEvents?: number;
      };
      expect((summaryBody.totalEvents ?? summaryBody.totalRecords ?? 0) >= 1).toBe(true);

      // 9. Hit the SSE stream and assert the first frame is the connect comment.
      await app.listen({ port: 0, host: '127.0.0.1' });
      const addr = app.server.address();
      const port = typeof addr === 'object' && addr !== null ? addr.port : 0;
      const sse = await readFirstFrame(`http://127.0.0.1:${port}/api/audit/events/stream`, 1500);
      expect(sse.frames[0]?.startsWith(': connected')).toBe(true);

      // 10. Verify the OpenAPI document is served at the canonical 3.1.0 version.
      const openapi = await app.inject({ method: 'GET', url: '/api/openapi.json' });
      const openapiBody = JSON.parse(openapi.body) as { openapi: string };
      expect(openapiBody.openapi).toBe('3.1.0');
    } finally {
      await app.close();
    }
  }, 30_000);
});
