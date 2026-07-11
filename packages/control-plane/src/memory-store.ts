import type {
  ApiKeyHashed,
  ControlPlaneStore,
  MagicLink,
  Membership,
  Organization,
  Project,
  Session,
  User,
  Webhook,
} from './schema.js';

/**
 * In-memory store for tests and local development. NOT durable; data is lost
 * on process exit. Production should use the Postgres adapter.
 */
export class InMemoryControlPlaneStore implements ControlPlaneStore {
  #orgs = new Map<string, Organization>();
  #users = new Map<string, User>();
  #usersByEmail = new Map<string, string>();
  #memberships = new Map<string, Membership>(); // key = `${orgId}:${userId}`
  #projects = new Map<string, Project>();
  #apiKeys = new Map<string, ApiKeyHashed>();
  #apiKeysByPrefix = new Map<string, string>();
  #sessions = new Map<string, Session>();
  #sessionsByTokenHash = new Map<string, string>();
  #magicLinks = new Map<string, MagicLink>();
  #magicLinksByTokenHash = new Map<string, string>();
  #webhooks = new Map<string, Webhook>();

  // ---- Orgs ----
  async createOrg(input: Omit<Organization, 'createdAt'>): Promise<Organization> {
    if ([...this.#orgs.values()].some((o) => o.slug === input.slug)) {
      throw new Error(`org slug "${input.slug}" already exists`);
    }
    const org: Organization = { ...input, createdAt: Date.now() };
    this.#orgs.set(org.id, org);
    return org;
  }
  async getOrgById(id: string): Promise<Organization | null> {
    return this.#orgs.get(id) ?? null;
  }
  async getOrgBySlug(slug: string): Promise<Organization | null> {
    return [...this.#orgs.values()].find((o) => o.slug === slug) ?? null;
  }
  async updateOrgSubscription(
    id: string,
    fields: Partial<Organization>,
  ): Promise<Organization | null> {
    const existing = this.#orgs.get(id);
    if (!existing) return null;
    const updated: Organization = { ...existing, ...fields };
    this.#orgs.set(id, updated);
    return updated;
  }
  async listOrgsForUser(userId: string): Promise<ReadonlyArray<Organization>> {
    const orgIds = new Set<string>();
    for (const m of this.#memberships.values()) {
      if (m.userId === userId) orgIds.add(m.orgId);
    }
    return [...orgIds].map((id) => this.#orgs.get(id)).filter((o): o is Organization => !!o);
  }

  // ---- Users / Memberships ----
  async createUser(input: Omit<User, 'createdAt'>): Promise<User> {
    const normalized = input.email.trim().toLowerCase();
    if (this.#usersByEmail.has(normalized)) {
      throw new Error(`user with email "${normalized}" already exists`);
    }
    const user: User = { ...input, email: normalized, createdAt: Date.now() };
    this.#users.set(user.id, user);
    this.#usersByEmail.set(normalized, user.id);
    return user;
  }
  async getUserById(id: string): Promise<User | null> {
    return this.#users.get(id) ?? null;
  }
  async getUserByEmail(email: string): Promise<User | null> {
    const id = this.#usersByEmail.get(email.trim().toLowerCase());
    return id ? (this.#users.get(id) ?? null) : null;
  }
  async markEmailVerified(id: string, at: number): Promise<void> {
    const u = this.#users.get(id);
    if (!u) return;
    this.#users.set(id, { ...u, emailVerifiedAt: at });
  }
  async createMembership(input: Omit<Membership, 'createdAt'>): Promise<Membership> {
    const key = `${input.orgId}:${input.userId}`;
    if (this.#memberships.has(key)) {
      throw new Error(`membership ${key} already exists`);
    }
    const m: Membership = { ...input, createdAt: Date.now() };
    this.#memberships.set(key, m);
    return m;
  }
  async listMembershipsForUser(userId: string): Promise<ReadonlyArray<Membership>> {
    return [...this.#memberships.values()].filter((m) => m.userId === userId);
  }
  async listMembershipsForOrg(orgId: string): Promise<ReadonlyArray<Membership>> {
    return [...this.#memberships.values()].filter((m) => m.orgId === orgId);
  }

  // ---- Projects ----
  async createProject(input: Omit<Project, 'createdAt'>): Promise<Project> {
    const dup = [...this.#projects.values()].some(
      (p) => p.orgId === input.orgId && p.slug === input.slug,
    );
    if (dup) throw new Error(`project slug "${input.slug}" already exists in org`);
    const p: Project = { ...input, createdAt: Date.now() };
    this.#projects.set(p.id, p);
    return p;
  }
  async getProjectById(id: string): Promise<Project | null> {
    return this.#projects.get(id) ?? null;
  }
  async listProjectsForOrg(orgId: string): Promise<ReadonlyArray<Project>> {
    return [...this.#projects.values()].filter((p) => p.orgId === orgId);
  }
  async countProjectsForOrg(orgId: string): Promise<number> {
    let count = 0;
    for (const p of this.#projects.values()) if (p.orgId === orgId) count += 1;
    return count;
  }

  // ---- API keys ----
  async createApiKey(
    input: Omit<ApiKeyHashed, 'createdAt' | 'revokedAt' | 'lastUsedAt'>,
  ): Promise<ApiKeyHashed> {
    if (this.#apiKeysByPrefix.has(input.prefix)) {
      throw new Error(`api key prefix "${input.prefix}" collision`);
    }
    const key: ApiKeyHashed = {
      ...input,
      createdAt: Date.now(),
      revokedAt: null,
      lastUsedAt: null,
    };
    this.#apiKeys.set(key.id, key);
    this.#apiKeysByPrefix.set(key.prefix, key.id);
    return key;
  }
  async getApiKeyByPrefix(prefix: string): Promise<ApiKeyHashed | null> {
    const id = this.#apiKeysByPrefix.get(prefix);
    return id ? (this.#apiKeys.get(id) ?? null) : null;
  }
  async revokeApiKey(id: string, at: number): Promise<void> {
    const k = this.#apiKeys.get(id);
    if (!k) return;
    this.#apiKeys.set(id, { ...k, revokedAt: at });
  }
  async recordApiKeyUse(id: string, at: number): Promise<void> {
    const k = this.#apiKeys.get(id);
    if (!k) return;
    this.#apiKeys.set(id, { ...k, lastUsedAt: at });
  }
  async listApiKeysForProject(projectId: string): Promise<ReadonlyArray<ApiKeyHashed>> {
    return [...this.#apiKeys.values()].filter((k) => k.projectId === projectId);
  }

  // ---- Sessions ----
  async createSession(input: Omit<Session, 'createdAt'>): Promise<Session> {
    const s: Session = { ...input, createdAt: Date.now() };
    this.#sessions.set(s.id, s);
    this.#sessionsByTokenHash.set(s.tokenHash, s.id);
    return s;
  }
  async getSessionByTokenHash(tokenHash: string): Promise<Session | null> {
    const id = this.#sessionsByTokenHash.get(tokenHash);
    return id ? (this.#sessions.get(id) ?? null) : null;
  }
  async deleteSession(id: string): Promise<void> {
    const s = this.#sessions.get(id);
    if (!s) return;
    this.#sessions.delete(id);
    this.#sessionsByTokenHash.delete(s.tokenHash);
  }
  async deleteExpiredSessions(now: number): Promise<number> {
    let count = 0;
    for (const [id, s] of this.#sessions) {
      if (s.expiresAt < now) {
        this.#sessions.delete(id);
        this.#sessionsByTokenHash.delete(s.tokenHash);
        count += 1;
      }
    }
    return count;
  }

  // ---- Magic links ----
  async createMagicLink(input: Omit<MagicLink, 'createdAt' | 'consumedAt'>): Promise<MagicLink> {
    const link: MagicLink = { ...input, createdAt: Date.now(), consumedAt: null };
    this.#magicLinks.set(link.id, link);
    this.#magicLinksByTokenHash.set(link.tokenHash, link.id);
    return link;
  }
  async consumeMagicLink(tokenHash: string, at: number): Promise<MagicLink | null> {
    const id = this.#magicLinksByTokenHash.get(tokenHash);
    if (!id) return null;
    const link = this.#magicLinks.get(id);
    if (!link) return null;
    if (link.consumedAt !== null) return null; // single-use
    if (link.expiresAt < at) return null;
    const consumed: MagicLink = { ...link, consumedAt: at };
    this.#magicLinks.set(id, consumed);
    return consumed;
  }

  // ---- Webhooks ----
  async createWebhook(input: Omit<Webhook, 'createdAt' | 'pausedAt'>): Promise<Webhook> {
    const webhook: Webhook = { ...input, createdAt: Date.now(), pausedAt: null };
    this.#webhooks.set(webhook.id, webhook);
    return webhook;
  }
  async listWebhooksForProject(projectId: string): Promise<ReadonlyArray<Webhook>> {
    return [...this.#webhooks.values()].filter((w) => w.projectId === projectId);
  }
  async getWebhookById(id: string): Promise<Webhook | null> {
    return this.#webhooks.get(id) ?? null;
  }
  async setWebhookPaused(id: string, pausedAt: number | null): Promise<Webhook | null> {
    const existing = this.#webhooks.get(id);
    if (!existing) return null;
    const updated: Webhook = { ...existing, pausedAt };
    this.#webhooks.set(id, updated);
    return updated;
  }
  async deleteWebhook(id: string): Promise<boolean> {
    return this.#webhooks.delete(id);
  }
}
