import {
  createControlPlane,
  InMemoryControlPlaneStore,
  type Webhook,
} from '@veritrail/control-plane';
import { describe, expect, it } from 'vitest';

import { buildServer } from '../src/app.js';
import { installWebhookFanout } from '../src/webhook-fanout-hook.js';

interface OutboxEntry {
  readonly id: string;
  readonly webhookId: string;
  readonly url: string;
  readonly secret: string;
  readonly payload: unknown;
  readonly eventType: string;
  readonly queuedAt: number;
  readonly nextAttemptAt: number;
}

function makeOutbox(): { entries: OutboxEntry[]; enqueue: (e: OutboxEntry) => Promise<unknown> } {
  const entries: OutboxEntry[] = [];
  return {
    entries,
    enqueue: async (entry: OutboxEntry) => {
      entries.push(entry);
      return entry;
    },
  };
}

async function makeServerWithFanout(outbox: ReturnType<typeof makeOutbox>): Promise<{
  app: Awaited<ReturnType<typeof buildServer>>;
  controlPlane: ReturnType<typeof createControlPlane>;
  projectId: string;
}> {
  const store = new InMemoryControlPlaneStore();
  const controlPlane = createControlPlane({ store });
  const org = await controlPlane.createOrg({ name: 'Acme', slug: 'acme' });
  const project = await controlPlane.createProject(org.id, { name: 'Demo', slug: 'demo' });
  const app = await buildServer({
    controlPlane: { controlPlane, consoleUrl: 'http://localhost:5173' },
  });
  installWebhookFanout(app, { controlPlane, outbox });
  await app.ready();
  return { app, controlPlane, projectId: project.id };
}

async function registerWebhook(
  controlPlane: ReturnType<typeof createControlPlane>,
  projectId: string,
  eventsFilter: ReadonlyArray<string> = [],
): Promise<Webhook> {
  const { webhook } = await controlPlane.createWebhook({
    projectId,
    url: 'https://example.com/hook',
    eventsFilter,
  });
  return webhook;
}

describe('installWebhookFanout', () => {
  it('enqueues one outbox entry per matching subscription after a successful append', async () => {
    const outbox = makeOutbox();
    const { app, controlPlane, projectId } = await makeServerWithFanout(outbox);
    const webhook = await registerWebhook(controlPlane, projectId);

    const res = await app.inject({
      method: 'POST',
      url: '/api/events',
      payload: {
        type: 'note',
        actorId: 'smoke',
        payload: { text: 'hi' },
        labels: { project: projectId },
      },
    });

    expect(res.statusCode).toBe(201);
    await app.veritrailFanoutSettled!();
    expect(outbox.entries).toHaveLength(1);
    const entry = outbox.entries[0]!;
    expect(entry.webhookId).toBe(webhook.id);
    expect(entry.url).toBe('https://example.com/hook');
    expect(entry.eventType).toBe('note');
    const payload = entry.payload as { event_type: string; seq: number; record: { seq: number } };
    expect(payload.event_type).toBe('note');
    expect(payload.seq).toBe(1);
    expect(payload.record.seq).toBe(1);

    await app.close();
  });

  it('does not dispatch when the appended event has no project label', async () => {
    const outbox = makeOutbox();
    const { app, controlPlane, projectId } = await makeServerWithFanout(outbox);
    await registerWebhook(controlPlane, projectId);

    const res = await app.inject({
      method: 'POST',
      url: '/api/events',
      payload: {
        type: 'note',
        actorId: 'smoke',
        payload: { text: 'hi' },
      },
    });

    expect(res.statusCode).toBe(201);
    await app.veritrailFanoutSettled!();
    expect(outbox.entries).toEqual([]);

    await app.close();
  });

  it('logs but does not propagate dispatch errors to the response', async () => {
    const failingOutbox = {
      entries: [] as OutboxEntry[],
      enqueue: async (_entry: OutboxEntry) => {
        throw new Error('outbox boom');
      },
    };
    const store = new InMemoryControlPlaneStore();
    const controlPlane = createControlPlane({ store });
    const org = await controlPlane.createOrg({ name: 'Acme', slug: 'acme' });
    const project = await controlPlane.createProject(org.id, { name: 'Demo', slug: 'demo' });
    await controlPlane.createWebhook({
      projectId: project.id,
      url: 'https://example.com/hook',
      eventsFilter: [],
    });

    const app = await buildServer({
      controlPlane: { controlPlane, consoleUrl: 'http://localhost:5173' },
    });
    const errors: Array<{ err: unknown; msg: string }> = [];
    app.log.error = ((arg1: unknown, arg2?: unknown) => {
      if (typeof arg1 === 'string') {
        errors.push({ err: undefined, msg: arg1 });
      } else if (arg1 && typeof arg1 === 'object') {
        errors.push({ err: (arg1 as { err?: unknown }).err, msg: String(arg2 ?? '') });
      }
    }) as unknown as typeof app.log.error;
    installWebhookFanout(app, { controlPlane, outbox: failingOutbox });
    await app.ready();

    const res = await app.inject({
      method: 'POST',
      url: '/api/events',
      payload: {
        type: 'note',
        actorId: 'smoke',
        payload: { text: 'hi' },
        labels: { project: project.id },
      },
    });

    expect(res.statusCode).toBe(201);
    await app.veritrailFanoutSettled!();
    expect(failingOutbox.entries).toHaveLength(0);
    expect(errors.some((e) => e.msg === 'webhook fanout failed')).toBe(true);

    await app.close();
  });

  it('does not dispatch when the /api/events response is non-2xx', async () => {
    const outbox = makeOutbox();
    const { app, controlPlane, projectId } = await makeServerWithFanout(outbox);
    await registerWebhook(controlPlane, projectId);

    const res = await app.inject({
      method: 'POST',
      url: '/api/events',
      payload: { type: 'note', actorId: '' },
    });

    expect(res.statusCode).toBeGreaterThanOrEqual(400);
    await app.veritrailFanoutSettled!();
    expect(outbox.entries).toEqual([]);

    await app.close();
  });
});
