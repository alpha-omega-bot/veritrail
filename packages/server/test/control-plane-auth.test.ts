import {
  createControlPlane,
  InMemoryControlPlaneStore,
  type ControlPlane,
} from '@veritrail/control-plane';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { beforeEach, describe, expect, it } from 'vitest';

import type { ApiKeyPrincipal } from '../src/auth.js';
import { createControlPlaneAuthPreHandler } from '../src/control-plane-auth.js';

interface RequestStub {
  headers: Record<string, string | undefined>;
  principal?: ApiKeyPrincipal | undefined;
}

function makeRequest(headers: Record<string, string | undefined> = {}): RequestStub {
  return { headers };
}

function asFastifyRequest(stub: RequestStub): FastifyRequest {
  return stub as unknown as FastifyRequest;
}

const replyStub = {} as unknown as FastifyReply;

async function mintFixture(): Promise<{
  controlPlane: ControlPlane;
  key: string;
  orgId: string;
  projectId: string;
  apiKeyId: string;
  store: InMemoryControlPlaneStore;
}> {
  const store = new InMemoryControlPlaneStore();
  const controlPlane = createControlPlane({ store });
  const org = await controlPlane.createOrg({ name: 'Acme', slug: 'acme' });
  const project = await controlPlane.createProject(org.id, { name: 'Web', slug: 'web' });
  const { key, record } = await controlPlane.createApiKey({
    projectId: project.id,
    label: 'production server',
  });
  return {
    controlPlane,
    key,
    orgId: org.id,
    projectId: project.id,
    apiKeyId: record.id,
    store,
  };
}

describe('createControlPlaneAuthPreHandler', () => {
  let controlPlane: ControlPlane;

  beforeEach(async () => {
    const store = new InMemoryControlPlaneStore();
    controlPlane = createControlPlane({ store });
  });

  it('is a no-op when no credential header is present', async () => {
    const preHandler = createControlPlaneAuthPreHandler({ controlPlane });
    const request = makeRequest();
    await preHandler(asFastifyRequest(request), replyStub);
    expect(request.principal).toBeUndefined();
  });

  it('is a no-op when the credential does not carry the vt_live_ prefix', async () => {
    const preHandler = createControlPlaneAuthPreHandler({ controlPlane });
    const request = makeRequest({ authorization: 'Bearer static-allow-list-key' });
    await preHandler(asFastifyRequest(request), replyStub);
    expect(request.principal).toBeUndefined();
  });

  it('resolves a valid control-plane key to a principal with org/project labelScope', async () => {
    const fixture = await mintFixture();
    const preHandler = createControlPlaneAuthPreHandler({ controlPlane: fixture.controlPlane });
    const request = makeRequest({ authorization: `Bearer ${fixture.key}` });
    await preHandler(asFastifyRequest(request), replyStub);
    expect(request.principal).toBeDefined();
    expect(request.principal?.id).toBe(fixture.apiKeyId);
    expect(request.principal?.roles).toEqual(['operator', 'ingest']);
    expect(request.principal?.scopes).toBeUndefined();
    expect(request.principal?.labelScope).toEqual({
      org: fixture.orgId,
      project: fixture.projectId,
    });
  });

  it('reads the credential from X-Veritrail-Api-Key when Authorization is absent', async () => {
    const fixture = await mintFixture();
    const preHandler = createControlPlaneAuthPreHandler({ controlPlane: fixture.controlPlane });
    const request = makeRequest({ 'x-veritrail-api-key': fixture.key });
    await preHandler(asFastifyRequest(request), replyStub);
    expect(request.principal?.id).toBe(fixture.apiKeyId);
    expect(request.principal?.labelScope).toEqual({
      org: fixture.orgId,
      project: fixture.projectId,
    });
  });

  it('does not set a principal for a revoked key and does not throw', async () => {
    const fixture = await mintFixture();
    await fixture.controlPlane.revokeApiKey(fixture.apiKeyId);
    const preHandler = createControlPlaneAuthPreHandler({ controlPlane: fixture.controlPlane });
    const request = makeRequest({ authorization: `Bearer ${fixture.key}` });
    await expect(preHandler(asFastifyRequest(request), replyStub)).resolves.toBeUndefined();
    expect(request.principal).toBeUndefined();
  });

  it('does not set a principal for an unknown prefix and does not throw', async () => {
    const preHandler = createControlPlaneAuthPreHandler({ controlPlane });
    const forged = 'vt_live_abcdefgh_thisprefixwasnevermintedaaaaaaaaaaaa';
    const request = makeRequest({ authorization: `Bearer ${forged}` });
    await expect(preHandler(asFastifyRequest(request), replyStub)).resolves.toBeUndefined();
    expect(request.principal).toBeUndefined();
  });

  it('does not overwrite a principal set by an earlier preHandler', async () => {
    const fixture = await mintFixture();
    const preHandler = createControlPlaneAuthPreHandler({ controlPlane: fixture.controlPlane });
    const existing: ApiKeyPrincipal = {
      id: 'static-key',
      actorId: 'static-actor',
      roles: ['admin'],
    };
    const request: RequestStub = {
      headers: { authorization: `Bearer ${fixture.key}` },
      principal: existing,
    };
    await preHandler(asFastifyRequest(request), replyStub);
    expect(request.principal).toBe(existing);
  });
});
