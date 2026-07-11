/**
 * Tests for the Postgres-backed {@link PostgresControlPlaneStore}. We do not
 * boot a real Postgres process — instead we inject a fake {@link SqlConnection}
 * that records every call and returns canned row data. This keeps the suite
 * pure and fast while still exercising the camelCase ↔ snake_case mapping,
 * placeholder substitution and conflict translation.
 */

import { describe, expect, it } from 'vitest';

import type {
  SqlConnection,
  SqlResult,
  SqlRow,
  SqlStatement,
  SqlValue,
} from '@veritrail/relational-store';

import { PostgresControlPlaneStore } from '../src/postgres-store.js';

interface RecordedCall {
  readonly text: string;
  readonly values: readonly SqlValue[];
}

/**
 * Build a fake {@link SqlConnection} whose `execute` walks the supplied
 * handlers in order, returning the first response whose predicate matches the
 * normalized SQL text. Anything unmatched throws so an accidental query during
 * a test surfaces loudly.
 */
function fakeConn(handlers: Array<(call: RecordedCall) => SqlResult | undefined>): {
  conn: SqlConnection;
  calls: RecordedCall[];
} {
  const calls: RecordedCall[] = [];
  const conn: SqlConnection = {
    async execute(statement: SqlStatement): Promise<SqlResult> {
      const call: RecordedCall = {
        text: statement.text.replace(/\s+/g, ' ').trim(),
        values: statement.values ? [...statement.values] : [],
      };
      calls.push(call);
      for (const handler of handlers) {
        const result = handler(call);
        if (result !== undefined) return result;
      }
      throw new Error(`unexpected SQL: ${call.text}`);
    },
  };
  return { conn, calls };
}

function rows(...data: SqlRow[]): SqlResult {
  return { rows: data };
}

function empty(): SqlResult {
  return { rows: [] };
}

const FIXED_NOW = 1_700_000_000_000;
const clock = (): number => FIXED_NOW;

describe('PostgresControlPlaneStore', () => {
  it('createOrg INSERTs the right columns and values', async () => {
    const { conn, calls } = fakeConn([
      (call) => (call.text.startsWith('INSERT') ? empty() : undefined),
    ]);
    const store = new PostgresControlPlaneStore(conn, clock);
    const org = await store.createOrg({
      id: 'org_1',
      name: 'Acme',
      slug: 'acme',
      tier: 'free',
      subscriptionStatus: 'active',
      stripeCustomerId: null,
      stripeSubscriptionId: null,
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.text).toMatch(/INSERT INTO organizations/);
    expect(calls[0]?.text).toMatch(
      /id, name, slug, created_at, tier, subscription_status, stripe_customer_id, stripe_subscription_id/,
    );
    expect(calls[0]?.text).toMatch(/\$1, \$2, \$3, \$4, \$5, \$6, \$7, \$8/);
    expect(calls[0]?.values).toEqual([
      'org_1',
      'Acme',
      'acme',
      FIXED_NOW,
      'free',
      'active',
      null,
      null,
    ]);
    expect(org.createdAt).toBe(FIXED_NOW);
  });

  it('getOrgById SELECTs WHERE id and maps snake_case to camelCase', async () => {
    const { conn, calls } = fakeConn([
      (call) =>
        call.text.startsWith('SELECT * FROM organizations WHERE id =')
          ? rows({
              id: 'org_1',
              name: 'Acme',
              slug: 'acme',
              created_at: 1234,
              tier: 'pro',
              subscription_status: 'active',
              stripe_customer_id: 'cus_1',
              stripe_subscription_id: null,
            })
          : undefined,
    ]);
    const store = new PostgresControlPlaneStore(conn, clock);
    const org = await store.getOrgById('org_1');
    expect(calls[0]?.values).toEqual(['org_1']);
    expect(calls[0]?.text).toMatch(/WHERE id = \$1/);
    expect(org).toEqual({
      id: 'org_1',
      name: 'Acme',
      slug: 'acme',
      createdAt: 1234,
      tier: 'pro',
      subscriptionStatus: 'active',
      stripeCustomerId: 'cus_1',
      stripeSubscriptionId: null,
    });
  });

  it('getOrgById returns null when no row is found', async () => {
    const { conn } = fakeConn([(call) => (call.text.startsWith('SELECT') ? empty() : undefined)]);
    const store = new PostgresControlPlaneStore(conn, clock);
    expect(await store.getOrgById('missing')).toBeNull();
  });

  it('createUser raises on duplicate email (driver reports 23505)', async () => {
    const { conn } = fakeConn([
      (call) => {
        if (call.text.startsWith('INSERT INTO users')) {
          const err: Error & { code?: string } = new Error('duplicate key');
          err.code = '23505';
          throw err;
        }
        return undefined;
      },
    ]);
    const store = new PostgresControlPlaneStore(conn, clock);
    await expect(
      store.createUser({
        id: 'usr_1',
        email: 'Test@Example.com',
        emailVerifiedAt: null,
        displayName: null,
      }),
    ).rejects.toThrow(/already exists/);
  });

  it('createUser normalizes email lower-case and passes correct columns', async () => {
    const { conn, calls } = fakeConn([
      (call) => (call.text.startsWith('INSERT INTO users') ? empty() : undefined),
    ]);
    const store = new PostgresControlPlaneStore(conn, clock);
    const user = await store.createUser({
      id: 'usr_1',
      email: '  User@Example.com ',
      emailVerifiedAt: null,
      displayName: 'User',
    });
    expect(user.email).toBe('user@example.com');
    expect(calls[0]?.values).toEqual(['usr_1', 'user@example.com', null, 'User', FIXED_NOW]);
    expect(calls[0]?.text).toMatch(
      /INSERT INTO users \(id, email, email_verified_at, display_name, created_at\)/,
    );
  });

  it('createMembership INSERTs (org_id, user_id, role, created_at)', async () => {
    const { conn, calls } = fakeConn([
      (call) => (call.text.startsWith('INSERT INTO memberships') ? empty() : undefined),
    ]);
    const store = new PostgresControlPlaneStore(conn, clock);
    const m = await store.createMembership({
      orgId: 'org_1',
      userId: 'usr_1',
      role: 'org:admin',
    });
    expect(calls[0]?.text).toMatch(/INSERT INTO memberships \(org_id, user_id, role, created_at\)/);
    expect(calls[0]?.text).toMatch(/\$1, \$2, \$3, \$4/);
    expect(calls[0]?.values).toEqual(['org_1', 'usr_1', 'org:admin', FIXED_NOW]);
    expect(m.createdAt).toBe(FIXED_NOW);
  });

  it('listOrgsForUser JOINs organizations through memberships on user_id', async () => {
    const { conn, calls } = fakeConn([
      (call) =>
        call.text.includes('INNER JOIN memberships')
          ? rows({
              id: 'org_1',
              name: 'Acme',
              slug: 'acme',
              created_at: 100,
              tier: 'free',
              subscription_status: 'active',
              stripe_customer_id: null,
              stripe_subscription_id: null,
            })
          : undefined,
    ]);
    const store = new PostgresControlPlaneStore(conn, clock);
    const orgs = await store.listOrgsForUser('usr_1');
    expect(calls[0]?.text).toMatch(/FROM organizations o/);
    expect(calls[0]?.text).toMatch(/INNER JOIN memberships m ON m\.org_id = o\.id/);
    expect(calls[0]?.text).toMatch(/WHERE m\.user_id = \$1/);
    expect(calls[0]?.values).toEqual(['usr_1']);
    expect(orgs).toHaveLength(1);
    expect(orgs[0]?.id).toBe('org_1');
    expect(orgs[0]?.subscriptionStatus).toBe('active');
  });

  it('listApiKeysForProject returns rows mapped to camelCase shape', async () => {
    const { conn, calls } = fakeConn([
      (call) =>
        call.text.startsWith('SELECT * FROM api_keys WHERE project_id =')
          ? rows(
              {
                id: 'apk_1',
                project_id: 'proj_1',
                org_id: 'org_1',
                prefix: 'vt_live_aaaaaaaa',
                hash: 'h1',
                label: 'prod',
                created_at: 10,
                revoked_at: null,
                last_used_at: 20,
              },
              {
                id: 'apk_2',
                project_id: 'proj_1',
                org_id: 'org_1',
                prefix: 'vt_live_bbbbbbbb',
                hash: 'h2',
                label: 'staging',
                created_at: 30,
                revoked_at: 40,
                last_used_at: null,
              },
            )
          : undefined,
    ]);
    const store = new PostgresControlPlaneStore(conn, clock);
    const keys = await store.listApiKeysForProject('proj_1');
    expect(calls[0]?.values).toEqual(['proj_1']);
    expect(keys).toHaveLength(2);
    expect(keys[0]).toMatchObject({
      id: 'apk_1',
      projectId: 'proj_1',
      orgId: 'org_1',
      prefix: 'vt_live_aaaaaaaa',
      lastUsedAt: 20,
      revokedAt: null,
    });
    expect(keys[1]).toMatchObject({ revokedAt: 40, lastUsedAt: null });
  });

  it('createSession persists token_hash and timestamps', async () => {
    const { conn, calls } = fakeConn([
      (call) => (call.text.startsWith('INSERT INTO sessions') ? empty() : undefined),
    ]);
    const store = new PostgresControlPlaneStore(conn, clock);
    const session = await store.createSession({
      id: 'ses_1',
      userId: 'usr_1',
      tokenHash: 'tokhash_abc',
      expiresAt: FIXED_NOW + 86_400_000,
    });
    expect(calls[0]?.text).toMatch(
      /INSERT INTO sessions \(id, user_id, token_hash, created_at, expires_at\)/,
    );
    expect(calls[0]?.values).toEqual([
      'ses_1',
      'usr_1',
      'tokhash_abc',
      FIXED_NOW,
      FIXED_NOW + 86_400_000,
    ]);
    expect(session.createdAt).toBe(FIXED_NOW);
    expect(session.tokenHash).toBe('tokhash_abc');
  });

  it('consumeMagicLink performs SELECT FOR UPDATE then UPDATE consumed_at', async () => {
    const { conn, calls } = fakeConn([
      (call) =>
        call.text.startsWith('SELECT * FROM magic_links WHERE token_hash =')
          ? rows({
              id: 'mlk_1',
              email: 'user@example.com',
              token_hash: 'th',
              created_at: 100,
              expires_at: FIXED_NOW + 60_000,
              consumed_at: null,
            })
          : undefined,
      (call) =>
        call.text.startsWith('UPDATE magic_links SET consumed_at =')
          ? rows({
              id: 'mlk_1',
              email: 'user@example.com',
              token_hash: 'th',
              created_at: 100,
              expires_at: FIXED_NOW + 60_000,
              consumed_at: FIXED_NOW,
            })
          : undefined,
    ]);
    const store = new PostgresControlPlaneStore(conn, clock);
    const link = await store.consumeMagicLink('th', FIXED_NOW);
    expect(calls).toHaveLength(2);
    expect(calls[0]?.text).toMatch(/SELECT \* FROM magic_links WHERE token_hash = \$1 FOR UPDATE/);
    expect(calls[0]?.values).toEqual(['th']);
    expect(calls[1]?.text).toMatch(/UPDATE magic_links SET consumed_at = \$1 WHERE id = \$2/);
    expect(calls[1]?.values).toEqual([FIXED_NOW, 'mlk_1']);
    expect(link?.consumedAt).toBe(FIXED_NOW);
  });

  it('consumeMagicLink returns null when the row is already consumed and skips the UPDATE', async () => {
    const { conn, calls } = fakeConn([
      (call) =>
        call.text.startsWith('SELECT * FROM magic_links')
          ? rows({
              id: 'mlk_1',
              email: 'u@example.com',
              token_hash: 'th',
              created_at: 100,
              expires_at: FIXED_NOW + 60_000,
              consumed_at: 200,
            })
          : undefined,
    ]);
    const store = new PostgresControlPlaneStore(conn, clock);
    const link = await store.consumeMagicLink('th', FIXED_NOW);
    expect(link).toBeNull();
    expect(calls).toHaveLength(1);
  });

  it('consumeMagicLink returns null when the row is expired and skips the UPDATE', async () => {
    const { conn, calls } = fakeConn([
      (call) =>
        call.text.startsWith('SELECT * FROM magic_links')
          ? rows({
              id: 'mlk_1',
              email: 'u@example.com',
              token_hash: 'th',
              created_at: 100,
              expires_at: FIXED_NOW - 1,
              consumed_at: null,
            })
          : undefined,
    ]);
    const store = new PostgresControlPlaneStore(conn, clock);
    const link = await store.consumeMagicLink('th', FIXED_NOW);
    expect(link).toBeNull();
    expect(calls).toHaveLength(1);
  });

  it('countProjectsForOrg parses bigint count strings from the driver', async () => {
    const { conn } = fakeConn([
      (call) => (call.text.startsWith('SELECT COUNT(*)') ? rows({ count: '7' }) : undefined),
    ]);
    const store = new PostgresControlPlaneStore(conn, clock);
    expect(await store.countProjectsForOrg('org_1')).toBe(7);
  });

  it('updateOrgSubscription emits a partial UPDATE only for present fields and uses RETURNING *', async () => {
    const { conn, calls } = fakeConn([
      (call) =>
        call.text.startsWith('UPDATE organizations SET')
          ? rows({
              id: 'org_1',
              name: 'Acme',
              slug: 'acme',
              created_at: 100,
              tier: 'pro',
              subscription_status: 'active',
              stripe_customer_id: 'cus_2',
              stripe_subscription_id: null,
            })
          : undefined,
    ]);
    const store = new PostgresControlPlaneStore(conn, clock);
    const updated = await store.updateOrgSubscription('org_1', {
      tier: 'pro',
      stripeCustomerId: 'cus_2',
    });
    expect(calls[0]?.text).toMatch(/UPDATE organizations SET tier = \$1, stripe_customer_id = \$2/);
    expect(calls[0]?.text).toMatch(/WHERE id = \$3 RETURNING \*/);
    expect(calls[0]?.values).toEqual(['pro', 'cus_2', 'org_1']);
    expect(updated?.tier).toBe('pro');
    expect(updated?.stripeCustomerId).toBe('cus_2');
  });

  it('createWebhook encodes empty events_filter as the "*" wildcard', async () => {
    const { conn, calls } = fakeConn([
      (call) => (call.text.startsWith('INSERT INTO webhooks') ? empty() : undefined),
    ]);
    const store = new PostgresControlPlaneStore(conn, clock);
    const webhook = await store.createWebhook({
      id: 'whk_1',
      projectId: 'proj_1',
      url: 'https://example.com/hook',
      secret: 'secret',
      eventsFilter: [],
    });
    expect(calls[0]?.values).toEqual([
      'whk_1',
      'proj_1',
      'https://example.com/hook',
      'secret',
      '*',
      FIXED_NOW,
      null,
    ]);
    expect(webhook.pausedAt).toBeNull();
  });
});
