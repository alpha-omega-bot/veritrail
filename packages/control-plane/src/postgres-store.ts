/**
 * Postgres-backed implementation of {@link ControlPlaneStore}.
 *
 * Mirrors the in-memory reference implementation in `memory-store.ts`, but
 * persists state to a SQL connection via the {@link SqlConnection} abstraction
 * from `@veritrail/relational-store`. Every method maps camelCase domain
 * fields to snake_case SQL columns and converts JS millisecond timestamps to
 * BIGINT and back.
 *
 * The schema lives in `migrations/0001_init.sql` and assumes the control-plane
 * tables are reachable under `search_path` (the migration sets that up).
 */

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { postgresDialect } from '@veritrail/relational-store';
import type { SqlConnection, SqlRow, SqlValue } from '@veritrail/relational-store';

import type {
  ApiKeyHashed,
  ControlPlaneStore,
  MagicLink,
  Membership,
  OrgRole,
  Organization,
  Project,
  Session,
  SubscriptionStatus,
  Tier,
  User,
  Webhook,
} from './schema.js';

/**
 * Path to the initial control-plane SQL migration. Exported so callers can
 * inspect the location (e.g. for tooling) without re-resolving the URL.
 */
export const CONTROL_PLANE_MIGRATION_PATH = fileURLToPath(
  new URL('./migrations/0001_init.sql', import.meta.url),
);

/**
 * Run the initial control-plane schema migration against `conn`. Safe to call
 * repeatedly — every statement is `IF NOT EXISTS` guarded.
 */
export async function migrateControlPlane(conn: SqlConnection): Promise<void> {
  const sql = await readFile(CONTROL_PLANE_MIGRATION_PATH, 'utf8');
  for (const statement of splitSqlStatements(sql)) {
    await conn.execute({ text: statement });
  }
}

/**
 * Postgres-backed {@link ControlPlaneStore}. Stateless: every method opens a
 * single `execute` against the supplied connection (or pool). Inject either a
 * `PostgresDatabase` pool wrapper or a per-request transaction handle —
 * anything that satisfies `SqlConnection`.
 */
export class PostgresControlPlaneStore implements ControlPlaneStore {
  readonly #conn: SqlConnection;
  readonly #now: () => number;

  /**
   * @param conn  Any `SqlConnection` — typically a `PostgresDatabase` (pool)
   *              or transaction handle from `@veritrail/relational-store`.
   * @param now   Optional clock override; defaults to `Date.now`. Used for
   *              the `createdAt` columns the schema requires us to fill in.
   */
  constructor(conn: SqlConnection, now: () => number = Date.now) {
    this.#conn = conn;
    this.#now = now;
  }

  // ---- Orgs -------------------------------------------------------------

  async createOrg(input: Omit<Organization, 'createdAt'>): Promise<Organization> {
    const createdAt = this.#now();
    const placeholders = this.#placeholders(8);
    try {
      await this.#conn.execute({
        text: `INSERT INTO organizations (
            id, name, slug, created_at, tier, subscription_status,
            stripe_customer_id, stripe_subscription_id
          ) VALUES (${placeholders})`,
        values: [
          input.id,
          input.name,
          input.slug,
          createdAt,
          input.tier,
          input.subscriptionStatus,
          input.stripeCustomerId,
          input.stripeSubscriptionId,
        ],
      });
    } catch (cause) {
      if (postgresDialect.isConflict(cause)) {
        throw new Error(`org slug "${input.slug}" already exists`);
      }
      throw cause;
    }
    return { ...input, createdAt };
  }

  async getOrgById(id: string): Promise<Organization | null> {
    const rows = await this.#select('SELECT * FROM organizations WHERE id =', [id]);
    return rows[0] ? mapOrg(rows[0]) : null;
  }

  async getOrgBySlug(slug: string): Promise<Organization | null> {
    const rows = await this.#select('SELECT * FROM organizations WHERE slug =', [slug]);
    return rows[0] ? mapOrg(rows[0]) : null;
  }

  async updateOrgSubscription(
    id: string,
    fields: Partial<
      Pick<
        Organization,
        'tier' | 'subscriptionStatus' | 'stripeCustomerId' | 'stripeSubscriptionId'
      >
    >,
  ): Promise<Organization | null> {
    const setParts: string[] = [];
    const values: SqlValue[] = [];
    const push = (col: string, value: SqlValue): void => {
      values.push(value);
      setParts.push(`${col} = ${postgresDialect.placeholder(values.length)}`);
    };
    if (fields.tier !== undefined) push('tier', fields.tier);
    if (fields.subscriptionStatus !== undefined) {
      push('subscription_status', fields.subscriptionStatus);
    }
    if (fields.stripeCustomerId !== undefined) push('stripe_customer_id', fields.stripeCustomerId);
    if (fields.stripeSubscriptionId !== undefined) {
      push('stripe_subscription_id', fields.stripeSubscriptionId);
    }
    if (setParts.length === 0) return this.getOrgById(id);
    values.push(id);
    const result = await this.#conn.execute({
      text: `UPDATE organizations SET ${setParts.join(', ')} WHERE id = ${postgresDialect.placeholder(values.length)} RETURNING *`,
      values,
    });
    const row = result.rows[0];
    return row ? mapOrg(row) : null;
  }

  async listOrgsForUser(userId: string): Promise<ReadonlyArray<Organization>> {
    const result = await this.#conn.execute({
      text: `SELECT o.* FROM organizations o
             INNER JOIN memberships m ON m.org_id = o.id
             WHERE m.user_id = ${postgresDialect.placeholder(1)}`,
      values: [userId],
    });
    return result.rows.map(mapOrg);
  }

  // ---- Users / Memberships ---------------------------------------------

  async createUser(input: Omit<User, 'createdAt'>): Promise<User> {
    const email = input.email.trim().toLowerCase();
    const createdAt = this.#now();
    const placeholders = this.#placeholders(5);
    try {
      await this.#conn.execute({
        text: `INSERT INTO users (id, email, email_verified_at, display_name, created_at)
               VALUES (${placeholders})`,
        values: [input.id, email, input.emailVerifiedAt, input.displayName, createdAt],
      });
    } catch (cause) {
      if (postgresDialect.isConflict(cause)) {
        throw new Error(`user with email "${email}" already exists`);
      }
      throw cause;
    }
    return { ...input, email, createdAt };
  }

  async getUserById(id: string): Promise<User | null> {
    const rows = await this.#select('SELECT * FROM users WHERE id =', [id]);
    return rows[0] ? mapUser(rows[0]) : null;
  }

  async getUserByEmail(email: string): Promise<User | null> {
    const rows = await this.#select('SELECT * FROM users WHERE email =', [
      email.trim().toLowerCase(),
    ]);
    return rows[0] ? mapUser(rows[0]) : null;
  }

  async markEmailVerified(id: string, at: number): Promise<void> {
    await this.#conn.execute({
      text: `UPDATE users SET email_verified_at = ${postgresDialect.placeholder(1)} WHERE id = ${postgresDialect.placeholder(2)}`,
      values: [at, id],
    });
  }

  async createMembership(input: Omit<Membership, 'createdAt'>): Promise<Membership> {
    const createdAt = this.#now();
    const placeholders = this.#placeholders(4);
    try {
      await this.#conn.execute({
        text: `INSERT INTO memberships (org_id, user_id, role, created_at)
               VALUES (${placeholders})`,
        values: [input.orgId, input.userId, input.role, createdAt],
      });
    } catch (cause) {
      if (postgresDialect.isConflict(cause)) {
        throw new Error(`membership ${input.orgId}:${input.userId} already exists`);
      }
      throw cause;
    }
    return { ...input, createdAt };
  }

  async listMembershipsForUser(userId: string): Promise<ReadonlyArray<Membership>> {
    const rows = await this.#select('SELECT * FROM memberships WHERE user_id =', [userId]);
    return rows.map(mapMembership);
  }

  async listMembershipsForOrg(orgId: string): Promise<ReadonlyArray<Membership>> {
    const rows = await this.#select('SELECT * FROM memberships WHERE org_id =', [orgId]);
    return rows.map(mapMembership);
  }

  // ---- Projects ---------------------------------------------------------

  async createProject(input: Omit<Project, 'createdAt'>): Promise<Project> {
    const createdAt = this.#now();
    const placeholders = this.#placeholders(5);
    try {
      await this.#conn.execute({
        text: `INSERT INTO projects (id, org_id, name, slug, created_at)
               VALUES (${placeholders})`,
        values: [input.id, input.orgId, input.name, input.slug, createdAt],
      });
    } catch (cause) {
      if (postgresDialect.isConflict(cause)) {
        throw new Error(`project slug "${input.slug}" already exists in org`);
      }
      throw cause;
    }
    return { ...input, createdAt };
  }

  async getProjectById(id: string): Promise<Project | null> {
    const rows = await this.#select('SELECT * FROM projects WHERE id =', [id]);
    return rows[0] ? mapProject(rows[0]) : null;
  }

  async listProjectsForOrg(orgId: string): Promise<ReadonlyArray<Project>> {
    const rows = await this.#select('SELECT * FROM projects WHERE org_id =', [orgId]);
    return rows.map(mapProject);
  }

  async countProjectsForOrg(orgId: string): Promise<number> {
    const result = await this.#conn.execute({
      text: `SELECT COUNT(*) AS count FROM projects WHERE org_id = ${postgresDialect.placeholder(1)}`,
      values: [orgId],
    });
    const raw = result.rows[0]?.count;
    if (typeof raw === 'number') return raw;
    if (typeof raw === 'string') return Number(raw);
    if (typeof raw === 'bigint') return Number(raw);
    return 0;
  }

  // ---- API keys ---------------------------------------------------------

  async createApiKey(
    input: Omit<ApiKeyHashed, 'createdAt' | 'revokedAt' | 'lastUsedAt'>,
  ): Promise<ApiKeyHashed> {
    const createdAt = this.#now();
    const placeholders = this.#placeholders(9);
    try {
      await this.#conn.execute({
        text: `INSERT INTO api_keys (
            id, project_id, org_id, prefix, hash, label,
            created_at, revoked_at, last_used_at
          ) VALUES (${placeholders})`,
        values: [
          input.id,
          input.projectId,
          input.orgId,
          input.prefix,
          input.hash,
          input.label,
          createdAt,
          null,
          null,
        ],
      });
    } catch (cause) {
      if (postgresDialect.isConflict(cause)) {
        throw new Error(`api key prefix "${input.prefix}" collision`);
      }
      throw cause;
    }
    return { ...input, createdAt, revokedAt: null, lastUsedAt: null };
  }

  async getApiKeyByPrefix(prefix: string): Promise<ApiKeyHashed | null> {
    const rows = await this.#select('SELECT * FROM api_keys WHERE prefix =', [prefix]);
    return rows[0] ? mapApiKey(rows[0]) : null;
  }

  async revokeApiKey(id: string, at: number): Promise<void> {
    await this.#conn.execute({
      text: `UPDATE api_keys SET revoked_at = ${postgresDialect.placeholder(1)} WHERE id = ${postgresDialect.placeholder(2)}`,
      values: [at, id],
    });
  }

  async recordApiKeyUse(id: string, at: number): Promise<void> {
    await this.#conn.execute({
      text: `UPDATE api_keys SET last_used_at = ${postgresDialect.placeholder(1)} WHERE id = ${postgresDialect.placeholder(2)}`,
      values: [at, id],
    });
  }

  async listApiKeysForProject(projectId: string): Promise<ReadonlyArray<ApiKeyHashed>> {
    const rows = await this.#select('SELECT * FROM api_keys WHERE project_id =', [projectId]);
    return rows.map(mapApiKey);
  }

  // ---- Sessions ---------------------------------------------------------

  async createSession(input: Omit<Session, 'createdAt'>): Promise<Session> {
    const createdAt = this.#now();
    const placeholders = this.#placeholders(5);
    await this.#conn.execute({
      text: `INSERT INTO sessions (id, user_id, token_hash, created_at, expires_at)
             VALUES (${placeholders})`,
      values: [input.id, input.userId, input.tokenHash, createdAt, input.expiresAt],
    });
    return { ...input, createdAt };
  }

  async getSessionByTokenHash(tokenHash: string): Promise<Session | null> {
    const rows = await this.#select('SELECT * FROM sessions WHERE token_hash =', [tokenHash]);
    return rows[0] ? mapSession(rows[0]) : null;
  }

  async deleteSession(id: string): Promise<void> {
    await this.#conn.execute({
      text: `DELETE FROM sessions WHERE id = ${postgresDialect.placeholder(1)}`,
      values: [id],
    });
  }

  async deleteExpiredSessions(now: number): Promise<number> {
    const result = await this.#conn.execute({
      text: `DELETE FROM sessions WHERE expires_at < ${postgresDialect.placeholder(1)} RETURNING id`,
      values: [now],
    });
    return result.rows.length;
  }

  // ---- Magic links ------------------------------------------------------

  async createMagicLink(input: Omit<MagicLink, 'createdAt' | 'consumedAt'>): Promise<MagicLink> {
    const createdAt = this.#now();
    const placeholders = this.#placeholders(6);
    await this.#conn.execute({
      text: `INSERT INTO magic_links (id, email, token_hash, created_at, expires_at, consumed_at)
             VALUES (${placeholders})`,
      values: [input.id, input.email, input.tokenHash, createdAt, input.expiresAt, null],
    });
    return { ...input, createdAt, consumedAt: null };
  }

  async consumeMagicLink(tokenHash: string, at: number): Promise<MagicLink | null> {
    const selectText = `SELECT * FROM magic_links WHERE token_hash = ${postgresDialect.placeholder(1)} FOR UPDATE`;
    const selectResult = await this.#conn.execute({ text: selectText, values: [tokenHash] });
    const row = selectResult.rows[0];
    if (!row) return null;
    const link = mapMagicLink(row);
    if (link.consumedAt !== null) return null;
    if (link.expiresAt < at) return null;
    const updateResult = await this.#conn.execute({
      text: `UPDATE magic_links SET consumed_at = ${postgresDialect.placeholder(1)}
             WHERE id = ${postgresDialect.placeholder(2)} RETURNING *`,
      values: [at, link.id],
    });
    const updated = updateResult.rows[0];
    return updated ? mapMagicLink(updated) : null;
  }

  // ---- Webhooks ---------------------------------------------------------

  async createWebhook(input: Omit<Webhook, 'createdAt' | 'pausedAt'>): Promise<Webhook> {
    const createdAt = this.#now();
    const placeholders = this.#placeholders(7);
    await this.#conn.execute({
      text: `INSERT INTO webhooks (id, project_id, url, secret, events_filter, created_at, paused_at)
             VALUES (${placeholders})`,
      values: [
        input.id,
        input.projectId,
        input.url,
        input.secret,
        encodeEventsFilter(input.eventsFilter),
        createdAt,
        null,
      ],
    });
    return { ...input, createdAt, pausedAt: null };
  }

  async listWebhooksForProject(projectId: string): Promise<ReadonlyArray<Webhook>> {
    const rows = await this.#select('SELECT * FROM webhooks WHERE project_id =', [projectId]);
    return rows.map(mapWebhook);
  }

  async getWebhookById(id: string): Promise<Webhook | null> {
    const rows = await this.#select('SELECT * FROM webhooks WHERE id =', [id]);
    return rows[0] ? mapWebhook(rows[0]) : null;
  }

  async setWebhookPaused(id: string, pausedAt: number | null): Promise<Webhook | null> {
    const result = await this.#conn.execute({
      text: `UPDATE webhooks SET paused_at = ${postgresDialect.placeholder(1)}
             WHERE id = ${postgresDialect.placeholder(2)} RETURNING *`,
      values: [pausedAt, id],
    });
    const row = result.rows[0];
    return row ? mapWebhook(row) : null;
  }

  async deleteWebhook(id: string): Promise<boolean> {
    const result = await this.#conn.execute({
      text: `DELETE FROM webhooks WHERE id = ${postgresDialect.placeholder(1)} RETURNING id`,
      values: [id],
    });
    return result.rows.length > 0;
  }

  // ---- Helpers ----------------------------------------------------------

  #placeholders(n: number): string {
    const parts: string[] = [];
    for (let i = 1; i <= n; i += 1) parts.push(postgresDialect.placeholder(i));
    return parts.join(', ');
  }

  async #select(prefix: string, values: SqlValue[]): Promise<readonly SqlRow[]> {
    const placeholders = values.map((_, i) => postgresDialect.placeholder(i + 1)).join(', ');
    const result = await this.#conn.execute({
      text: `${prefix} ${placeholders}`,
      values,
    });
    return result.rows;
  }
}

// ---------- Row -> domain mapping ----------------------------------------

function asString(value: unknown): string {
  if (typeof value !== 'string') throw new Error(`expected string, got ${typeof value}`);
  return value;
}

function asStringOrNull(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  return asString(value);
}

function asNumber(value: unknown): number {
  if (typeof value === 'number') return value;
  if (typeof value === 'string') return Number(value);
  if (typeof value === 'bigint') return Number(value);
  throw new Error(`expected number, got ${typeof value}`);
}

function asNumberOrNull(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  return asNumber(value);
}

function asTier(value: unknown): Tier {
  const v = asString(value);
  if (v === 'free' || v === 'starter' || v === 'pro' || v === 'enterprise') return v;
  throw new Error(`unknown tier "${v}"`);
}

function asSubscriptionStatus(value: unknown): SubscriptionStatus {
  const v = asString(value);
  switch (v) {
    case 'active':
    case 'trialing':
    case 'past_due':
    case 'canceled':
    case 'incomplete':
    case 'paused':
      return v;
    default:
      throw new Error(`unknown subscription status "${v}"`);
  }
}

function asOrgRole(value: unknown): OrgRole {
  const v = asString(value);
  if (v === 'org:owner' || v === 'org:admin' || v === 'org:member' || v === 'org:billing') return v;
  throw new Error(`unknown org role "${v}"`);
}

function mapOrg(row: SqlRow): Organization {
  return {
    id: asString(row.id),
    name: asString(row.name),
    slug: asString(row.slug),
    createdAt: asNumber(row.created_at),
    tier: asTier(row.tier),
    subscriptionStatus: asSubscriptionStatus(row.subscription_status),
    stripeCustomerId: asStringOrNull(row.stripe_customer_id),
    stripeSubscriptionId: asStringOrNull(row.stripe_subscription_id),
  };
}

function mapUser(row: SqlRow): User {
  return {
    id: asString(row.id),
    email: asString(row.email),
    emailVerifiedAt: asNumberOrNull(row.email_verified_at),
    displayName: asStringOrNull(row.display_name),
    createdAt: asNumber(row.created_at),
  };
}

function mapMembership(row: SqlRow): Membership {
  return {
    orgId: asString(row.org_id),
    userId: asString(row.user_id),
    role: asOrgRole(row.role),
    createdAt: asNumber(row.created_at),
  };
}

function mapProject(row: SqlRow): Project {
  return {
    id: asString(row.id),
    orgId: asString(row.org_id),
    name: asString(row.name),
    slug: asString(row.slug),
    createdAt: asNumber(row.created_at),
  };
}

function mapApiKey(row: SqlRow): ApiKeyHashed {
  return {
    id: asString(row.id),
    projectId: asString(row.project_id),
    orgId: asString(row.org_id),
    prefix: asString(row.prefix),
    hash: asString(row.hash),
    label: asString(row.label),
    createdAt: asNumber(row.created_at),
    revokedAt: asNumberOrNull(row.revoked_at),
    lastUsedAt: asNumberOrNull(row.last_used_at),
  };
}

function mapSession(row: SqlRow): Session {
  return {
    id: asString(row.id),
    userId: asString(row.user_id),
    tokenHash: asString(row.token_hash),
    createdAt: asNumber(row.created_at),
    expiresAt: asNumber(row.expires_at),
  };
}

function mapMagicLink(row: SqlRow): MagicLink {
  return {
    id: asString(row.id),
    email: asString(row.email),
    tokenHash: asString(row.token_hash),
    createdAt: asNumber(row.created_at),
    expiresAt: asNumber(row.expires_at),
    consumedAt: asNumberOrNull(row.consumed_at),
  };
}

function mapWebhook(row: SqlRow): Webhook {
  return {
    id: asString(row.id),
    projectId: asString(row.project_id),
    url: asString(row.url),
    secret: asString(row.secret),
    eventsFilter: decodeEventsFilter(asString(row.events_filter)),
    createdAt: asNumber(row.created_at),
    pausedAt: asNumberOrNull(row.paused_at),
  };
}

/**
 * Encode the events filter for storage. An empty array means "all events" and
 * is stored as the wildcard `*` to match the migration default; any other
 * filter is stored as a comma-joined list of event types.
 */
function encodeEventsFilter(filter: ReadonlyArray<string>): string {
  return filter.length === 0 ? '*' : filter.join(',');
}

function decodeEventsFilter(stored: string): ReadonlyArray<string> {
  if (stored === '' || stored === '*') return [];
  return stored.split(',');
}

/**
 * Split a multi-statement SQL script on `;` terminators, ignoring line and
 * block comments and quoted strings. The control-plane migration is small and
 * predictable so this is sufficient — we are not trying to be a general SQL
 * parser.
 */
function splitSqlStatements(sql: string): readonly string[] {
  const statements: string[] = [];
  let buffer = '';
  let i = 0;
  while (i < sql.length) {
    const ch = sql[i];
    const next = sql[i + 1];
    if (ch === '-' && next === '-') {
      while (i < sql.length && sql[i] !== '\n') i += 1;
      continue;
    }
    if (ch === '/' && next === '*') {
      i += 2;
      while (i < sql.length && !(sql[i] === '*' && sql[i + 1] === '/')) i += 1;
      i += 2;
      continue;
    }
    if (ch === "'") {
      buffer += ch;
      i += 1;
      while (i < sql.length) {
        const c = sql[i];
        buffer += c;
        i += 1;
        if (c === "'") {
          if (sql[i] === "'") {
            buffer += sql[i];
            i += 1;
            continue;
          }
          break;
        }
      }
      continue;
    }
    if (ch === ';') {
      const trimmed = buffer.trim();
      if (trimmed.length > 0) statements.push(trimmed);
      buffer = '';
      i += 1;
      continue;
    }
    buffer += ch;
    i += 1;
  }
  const tail = buffer.trim();
  if (tail.length > 0) statements.push(tail);
  return statements;
}
