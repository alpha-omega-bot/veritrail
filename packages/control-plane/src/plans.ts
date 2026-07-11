import type { Tier } from './schema.js';

/**
 * Tier limits. Hard-coded here so a request-time quota check doesn't have to
 * round-trip to Stripe — Stripe is authoritative for *which* tier an org is
 * on; once we know the tier we know its limits.
 */
export interface TierLimits {
  readonly tier: Tier;
  /** Monthly events ceiling. Hard-stop on free; metered overage on paid. */
  readonly eventsPerMonth: number;
  /** Maximum number of projects an org can have on this tier. */
  readonly maxProjects: number;
  /** Whether SSO/OIDC is permitted (Enterprise feature). */
  readonly ssoEnabled: boolean;
  /** Whether on-prem signing (Receipts with customer-held keys) is permitted. */
  readonly customSigning: boolean;
  /** Whether the simulator + auto-RCA can be invoked. */
  readonly advancedFeatures: boolean;
  /** Whether cryptographic Receipts are generated (Pro+). */
  readonly receiptsEnabled: boolean;
  /** Monthly base price in USD minor units (cents). 0 for free, -1 for "custom". */
  readonly baseMonthlyMinor: number;
  /** Per-event overage charge (in millicents = 0.001 cent). */
  readonly overageMillicents: number;
}

export const TIER_LIMITS: Record<Tier, TierLimits> = {
  free: {
    tier: 'free',
    eventsPerMonth: 10_000,
    maxProjects: 1,
    ssoEnabled: false,
    customSigning: false,
    advancedFeatures: false,
    receiptsEnabled: false,
    baseMonthlyMinor: 0,
    overageMillicents: 0, // hard stop, no overage allowed
  },
  starter: {
    tier: 'starter',
    eventsPerMonth: 100_000,
    maxProjects: 3,
    ssoEnabled: false,
    customSigning: false,
    advancedFeatures: false,
    receiptsEnabled: false,
    baseMonthlyMinor: 4_900, // $49.00
    overageMillicents: 500, // $0.0005 per event
  },
  pro: {
    tier: 'pro',
    eventsPerMonth: 1_000_000,
    maxProjects: 10,
    ssoEnabled: false,
    customSigning: false,
    advancedFeatures: true,
    receiptsEnabled: true,
    baseMonthlyMinor: 29_900, // $299.00
    overageMillicents: 250, // $0.00025 per event
  },
  enterprise: {
    tier: 'enterprise',
    eventsPerMonth: Number.MAX_SAFE_INTEGER,
    maxProjects: Number.MAX_SAFE_INTEGER,
    ssoEnabled: true,
    customSigning: true,
    advancedFeatures: true,
    receiptsEnabled: true,
    baseMonthlyMinor: -1, // contact sales
    overageMillicents: 100, // negotiated; default $0.0001/event
  },
};

export function tierLimits(tier: Tier): TierLimits {
  return TIER_LIMITS[tier];
}
