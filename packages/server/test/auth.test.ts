import { describe, expect, it } from 'vitest';

import { ApiKeyAuthenticator, parseAuthHeader } from '../src/auth.js';

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

  it('validates API key configuration', () => {
    expect(
      () =>
        new ApiKeyAuthenticator({
          apiKeys: [{ id: 'bad', actorId: 'operator', secret: 'short', roles: ['admin'] }],
        }),
    ).toThrow();
  });
});
