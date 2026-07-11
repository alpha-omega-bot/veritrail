import { createHash, randomBytes } from 'node:crypto';

import { TIER_LIMITS, type TierLimits } from './plans.js';
import type {
  ApiKeyHashed,
  ControlPlaneStore,
  MagicLink,
  Membership,
  Organization,
  Project,
  Session,
  Tier,
  User,
  Webhook,
} from './schema.js';

export interface ControlPlaneOptions {
  readonly store: ControlPlaneStore;
  /** Override for tests — defaults to crypto.randomBytes. */
  readonly randomBytes?: (size: number) => Buffer;
  /** Override for tests — defaults to Date.now(). */
  readonly clock?: () => number;
}

/**
 * High-level façade around the storage port. Encapsulates the rules:
 *   - API keys are minted with a single-use plaintext; only the hash is stored.
 *   - Magic links are single-use, time-bounded, hashed at rest.
 *   - Project creation enforces the tier's `maxProjects` limit.
 *   - Membership creation is idempotent.
 *
 * Heavier integrations (Stripe webhooks, email delivery) live in adjacent
 * files so this stays focused on identity/tenancy.
 */
export class ControlPlane {
  readonly #store: ControlPlaneStore;
  readonly #randomBytes: (size: number) => Buffer;
  readonly #now: () => number;

  constructor(options: ControlPlaneOptions) {
    this.#store = options.store;
    this.#randomBytes = options.randomBytes ?? randomBytes;
    this.#now = options.clock ?? (() => Date.now());
  }

  // ---- Org / project creation ------------------------------------------

  async createOrg(input: { name: string; slug: string; tier?: Tier }): Promise<Organization> {
    return this.#store.createOrg({
      id: this.#newId('org'),
      name: input.name,
      slug: input.slug,
      tier: input.tier ?? 'free',
      subscriptionStatus: input.tier === 'free' || input.tier === undefined ? 'active' : 'trialing',
      stripeCustomerId: null,
      stripeSubscriptionId: null,
    });
  }

  async createProject(orgId: string, input: { name: string; slug: string }): Promise<Project> {
    const org = await this.#store.getOrgById(orgId);
    if (!org) throw new Error(`org ${orgId} not found`);
    const limits = TIER_LIMITS[org.tier];
    const count = await this.#store.countProjectsForOrg(orgId);
    if (count >= limits.maxProjects) {
      throw new ControlPlaneError(
        'QUOTA_EXCEEDED',
        `tier "${org.tier}" allows at most ${limits.maxProjects} project(s); upgrade to add more`,
      );
    }
    return this.#store.createProject({
      id: this.#newId('proj'),
      orgId,
      name: input.name,
      slug: input.slug,
    });
  }

  // ---- Users / memberships --------------------------------------------

  async createUser(input: { email: string; displayName?: string }): Promise<User> {
    return this.#store.createUser({
      id: this.#newId('usr'),
      email: input.email,
      emailVerifiedAt: null,
      displayName: input.displayName ?? null,
    });
  }

  async addMember(input: {
    orgId: string;
    userId: string;
    role: Membership['role'];
  }): Promise<Membership> {
    return this.#store.createMembership(input);
  }

  // ---- API keys --------------------------------------------------------

  /**
   * Mint a new API key. Returns the plaintext key exactly ONCE — the caller
   * must hand it to the user immediately and never log it. Only the hash is
   * persisted; lookup later goes by prefix.
   */
  async createApiKey(input: {
    projectId: string;
    label: string;
  }): Promise<{ key: string; record: ApiKeyHashed }> {
    const project = await this.#store.getProjectById(input.projectId);
    if (!project) throw new Error(`project ${input.projectId} not found`);

    // Format: vt_live_<24url-safe-chars>
    const random = this.#randomBytes(18).toString('base64url');
    const prefix = `vt_live_${random.slice(0, 8)}`;
    const plaintext = `${prefix}_${random}`;
    const hash = sha256(plaintext);

    const record = await this.#store.createApiKey({
      id: this.#newId('apk'),
      projectId: project.id,
      orgId: project.orgId,
      prefix,
      hash,
      label: input.label,
    });
    return { key: plaintext, record };
  }

  /**
   * Resolve a plaintext API key to its record (and a label-scope hint suitable
   * for the Veritrail server's `ApiKeyPrincipal.labelScope`). Returns null
   * when the key is unknown, revoked, or the prefix decoded but the hash
   * didn't match (i.e. someone is brute-forcing a prefix).
   */
  async authenticateApiKey(plaintext: string): Promise<{
    readonly record: ApiKeyHashed;
    readonly labelScope: Readonly<Record<string, string>>;
  } | null> {
    // Prefix is exactly `vt_live_<8 url-safe chars>`. The plaintext is
    // `<prefix>_<random>`. We extract the prefix anchored to the start.
    const prefixMatch = plaintext.match(/^vt_live_[0-9A-Za-z_-]{8}/);
    if (!prefixMatch) return null;
    const record = await this.#store.getApiKeyByPrefix(prefixMatch[0]);
    if (!record) return null;
    if (record.revokedAt !== null) return null;
    if (sha256(plaintext) !== record.hash) return null;
    await this.#store.recordApiKeyUse(record.id, this.#now());
    return {
      record,
      labelScope: { org: record.orgId, project: record.projectId },
    };
  }

  async revokeApiKey(id: string): Promise<void> {
    return this.#store.revokeApiKey(id, this.#now());
  }

  // ---- Magic links -----------------------------------------------------

  /**
   * Issue a magic-link token. Returns the plaintext token ONCE so the caller
   * can email it; only the hash is stored. Token is 15 minutes by default,
   * single-use.
   */
  async issueMagicLink(input: { email: string; ttlMs?: number }): Promise<{
    token: string;
    record: MagicLink;
  }> {
    const ttl = input.ttlMs ?? 15 * 60_000;
    const token = this.#randomBytes(32).toString('base64url');
    const now = this.#now();
    const record = await this.#store.createMagicLink({
      id: this.#newId('mlk'),
      email: input.email.trim().toLowerCase(),
      tokenHash: sha256(token),
      expiresAt: now + ttl,
    });
    return { token, record };
  }

  /**
   * Exchange a magic-link token for a fresh session. Idempotent only in the
   * "already consumed" sense — second-use returns null.
   */
  async consumeMagicLink(
    token: string,
  ): Promise<{ session: Session; sessionToken: string; user: User } | null> {
    const consumed = await this.#store.consumeMagicLink(sha256(token), this.#now());
    if (!consumed) return null;
    const existing = await this.#store.getUserByEmail(consumed.email);
    let userId: string;
    if (existing) {
      userId = existing.id;
      if (existing.emailVerifiedAt === null) {
        await this.#store.markEmailVerified(existing.id, this.#now());
      }
    } else {
      const created = await this.createUser({ email: consumed.email });
      userId = created.id;
      await this.#store.markEmailVerified(created.id, this.#now());
    }
    // Re-fetch so the caller sees the post-verification state.
    const user = await this.#store.getUserById(userId);
    if (!user) return null;
    const { session, token: sessionToken } = await this.#createSession(user.id);
    return { session, sessionToken, user };
  }

  async resolveSession(token: string): Promise<{ session: Session; user: User } | null> {
    const session = await this.#store.getSessionByTokenHash(sha256(token));
    if (!session) return null;
    if (session.expiresAt < this.#now()) return null;
    const user = await this.#store.getUserById(session.userId);
    return user ? { session, user } : null;
  }

  // ---- Webhooks --------------------------------------------------------

  /**
   * Register an outbound webhook subscription for a project. Returns the
   * persisted record together with the plaintext signing secret — the
   * plaintext is shown to the user exactly ONCE and the caller must surface
   * it in the response. After that, secret access goes through the dispatcher
   * which reads it from the store at send time to HMAC-sign payloads.
   */
  async createWebhook(input: {
    projectId: string;
    url: string;
    eventsFilter?: ReadonlyArray<string>;
  }): Promise<{ webhook: Webhook; secret: string }> {
    const project = await this.#store.getProjectById(input.projectId);
    if (!project) throw new Error(`project ${input.projectId} not found`);
    const secret = this.#randomBytes(32).toString('base64url');
    const webhook = await this.#store.createWebhook({
      id: this.#newId('whk'),
      projectId: project.id,
      url: input.url,
      secret,
      eventsFilter: input.eventsFilter ?? [],
    });
    return { webhook, secret };
  }

  /** List all webhook subscriptions for a project, paused or active. */
  async listWebhooks(projectId: string): Promise<ReadonlyArray<Webhook>> {
    return this.#store.listWebhooksForProject(projectId);
  }

  /** Mark a webhook subscription paused; the dispatcher should skip paused rows. */
  async pauseWebhook(id: string): Promise<Webhook | null> {
    return this.#store.setWebhookPaused(id, this.#now());
  }

  /** Clear a webhook's paused flag, resuming delivery. */
  async resumeWebhook(id: string): Promise<Webhook | null> {
    return this.#store.setWebhookPaused(id, null);
  }

  /** Permanently delete a webhook subscription. Returns true if a row was removed. */
  async deleteWebhook(id: string): Promise<boolean> {
    return this.#store.deleteWebhook(id);
  }

  // ---- Helpers ---------------------------------------------------------

  tierLimits(tier: Tier): TierLimits {
    return TIER_LIMITS[tier];
  }

  /**
   * Escape hatch for HTTP-layer code that needs direct store reads (listing
   * memberships, finding projects). Treat the returned value as read-only —
   * mutations should go through the ControlPlane API.
   */
  get store(): ControlPlaneStore {
    return this.#store;
  }

  async #createSession(userId: string): Promise<{ session: Session; token: string }> {
    const token = this.#randomBytes(32).toString('base64url');
    const now = this.#now();
    const session = await this.#store.createSession({
      id: this.#newId('ses'),
      userId,
      expiresAt: now + 7 * 86_400_000, // 7 days
      tokenHash: sha256(token),
    });
    return { session, token };
  }

  #newId(prefix: string): string {
    return `${prefix}_${this.#randomBytes(12).toString('base64url')}`;
  }
}

export function createControlPlane(options: ControlPlaneOptions): ControlPlane {
  return new ControlPlane(options);
}

export class ControlPlaneError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'ControlPlaneError';
  }
}

function sha256(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}
