import { describe, expect, it } from 'vitest';

import {
  ApiKeyAuthenticator,
  hasAccess,
  parseApiKeyEntries,
  parseAuthHeader,
} from '../src/auth.js';

describe('ApiKeyAuthenticator', () => {
  it('authenticates bearer tokens and applies admin role inheritance', () => {
    const auth = new ApiKeyAuthenticator({
      apiKeys: [
        {
          id: 'admin',
          actorId: 'operator-1',
          secret: 'admin-secret-0001',
          roles: ['admin'],
        },
      ],
    });

    const result = auth.authenticate(parseAuthHeader('Bearer admin-secret-0001'), ['operator']);

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.principal.actorId).toBe('operator-1');
  });

  it('rejects missing, invalid, and under-scoped keys', () => {
    const auth = new ApiKeyAuthenticator({
      apiKeys: [
        {
          id: 'ingest',
          actorId: 'agent-key-1',
          secret: 'ingest-secret-0001',
          roles: ['ingest'],
        },
      ],
    });

    expect(auth.authenticate(undefined, ['ingest'])).toMatchObject({
      ok: false,
      failure: { reason: 'missing' },
    });
    expect(auth.authenticate('wrong-secret-0001', ['ingest'])).toMatchObject({
      ok: false,
      failure: { reason: 'invalid' },
    });
    expect(auth.authenticate('ingest-secret-0001', ['admin'])).toMatchObject({
      ok: false,
      failure: { reason: 'forbidden' },
    });
  });

  it('allows scope-free keys through scoped routes for backwards compatibility', () => {
    const auth = new ApiKeyAuthenticator({
      apiKeys: [
        {
          id: 'operator',
          actorId: 'operator-1',
          secret: 'operator-secret-0001',
          roles: ['operator'],
        },
      ],
    });

    const result = auth.authenticate('operator-secret-0001', {
      roles: ['operator'],
      scope: 'audit:read',
    });

    expect(result.ok).toBe(true);
  });

  it('enforces configured route scopes after the role check succeeds', () => {
    const auth = new ApiKeyAuthenticator({
      apiKeys: [
        {
          id: 'audit-reader',
          actorId: 'operator-1',
          secret: 'audit-secret-0001',
          roles: ['operator'],
          scopes: ['audit:read'],
        },
        {
          id: 'admin',
          actorId: 'admin-1',
          secret: 'admin-secret-0001',
          roles: ['admin'],
          scopes: ['spend:read'],
        },
      ],
    });

    expect(
      auth.authenticate('audit-secret-0001', { roles: ['operator'], scope: 'audit:read' }),
    ).toMatchObject({ ok: true });
    expect(
      auth.authenticate('audit-secret-0001', { roles: ['operator'], scope: 'spend:read' }),
    ).toMatchObject({
      ok: false,
      failure: { reason: 'forbidden' },
    });
    expect(
      auth.authenticate('admin-secret-0001', { roles: ['operator'], scope: 'audit:read' }),
    ).toMatchObject({ ok: true });
  });

  it('checks roles before scopes', () => {
    expect(
      hasAccess(
        { id: 'ingest', actorId: 'agent-1', roles: ['ingest'], scopes: ['audit:read'] },
        { roles: ['operator'], scope: 'audit:read' },
      ),
    ).toBe(false);
  });

  it('validates API key configuration', () => {
    expect(
      () =>
        new ApiKeyAuthenticator({
          apiKeys: [{ id: 'bad', actorId: 'operator', secret: 'short', roles: ['admin'] }],
        }),
    ).toThrow();

    expect(
      () =>
        new ApiKeyAuthenticator({
          apiKeys: [
            {
              id: 'bad-scope',
              actorId: 'operator',
              secret: 'operator-secret-0001',
              roles: ['operator'],
              scopes: ['not-a-scope' as 'audit:read'],
            },
          ],
        }),
    ).toThrow();
  });
});

describe('parseApiKeyEntries', () => {
  it('parses roles and colon-bearing scopes from env entries', () => {
    expect(
      parseApiKeyEntries('audit:operator-1:audit-secret-0001:operator:audit:read|rollback:execute'),
    ).toEqual([
      {
        id: 'audit',
        actorId: 'operator-1',
        secret: 'audit-secret-0001',
        roles: ['operator'],
        scopes: ['audit:read', 'rollback:execute'],
      },
    ]);
  });

  it('rejects malformed roles and scopes instead of broadening access', () => {
    expect(() => parseApiKeyEntries('bad:operator-1:secret-0001:unknown')).toThrow();
    expect(() => parseApiKeyEntries('bad:operator-1:secret-0001:operator:audit')).toThrow();
  });
});
