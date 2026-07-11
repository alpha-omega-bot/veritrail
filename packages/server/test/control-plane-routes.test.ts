import {
  createControlPlane,
  InMemoryControlPlaneStore,
  UsageTracker,
  type EmailAdapter,
  type EmailMessage,
} from '@veritrail/control-plane';
import { describe, expect, it } from 'vitest';

import { buildServer } from '../src/app.js';

class RecordingEmail implements EmailAdapter {
  readonly sent: Array<EmailMessage & { id: string }> = [];
  async send(msg: EmailMessage): Promise<{ id: string }> {
    const id = `em_${this.sent.length}`;
    this.sent.push({ ...msg, id });
    return { id };
  }
}

async function makeServer() {
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
  return { app, email, controlPlane };
}

describe('control-plane HTTP routes', () => {
  it('issues a magic link, emails it, and returns dev fallback when email succeeds', async () => {
    const { app, email } = await makeServer();
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/control/magic-link/request',
      payload: { email: 'alice@example.com' },
    });
    expect(res.statusCode).toBe(200);
    expect(email.sent).toHaveLength(1);
    expect(email.sent[0]?.to).toBe('alice@example.com');
    expect(email.sent[0]?.text ?? email.sent[0]?.html).toMatch(/magic-link\?token=/);
  });

  it('rejects an obviously bad email', async () => {
    const { app } = await makeServer();
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/control/magic-link/request',
      payload: { email: 'not-an-email' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('rejects an invalid magic-link token', async () => {
    const { app } = await makeServer();
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/control/magic-link/consume',
      payload: { token: 'fake-token' },
    });
    expect(res.statusCode).toBe(401);
  });

  it('end-to-end: request → consume → returns a session with an auto-created org and project', async () => {
    const { app, email, controlPlane } = await makeServer();
    void controlPlane;

    await app.inject({
      method: 'POST',
      url: '/api/v1/control/magic-link/request',
      payload: { email: 'bob@example.com' },
    });
    const sentText = email.sent[0]?.text ?? email.sent[0]?.html ?? '';
    const tokenMatch = sentText.match(/token=([A-Za-z0-9_-]+)/);
    expect(tokenMatch).not.toBeNull();
    const token = decodeURIComponent(tokenMatch![1]!);

    const consume = await app.inject({
      method: 'POST',
      url: '/api/v1/control/magic-link/consume',
      payload: { token },
    });
    expect(consume.statusCode).toBe(200);
    const body = JSON.parse(consume.body);
    expect(body.user.email).toBe('bob@example.com');
    expect(body.orgs).toHaveLength(1);
    expect(body.currentProjectId).toBeTruthy();
    expect(typeof body.token).toBe('string');
    expect(body.token.length).toBeGreaterThan(20);
  });

  it('rejects unauthenticated calls to api-keys/list', async () => {
    const { app } = await makeServer();
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/control/api-keys/list',
      payload: { projectId: 'fake' },
    });
    expect(res.statusCode).toBe(401);
  });

  it('mints and lists API keys after a fresh signup', async () => {
    const { app, email } = await makeServer();
    await app.inject({
      method: 'POST',
      url: '/api/v1/control/magic-link/request',
      payload: { email: 'carol@example.com' },
    });
    const sentText = email.sent[0]?.text ?? email.sent[0]?.html ?? '';
    const token = decodeURIComponent(sentText.match(/token=([A-Za-z0-9_-]+)/)![1]!);
    const consume = await app.inject({
      method: 'POST',
      url: '/api/v1/control/magic-link/consume',
      payload: { token },
    });
    const session = JSON.parse(consume.body);

    const create = await app.inject({
      method: 'POST',
      url: '/api/v1/control/api-keys/create',
      headers: { authorization: `Bearer ${session.token}` },
      payload: { projectId: session.currentProjectId, label: 'first' },
    });
    expect(create.statusCode).toBe(201);
    const created = JSON.parse(create.body);
    expect(created.key.startsWith('vt_live_')).toBe(true);
    expect(created.record.label).toBe('first');

    const list = await app.inject({
      method: 'POST',
      url: '/api/v1/control/api-keys/list',
      headers: { authorization: `Bearer ${session.token}` },
      payload: { projectId: session.currentProjectId },
    });
    expect(list.statusCode).toBe(200);
    const keys = JSON.parse(list.body);
    expect(keys).toHaveLength(1);
    expect(keys[0].label).toBe('first');
  });

  it('returns 404 for a non-existent project on api-keys/create', async () => {
    const { app, email } = await makeServer();
    await app.inject({
      method: 'POST',
      url: '/api/v1/control/magic-link/request',
      payload: { email: 'dan@example.com' },
    });
    const sentText = email.sent[0]?.text ?? email.sent[0]?.html ?? '';
    const token = decodeURIComponent(sentText.match(/token=([A-Za-z0-9_-]+)/)![1]!);
    const consume = await app.inject({
      method: 'POST',
      url: '/api/v1/control/magic-link/consume',
      payload: { token },
    });
    const session = JSON.parse(consume.body);
    const create = await app.inject({
      method: 'POST',
      url: '/api/v1/control/api-keys/create',
      headers: { authorization: `Bearer ${session.token}` },
      payload: { projectId: 'proj_nope', label: 'x' },
    });
    expect(create.statusCode).toBe(404);
  });

  it('billing/checkout endpoint is not registered without Stripe configuration', async () => {
    const { app, email } = await makeServer();
    await app.inject({
      method: 'POST',
      url: '/api/v1/control/magic-link/request',
      payload: { email: 'eve@example.com' },
    });
    const sentText = email.sent[0]?.text ?? email.sent[0]?.html ?? '';
    const token = decodeURIComponent(sentText.match(/token=([A-Za-z0-9_-]+)/)![1]!);
    const consume = await app.inject({
      method: 'POST',
      url: '/api/v1/control/magic-link/consume',
      payload: { token },
    });
    const session = JSON.parse(consume.body);
    const checkout = await app.inject({
      method: 'POST',
      url: '/api/v1/control/billing/checkout',
      headers: { authorization: `Bearer ${session.token}` },
      payload: { tier: 'pro' },
    });
    // The full billing route lives in @veritrail/server billing-routes.ts and
    // is registered conditionally; without it, the path 404s.
    expect(checkout.statusCode).toBe(404);
  });

  it('returns usage for an authenticated user', async () => {
    const { app, email } = await makeServer();
    await app.inject({
      method: 'POST',
      url: '/api/v1/control/magic-link/request',
      payload: { email: 'frank@example.com' },
    });
    const sentText = email.sent[0]?.text ?? email.sent[0]?.html ?? '';
    const token = decodeURIComponent(sentText.match(/token=([A-Za-z0-9_-]+)/)![1]!);
    const consume = await app.inject({
      method: 'POST',
      url: '/api/v1/control/magic-link/consume',
      payload: { token },
    });
    const session = JSON.parse(consume.body);
    const usage = await app.inject({
      method: 'POST',
      url: '/api/v1/control/usage',
      headers: { authorization: `Bearer ${session.token}` },
      payload: {},
    });
    expect(usage.statusCode).toBe(200);
    const body = JSON.parse(usage.body);
    expect(body.tier).toBe('free');
    expect(body.limit).toBeGreaterThan(0);
  });
});

describe('control-plane security defaults', () => {
  it('does not expose magic-link tokens when email is unavailable', async () => {
    const controlPlane = createControlPlane({ store: new InMemoryControlPlaneStore() });
    const app = await buildServer({ controlPlane: { controlPlane } });
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/control/magic-link/request',
      payload: { email: 'victim@example.com' },
    });
    expect(res.statusCode).toBe(503);
    expect(JSON.parse(res.body)).not.toHaveProperty('devLink');
  });
});
