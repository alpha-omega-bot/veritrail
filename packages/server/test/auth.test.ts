import {
  generateKeyPairSync,
  sign as signJwtBytes,
  type JsonWebKey,
  type KeyObject,
} from 'node:crypto';

import { describe, expect, it } from 'vitest';
import { asJson, hashJson } from '@veritrail/core';

import {
  ApiKeyAuthenticator,
  hasAccess,
  parseApiKeyEntries,
  parseAuthHeader,
  signAdminAction,
  type AdminActionSignatureReceipt,
} from '../src/auth.js';

const OIDC_ISSUER = 'https://idp.example.test/';
const OIDC_AUDIENCE = 'veritrail-server';
const OIDC_NOW = 1_700_000_000_000;

function oidcFixture(): { privateKey: KeyObject; jwk: JsonWebKey } {
  const pair = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const publicJwk = pair.publicKey.export({ format: 'jwk' });
  return {
    privateKey: pair.privateKey,
    jwk: { ...publicJwk, kid: 'oidc-key-1', alg: 'RS256' },
  };
}

function jwtFrom(
  privateKey: KeyObject,
  claims: Record<string, unknown>,
  header: Record<string, unknown> = {},
): string {
  const encodedHeader = base64UrlJson({ alg: 'RS256', kid: 'oidc-key-1', typ: 'JWT', ...header });
  const encodedClaims = base64UrlJson(claims);
  const signingInput = `${encodedHeader}.${encodedClaims}`;
  const signature = signJwtBytes('RSA-SHA256', Buffer.from(signingInput, 'utf8'), privateKey);
  return `${signingInput}.${signature.toString('base64url')}`;
}

function baseClaims(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    iss: OIDC_ISSUER,
    sub: 'operator-oidc',
    aud: OIDC_AUDIENCE,
    exp: OIDC_NOW / 1000 + 300,
    iat: OIDC_NOW / 1000,
    groups: ['veritrail-operators'],
    veritrail_scopes: 'audit:read forensics:read',
    labels: { tenant: 'acme', project: 'alpha' },
    ...overrides,
  };
}

function base64UrlJson(value: unknown): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

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

  it('verifies signed administrative action requests and rejects tampering', () => {
    const auth = new ApiKeyAuthenticator({
      adminActionSigning: {
        secret: 'admin-action-signing-secret-0001',
        keyId: 'admin-action',
        maxSkewMs: 60_000,
      },
      apiKeys: [
        {
          id: 'admin',
          actorId: 'operator-1',
          secret: 'admin-secret-0001',
          roles: ['admin'],
        },
      ],
    });
    const receipt: AdminActionSignatureReceipt = {
      keyId: 'admin-action',
      timestamp: 1_700_000_000_000,
      nonce: 'nonce-1',
      method: 'POST',
      path: '/api/permissions/policies',
      bodyHash: '0'.repeat(64),
      algorithm: 'hmac-sha256',
    };
    const signature = signAdminAction('admin-action-signing-secret-0001', receipt);

    expect(
      auth.verifyAdminActionSignature({
        method: 'POST',
        path: '/api/permissions/policies',
        body: null,
        timestamp: String(receipt.timestamp),
        nonce: receipt.nonce,
        keyId: receipt.keyId,
        signature,
        now: receipt.timestamp,
      }),
    ).toMatchObject({
      ok: false,
      error: { message: 'admin action signature is invalid' },
    });

    const matchingBodyReceipt: AdminActionSignatureReceipt = {
      ...receipt,
      bodyHash: hashJson(asJson(null)),
    };
    const matchingSignature = signAdminAction(
      'admin-action-signing-secret-0001',
      matchingBodyReceipt,
    );
    expect(
      auth.verifyAdminActionSignature({
        method: 'POST',
        path: '/api/permissions/policies',
        body: null,
        timestamp: String(matchingBodyReceipt.timestamp),
        nonce: matchingBodyReceipt.nonce,
        keyId: matchingBodyReceipt.keyId,
        signature: matchingSignature,
        now: matchingBodyReceipt.timestamp,
      }),
    ).toMatchObject({ ok: true });
  });

  it('authenticates RS256 OIDC bearer tokens into the existing principal model', () => {
    const { privateKey, jwk } = oidcFixture();
    const auth = new ApiKeyAuthenticator({
      oidc: {
        issuer: OIDC_ISSUER,
        audience: OIDC_AUDIENCE,
        jwks: { keys: [jwk] },
        rolesClaim: 'groups',
        scopesClaim: 'veritrail_scopes',
        labelScopeClaim: 'labels',
        roleMappings: { 'veritrail-operators': 'operator' },
      },
    });

    const result = auth.authenticate(
      jwtFrom(privateKey, baseClaims()),
      { roles: ['operator'], scope: 'audit:read' },
      OIDC_NOW,
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.principal).toMatchObject({
        id: `oidc:${OIDC_ISSUER}:operator-oidc`,
        actorId: 'operator-oidc',
        roles: ['operator'],
        scopes: ['audit:read', 'forensics:read'],
        labelScope: { tenant: 'acme', project: 'alpha' },
      });
    }
  });

  it('prefers an exact API key match over OIDC parsing for JWT-shaped secrets', () => {
    const { jwk } = oidcFixture();
    const auth = new ApiKeyAuthenticator({
      apiKeys: [
        {
          id: 'operator',
          actorId: 'api-key-operator',
          secret: 'header.payload.signature',
          roles: ['operator'],
        },
      ],
      oidc: {
        issuer: OIDC_ISSUER,
        audience: OIDC_AUDIENCE,
        jwks: { keys: [jwk] },
        defaultRoles: ['admin'],
      },
    });

    const result = auth.authenticate('header.payload.signature', ['operator'], OIDC_NOW);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.principal).toMatchObject({
        id: 'operator',
        actorId: 'api-key-operator',
        roles: ['operator'],
      });
    }
  });

  it('rejects OIDC tokens with invalid signature, issuer, audience, or time claims', () => {
    const { privateKey, jwk } = oidcFixture();
    const other = oidcFixture();
    const auth = new ApiKeyAuthenticator({
      oidc: {
        issuer: OIDC_ISSUER,
        audience: OIDC_AUDIENCE,
        jwks: { keys: [jwk] },
        defaultRoles: ['operator'],
        defaultScopes: ['audit:read'],
        clockSkewSeconds: 0,
      },
    });

    expect(
      auth.authenticate(
        jwtFrom(other.privateKey, baseClaims()),
        { roles: ['operator'], scope: 'audit:read' },
        OIDC_NOW,
      ),
    ).toMatchObject({ ok: false, failure: { reason: 'invalid' } });
    expect(
      auth.authenticate(
        jwtFrom(privateKey, baseClaims({ iss: 'https://evil.example.test/' })),
        { roles: ['operator'], scope: 'audit:read' },
        OIDC_NOW,
      ),
    ).toMatchObject({ ok: false, failure: { reason: 'invalid' } });
    expect(
      auth.authenticate(
        jwtFrom(privateKey, baseClaims({ aud: 'other-service' })),
        { roles: ['operator'], scope: 'audit:read' },
        OIDC_NOW,
      ),
    ).toMatchObject({ ok: false, failure: { reason: 'invalid' } });
    expect(
      auth.authenticate(
        jwtFrom(privateKey, baseClaims({ exp: OIDC_NOW / 1000 - 1 })),
        { roles: ['operator'], scope: 'audit:read' },
        OIDC_NOW,
      ),
    ).toMatchObject({ ok: false, failure: { reason: 'invalid' } });
  });
});

describe('parseApiKeyEntries', () => {
  it('parses roles and colon-bearing scopes from env entries', () => {
    expect(
      parseApiKeyEntries(
        'audit:operator-1:audit-secret-0001:operator:audit:read|rollback:execute;labels=tenant=acme|project=alpha',
      ),
    ).toEqual([
      {
        id: 'audit',
        actorId: 'operator-1',
        secret: 'audit-secret-0001',
        roles: ['operator'],
        scopes: ['audit:read', 'rollback:execute'],
        labelScope: { tenant: 'acme', project: 'alpha' },
      },
    ]);
  });

  it('rejects malformed roles and scopes instead of broadening access', () => {
    expect(() => parseApiKeyEntries('bad:operator-1:secret-0001:unknown')).toThrow();
    expect(() => parseApiKeyEntries('bad:operator-1:secret-0001:operator:audit')).toThrow();
    expect(() =>
      parseApiKeyEntries('bad:operator-1:secret-0001:operator:audit:read;labels=tenant'),
    ).toThrow();
  });
});
