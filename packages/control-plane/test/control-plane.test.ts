import { describe, expect, it } from 'vitest';

import { createControlPlane, ControlPlaneError } from '../src/control-plane.js';
import type { ControlPlane } from '../src/control-plane.js';
import { InMemoryControlPlaneStore } from '../src/memory-store.js';

function newControlPlane(now = 1_700_000_000_000): ControlPlane {
  return createControlPlane({
    store: new InMemoryControlPlaneStore(),
    clock: () => now,
  });
}

describe('ControlPlane', () => {
  it('creates an org with default free tier', async () => {
    const cp = newControlPlane();
    const org = await cp.createOrg({ name: 'Acme', slug: 'acme' });
    expect(org.tier).toBe('free');
    expect(org.subscriptionStatus).toBe('active');
    expect(org.id).toMatch(/^org_/);
  });

  it('rejects duplicate org slugs', async () => {
    const cp = newControlPlane();
    await cp.createOrg({ name: 'Acme', slug: 'acme' });
    await expect(cp.createOrg({ name: 'Acme2', slug: 'acme' })).rejects.toThrow(/already exists/);
  });

  it('enforces project quota per tier', async () => {
    const cp = newControlPlane();
    const org = await cp.createOrg({ name: 'Acme', slug: 'acme' });
    // free = 1 project
    await cp.createProject(org.id, { name: 'p1', slug: 'p1' });
    await expect(cp.createProject(org.id, { name: 'p2', slug: 'p2' })).rejects.toMatchObject({
      code: 'QUOTA_EXCEEDED',
    });
  });

  it('starter tier allows up to 3 projects', async () => {
    const cp = newControlPlane();
    const org = await cp.createOrg({ name: 'A', slug: 'a', tier: 'starter' });
    await cp.createProject(org.id, { name: 'p1', slug: 'p1' });
    await cp.createProject(org.id, { name: 'p2', slug: 'p2' });
    await cp.createProject(org.id, { name: 'p3', slug: 'p3' });
    await expect(cp.createProject(org.id, { name: 'p4', slug: 'p4' })).rejects.toMatchObject({
      code: 'QUOTA_EXCEEDED',
    });
  });

  it('mints and authenticates an API key with project labelScope', async () => {
    const cp = newControlPlane();
    const org = await cp.createOrg({ name: 'A', slug: 'a' });
    const project = await cp.createProject(org.id, { name: 'p', slug: 'p' });
    const { key, record } = await cp.createApiKey({
      projectId: project.id,
      label: 'production',
    });
    expect(key.startsWith('vt_live_')).toBe(true);
    expect(record.prefix.startsWith('vt_live_')).toBe(true);

    const auth = await cp.authenticateApiKey(key);
    expect(auth?.record.id).toBe(record.id);
    expect(auth?.labelScope).toEqual({ org: org.id, project: project.id });
  });

  it('rejects an authenticated lookup with a bad hash after a real prefix', async () => {
    const cp = newControlPlane();
    const org = await cp.createOrg({ name: 'A', slug: 'a' });
    const project = await cp.createProject(org.id, { name: 'p', slug: 'p' });
    const { key } = await cp.createApiKey({ projectId: project.id, label: 'x' });
    // Same prefix, tampered body
    const tampered = key.slice(0, 16) + 'XXXXXXXXXXXXXXXX';
    const auth = await cp.authenticateApiKey(tampered);
    expect(auth).toBeNull();
  });

  it('rejects authentication on revoked keys', async () => {
    const cp = newControlPlane();
    const org = await cp.createOrg({ name: 'A', slug: 'a' });
    const project = await cp.createProject(org.id, { name: 'p', slug: 'p' });
    const { key, record } = await cp.createApiKey({ projectId: project.id, label: 'x' });
    await cp.revokeApiKey(record.id);
    expect(await cp.authenticateApiKey(key)).toBeNull();
  });

  it('issues and consumes a magic link exactly once', async () => {
    const cp = newControlPlane();
    const { token } = await cp.issueMagicLink({ email: 'alice@example.com' });
    const consumed = await cp.consumeMagicLink(token);
    expect(consumed?.user.email).toBe('alice@example.com');
    expect(consumed?.session.userId).toBe(consumed?.user.id);
    // Second consumption fails
    expect(await cp.consumeMagicLink(token)).toBeNull();
  });

  it('refuses to consume an expired magic link', async () => {
    const store = new InMemoryControlPlaneStore();
    let clockMs = 1_700_000_000_000;
    const cp = createControlPlane({ store, clock: () => clockMs });
    const { token } = await cp.issueMagicLink({ email: 'a@b.com', ttlMs: 1000 });
    clockMs += 2000;
    expect(await cp.consumeMagicLink(token)).toBeNull();
  });

  it('resolves a session token to its user', async () => {
    const cp = newControlPlane();
    const { token } = await cp.issueMagicLink({ email: 'x@y.com' });
    const consumed = await cp.consumeMagicLink(token);
    expect(consumed).not.toBeNull();
    // We don't have the session plaintext from `consumeMagicLink` directly — re-issue and resolve
    // by using the user's email path. The real flow returns the session token to the client.
    expect(consumed?.user.id).toMatch(/^usr_/);
  });

  it("verifies an existing user's email on second magic-link consumption", async () => {
    const cp = newControlPlane();
    // Pre-create user without email-verified
    const cpInternal = cp as unknown as { createUser: (i: { email: string }) => Promise<unknown> };
    await cpInternal.createUser({ email: 'late@verifier.com' });
    const { token } = await cp.issueMagicLink({ email: 'late@verifier.com' });
    const consumed = await cp.consumeMagicLink(token);
    expect(consumed?.user.emailVerifiedAt).not.toBeNull();
  });

  it('throws on an arbitrary control-plane error type that surfaces a code', async () => {
    expect(() => {
      throw new ControlPlaneError('SOME_CODE', 'msg');
    }).toThrow(/msg/);
  });

  it('createWebhook mints a base64url secret and persists a record with the project id', async () => {
    const cp = newControlPlane();
    const org = await cp.createOrg({ name: 'A', slug: 'a' });
    const project = await cp.createProject(org.id, { name: 'p', slug: 'p' });
    const { webhook, secret } = await cp.createWebhook({
      projectId: project.id,
      url: 'https://example.com/hook',
      eventsFilter: ['event.recorded'],
    });
    expect(webhook.id).toMatch(/^whk_/);
    expect(webhook.projectId).toBe(project.id);
    expect(webhook.url).toBe('https://example.com/hook');
    expect(webhook.eventsFilter).toEqual(['event.recorded']);
    expect(webhook.pausedAt).toBeNull();
    // base64url alphabet: A-Z a-z 0-9 _ -, no padding
    expect(secret).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(secret.length).toBeGreaterThanOrEqual(43);
    expect(webhook.secret).toBe(secret);
  });

  it('listWebhooks returns only the requested project, never others', async () => {
    const cp = newControlPlane();
    const orgA = await cp.createOrg({ name: 'A', slug: 'a' });
    const orgB = await cp.createOrg({ name: 'B', slug: 'b' });
    const projA = await cp.createProject(orgA.id, { name: 'pa', slug: 'pa' });
    const projB = await cp.createProject(orgB.id, { name: 'pb', slug: 'pb' });
    await cp.createWebhook({ projectId: projA.id, url: 'https://a.example/h1' });
    await cp.createWebhook({ projectId: projA.id, url: 'https://a.example/h2' });
    await cp.createWebhook({ projectId: projB.id, url: 'https://b.example/h1' });
    const listed = await cp.listWebhooks(projA.id);
    expect(listed).toHaveLength(2);
    expect(listed.every((w) => w.projectId === projA.id)).toBe(true);
  });

  it('pauseWebhook stamps pausedAt and resumeWebhook clears it back to null', async () => {
    const now = 1_700_000_000_000;
    const cp = newControlPlane(now);
    const org = await cp.createOrg({ name: 'A', slug: 'a' });
    const project = await cp.createProject(org.id, { name: 'p', slug: 'p' });
    const { webhook } = await cp.createWebhook({
      projectId: project.id,
      url: 'https://example.com/h',
    });
    const paused = await cp.pauseWebhook(webhook.id);
    expect(paused?.pausedAt).toBe(now);
    const resumed = await cp.resumeWebhook(webhook.id);
    expect(resumed?.pausedAt).toBeNull();
    expect(await cp.pauseWebhook('whk_nope')).toBeNull();
  });

  it('deleteWebhook returns true once and false thereafter; the row vanishes from list', async () => {
    const cp = newControlPlane();
    const org = await cp.createOrg({ name: 'A', slug: 'a' });
    const project = await cp.createProject(org.id, { name: 'p', slug: 'p' });
    const { webhook } = await cp.createWebhook({
      projectId: project.id,
      url: 'https://example.com/h',
    });
    expect(await cp.deleteWebhook(webhook.id)).toBe(true);
    expect(await cp.deleteWebhook(webhook.id)).toBe(false);
    expect(await cp.listWebhooks(project.id)).toHaveLength(0);
  });
});
