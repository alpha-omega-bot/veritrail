import { createControlPlane, InMemoryControlPlaneStore } from '@veritrail/control-plane';
import { describe, expect, it } from 'vitest';

import { buildServer } from '../src/app.js';
import { registerWebhookRoutes } from '../src/webhook-routes.js';

async function makeServer() {
  const store = new InMemoryControlPlaneStore();
  const controlPlane = createControlPlane({ store });
  const app = await buildServer({
    controlPlane: {
      controlPlane,
      consoleUrl: 'http://localhost:5173',
      allowInsecureDevMagicLinks: true,
    },
  });
  registerWebhookRoutes(app, { controlPlane });
  await app.ready();
  return { app, controlPlane };
}

async function signUpAndGetSession(
  app: Awaited<ReturnType<typeof makeServer>>['app'],
  email: string,
): Promise<{ token: string; projectId: string }> {
  const requested = await app.inject({
    method: 'POST',
    url: '/api/v1/control/magic-link/request',
    payload: { email },
  });
  const { devLink } = JSON.parse(requested.body) as { devLink: string };
  const linkToken = decodeURIComponent(devLink.match(/token=([A-Za-z0-9_-]+)/)![1]!);
  const consume = await app.inject({
    method: 'POST',
    url: '/api/v1/control/magic-link/consume',
    payload: { token: linkToken },
  });
  const session = JSON.parse(consume.body) as { token: string; currentProjectId: string };
  return { token: session.token, projectId: session.currentProjectId };
}

describe('webhook routes', () => {
  it('rejects unauthenticated calls', async () => {
    const { app } = await makeServer();
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/control/webhooks/list',
      payload: { projectId: 'whatever' },
    });
    expect(res.statusCode).toBe(401);
  });

  it('creates a webhook and returns the secret exactly once', async () => {
    const { app } = await makeServer();
    const { token, projectId } = await signUpAndGetSession(app, 'wh-create@example.com');

    const create = await app.inject({
      method: 'POST',
      url: '/api/v1/control/webhooks/create',
      headers: { authorization: `Bearer ${token}` },
      payload: {
        projectId,
        url: 'https://example.com/hook',
        eventsFilter: ['event.recorded'],
      },
    });
    expect(create.statusCode).toBe(201);
    const body = JSON.parse(create.body) as {
      secret: string;
      webhook: { id: string; url: string; eventsFilter: string[]; pausedAt: number | null };
    };
    expect(body.secret).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(body.secret.length).toBeGreaterThanOrEqual(43);
    expect(body.webhook.id).toMatch(/^whk_/);
    expect(body.webhook.url).toBe('https://example.com/hook');
    expect(body.webhook.eventsFilter).toEqual(['event.recorded']);
    expect(body.webhook.pausedAt).toBeNull();

    // List comes back without the plaintext secret in the wire format.
    const list = await app.inject({
      method: 'POST',
      url: '/api/v1/control/webhooks/list',
      headers: { authorization: `Bearer ${token}` },
      payload: { projectId },
    });
    expect(list.statusCode).toBe(200);
    const records = JSON.parse(list.body) as Array<Record<string, unknown>>;
    expect(records).toHaveLength(1);
    expect(records[0]?.id).toBe(body.webhook.id);
    expect(records[0]).not.toHaveProperty('secret');
  });

  it('rejects a webhook with a non-http url', async () => {
    const { app } = await makeServer();
    const { token, projectId } = await signUpAndGetSession(app, 'wh-badurl@example.com');
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/control/webhooks/create',
      headers: { authorization: `Bearer ${token}` },
      payload: { projectId, url: 'javascript:alert(1)' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('pauses and then resumes a webhook, then deletes it', async () => {
    const { app } = await makeServer();
    const { token, projectId } = await signUpAndGetSession(app, 'wh-lifecycle@example.com');

    const create = await app.inject({
      method: 'POST',
      url: '/api/v1/control/webhooks/create',
      headers: { authorization: `Bearer ${token}` },
      payload: { projectId, url: 'https://example.com/hook' },
    });
    const { webhook } = JSON.parse(create.body) as { webhook: { id: string } };

    const pause = await app.inject({
      method: 'POST',
      url: '/api/v1/control/webhooks/pause',
      headers: { authorization: `Bearer ${token}` },
      payload: { id: webhook.id },
    });
    expect(pause.statusCode).toBe(200);
    const pausedBody = JSON.parse(pause.body) as { ok: boolean; pausedAt: number | null };
    expect(pausedBody.ok).toBe(true);
    expect(typeof pausedBody.pausedAt).toBe('number');

    const resume = await app.inject({
      method: 'POST',
      url: '/api/v1/control/webhooks/resume',
      headers: { authorization: `Bearer ${token}` },
      payload: { id: webhook.id },
    });
    expect(resume.statusCode).toBe(200);
    const resumedBody = JSON.parse(resume.body) as { ok: boolean; pausedAt: number | null };
    expect(resumedBody.pausedAt).toBeNull();

    const del = await app.inject({
      method: 'POST',
      url: '/api/v1/control/webhooks/delete',
      headers: { authorization: `Bearer ${token}` },
      payload: { id: webhook.id },
    });
    expect(del.statusCode).toBe(200);

    const list = await app.inject({
      method: 'POST',
      url: '/api/v1/control/webhooks/list',
      headers: { authorization: `Bearer ${token}` },
      payload: { projectId },
    });
    expect(JSON.parse(list.body)).toHaveLength(0);

    const delAgain = await app.inject({
      method: 'POST',
      url: '/api/v1/control/webhooks/delete',
      headers: { authorization: `Bearer ${token}` },
      payload: { id: webhook.id },
    });
    expect(delAgain.statusCode).toBe(404);
  });

  it('denies a member of another org from managing a project it does not belong to', async () => {
    const { app } = await makeServer();
    const owner = await signUpAndGetSession(app, 'wh-owner@example.com');
    const outsider = await signUpAndGetSession(app, 'wh-outsider@example.com');

    // The owner creates a webhook in its own project.
    const create = await app.inject({
      method: 'POST',
      url: '/api/v1/control/webhooks/create',
      headers: { authorization: `Bearer ${owner.token}` },
      payload: { projectId: owner.projectId, url: 'https://example.com/hook' },
    });
    expect(create.statusCode).toBe(201);
    const { webhook } = JSON.parse(create.body) as { webhook: { id: string } };

    // The outsider cannot create in the owner's project.
    const foreignCreate = await app.inject({
      method: 'POST',
      url: '/api/v1/control/webhooks/create',
      headers: { authorization: `Bearer ${outsider.token}` },
      payload: { projectId: owner.projectId, url: 'https://evil.example.com/hook' },
    });
    expect(foreignCreate.statusCode).toBe(403);

    // The outsider cannot enumerate the owner's webhooks.
    const foreignList = await app.inject({
      method: 'POST',
      url: '/api/v1/control/webhooks/list',
      headers: { authorization: `Bearer ${outsider.token}` },
      payload: { projectId: owner.projectId },
    });
    expect(foreignList.statusCode).toBe(403);

    // The outsider cannot pause, resume, or delete the owner's webhook by id.
    for (const action of ['pause', 'resume', 'delete']) {
      const res = await app.inject({
        method: 'POST',
        url: `/api/v1/control/webhooks/${action}`,
        headers: { authorization: `Bearer ${outsider.token}` },
        payload: { id: webhook.id },
      });
      expect(res.statusCode).toBe(403);
    }

    // The owner's webhook is untouched.
    const ownerList = await app.inject({
      method: 'POST',
      url: '/api/v1/control/webhooks/list',
      headers: { authorization: `Bearer ${owner.token}` },
      payload: { projectId: owner.projectId },
    });
    expect(JSON.parse(ownerList.body)).toHaveLength(1);
  });

  it('rejects webhook targets on private networks', async () => {
    const { app } = await makeServer();
    const { token, projectId } = await signUpAndGetSession(app, 'wh-ssrf@example.com');
    for (const target of [
      'http://127.0.0.1/admin',
      'http://169.254.169.254/latest/meta-data',
      'http://10.0.0.1/hook',
      'http://[::1]/hook',
      'http://localhost/hook',
    ]) {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/control/webhooks/create',
        headers: { authorization: 'Bearer ' + token },
        payload: { projectId, url: target },
      });
      expect(res.statusCode).toBe(400);
    }
  });
});
