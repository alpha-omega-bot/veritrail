/**
 * @veritrail/control-plane
 *
 * Multi-tenant SaaS layer above the Veritrail ledger.
 *
 *   organizations
 *     └── users (many-to-many via memberships)
 *     └── projects
 *          └── api_keys  -> Veritrail-server `ApiKeyPrincipal` with labelScope
 *                            { org: <orgId>, project: <projectId> }
 *
 * The control plane stores its own facts (orgs, users, billing state, API key
 * hashes) in a separate schema — these are NOT ledger events. The ledger
 * remains the system of record for *governance facts inside a project*;
 * control-plane facts are about *managing the SaaS itself*.
 *
 * The package is storage-port agnostic. The default `InMemoryControlPlaneStore`
 * keeps everything in JS Maps for tests; production uses the Postgres adapter
 * from `@veritrail/relational-store` via the same port.
 */

export {
  type ControlPlaneStore,
  type Organization,
  type Project,
  type User,
  type Membership,
  type ApiKeyHashed,
  type Session,
  type MagicLink,
  type SubscriptionStatus,
  type Tier,
  type OrgRole,
  type Webhook,
} from './schema.js';
export { InMemoryControlPlaneStore } from './memory-store.js';
export {
  PostgresControlPlaneStore,
  migrateControlPlane,
  CONTROL_PLANE_MIGRATION_PATH,
} from './postgres-store.js';
export { ControlPlane, createControlPlane, type ControlPlaneOptions } from './control-plane.js';
export { TIER_LIMITS, type TierLimits } from './plans.js';
export {
  StripeWebhookHandler,
  InMemoryStripeEventDedup,
  type StripeWebhookHandlerOptions,
  type StripeWebhookResult,
  type StripeEventDedup,
} from './billing/stripe.js';
export {
  UsageTracker,
  type UsageCheck,
  type UsageEntry,
  type UsageFlushFn,
  type UsageTrackerOptions,
} from './billing/quotas.js';
export {
  ResendEmailAdapter,
  RESEND_EMAIL_ENDPOINT,
  type EmailAdapter,
  type EmailMessage,
  type ResendEmailAdapterOptions,
  type FetchImpl,
} from './email.js';
export {
  buildMagicLinkEmail,
  buildWelcomeEmail,
  buildQuotaWarningEmail,
  buildBillingReceiptEmail,
  formatUsdMinor,
  type RenderedEmail,
  type MagicLinkEmailOptions,
  type WelcomeEmailOptions,
  type QuotaWarningEmailOptions,
  type BillingReceiptEmailOptions,
} from './email-templates.js';
