/**
 * Control-plane domain types. Kept as plain TS interfaces (not Zod) to stay
 * dependency-light; validation lives at the API boundary in the server.
 */

export type Tier = 'free' | 'starter' | 'pro' | 'enterprise';

export type SubscriptionStatus =
  | 'active'
  | 'trialing'
  | 'past_due'
  | 'canceled'
  | 'incomplete'
  | 'paused';

export type OrgRole = 'org:owner' | 'org:admin' | 'org:member' | 'org:billing';

export interface Organization {
  readonly id: string;
  readonly name: string;
  readonly slug: string;
  readonly createdAt: number;
  readonly tier: Tier;
  readonly subscriptionStatus: SubscriptionStatus;
  /** Stripe customer id (null until first checkout). */
  readonly stripeCustomerId: string | null;
  /** Stripe subscription id when subscribed. */
  readonly stripeSubscriptionId: string | null;
}

export interface User {
  readonly id: string;
  readonly email: string;
  readonly emailVerifiedAt: number | null;
  readonly displayName: string | null;
  readonly createdAt: number;
}

export interface Membership {
  readonly orgId: string;
  readonly userId: string;
  readonly role: OrgRole;
  readonly createdAt: number;
}

export interface Project {
  readonly id: string;
  readonly orgId: string;
  readonly name: string;
  readonly slug: string;
  readonly createdAt: number;
}

/** API key record. The plaintext key is shown ONCE at creation; we store only the Argon2id hash. */
export interface ApiKeyHashed {
  readonly id: string;
  readonly projectId: string;
  readonly orgId: string;
  /** Short prefix shown to the user for identification (e.g. "vt_live_abc"). */
  readonly prefix: string;
  /** Argon2id hash of the plaintext key. */
  readonly hash: string;
  readonly createdAt: number;
  readonly revokedAt: number | null;
  readonly lastUsedAt: number | null;
  /** Free-form label set by the user, e.g. "production server". */
  readonly label: string;
}

export interface Session {
  readonly id: string;
  readonly userId: string;
  readonly createdAt: number;
  readonly expiresAt: number;
  /** SHA-256 hex of the session token. The plaintext lives only in the cookie. */
  readonly tokenHash: string;
}

export interface MagicLink {
  readonly id: string;
  readonly email: string;
  readonly tokenHash: string;
  readonly createdAt: number;
  readonly expiresAt: number;
  readonly consumedAt: number | null;
}

/**
 * Outbound webhook subscription scoped to a project. The plaintext signing
 * secret is shown ONCE at creation; it is stored as-is here so the dispatcher
 * can HMAC-sign payloads at send time. Treat `secret` as sensitive.
 */
export interface Webhook {
  readonly id: string;
  readonly projectId: string;
  readonly url: string;
  readonly secret: string;
  /**
   * Allow-list of event types to deliver. An empty array means "all events"
   * (caller's choice). Concrete filtering happens in the dispatcher.
   */
  readonly eventsFilter: ReadonlyArray<string>;
  readonly createdAt: number;
  /** Set when the subscription is paused; null means active. */
  readonly pausedAt: number | null;
}

/**
 * Storage port. Implementations: in-memory (tests / dev), Postgres
 * (production), SQLite (single-node self-host).
 */
export interface ControlPlaneStore {
  // ---- Orgs ----
  createOrg(input: Omit<Organization, 'createdAt'>): Promise<Organization>;
  getOrgById(id: string): Promise<Organization | null>;
  getOrgBySlug(slug: string): Promise<Organization | null>;
  updateOrgSubscription(
    id: string,
    fields: Partial<
      Pick<
        Organization,
        'tier' | 'subscriptionStatus' | 'stripeCustomerId' | 'stripeSubscriptionId'
      >
    >,
  ): Promise<Organization | null>;
  listOrgsForUser(userId: string): Promise<ReadonlyArray<Organization>>;

  // ---- Users / Memberships ----
  createUser(input: Omit<User, 'createdAt'>): Promise<User>;
  getUserById(id: string): Promise<User | null>;
  getUserByEmail(email: string): Promise<User | null>;
  markEmailVerified(id: string, at: number): Promise<void>;
  createMembership(input: Omit<Membership, 'createdAt'>): Promise<Membership>;
  listMembershipsForUser(userId: string): Promise<ReadonlyArray<Membership>>;
  listMembershipsForOrg(orgId: string): Promise<ReadonlyArray<Membership>>;

  // ---- Projects ----
  createProject(input: Omit<Project, 'createdAt'>): Promise<Project>;
  getProjectById(id: string): Promise<Project | null>;
  listProjectsForOrg(orgId: string): Promise<ReadonlyArray<Project>>;
  countProjectsForOrg(orgId: string): Promise<number>;

  // ---- API keys ----
  createApiKey(
    input: Omit<ApiKeyHashed, 'createdAt' | 'revokedAt' | 'lastUsedAt'>,
  ): Promise<ApiKeyHashed>;
  getApiKeyByPrefix(prefix: string): Promise<ApiKeyHashed | null>;
  revokeApiKey(id: string, at: number): Promise<void>;
  recordApiKeyUse(id: string, at: number): Promise<void>;
  listApiKeysForProject(projectId: string): Promise<ReadonlyArray<ApiKeyHashed>>;

  // ---- Sessions ----
  createSession(input: Omit<Session, 'createdAt'>): Promise<Session>;
  getSessionByTokenHash(tokenHash: string): Promise<Session | null>;
  deleteSession(id: string): Promise<void>;
  deleteExpiredSessions(now: number): Promise<number>;

  // ---- Magic links ----
  createMagicLink(input: Omit<MagicLink, 'createdAt' | 'consumedAt'>): Promise<MagicLink>;
  consumeMagicLink(tokenHash: string, at: number): Promise<MagicLink | null>;

  // ---- Webhooks ----
  createWebhook(input: Omit<Webhook, 'createdAt' | 'pausedAt'>): Promise<Webhook>;
  listWebhooksForProject(projectId: string): Promise<ReadonlyArray<Webhook>>;
  getWebhookById(id: string): Promise<Webhook | null>;
  setWebhookPaused(id: string, pausedAt: number | null): Promise<Webhook | null>;
  deleteWebhook(id: string): Promise<boolean>;
}
