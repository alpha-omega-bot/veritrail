import type { ControlPlane } from '@veritrail/control-plane';
import type { AnchorStore, Clock, IdGenerator, Ledger } from '@veritrail/core';
import type { FastifyInstance } from 'fastify';

import type { LlmAdapter } from '@veritrail/auto-rca';
import { registerAgentReputationRoutes } from './agent-reputation-routes.js';
import { registerBillingRoutes } from './billing-routes.js';
import { registerComplianceRoutes } from './compliance-routes.js';
import { registerCostOptimizerRoutes } from './cost-optimizer-routes.js';
import { registerRcaRoutes } from './rca-routes.js';
import { registerReceiptRoutes } from './receipt-routes.js';
import { registerRiskNetworkRoutes } from './risk-network-routes.js';
import { registerSimulatorRoutes } from './simulator-routes.js';
import { registerWebhookRoutes } from './webhook-routes.js';

export interface ExtensionOptions {
  /** Compliance reports endpoint. Enabled when `complianceEnabled: true`. */
  readonly complianceEnabled?: boolean;

  /** Cryptographic receipts endpoint. Requires an AnchorStore. */
  readonly anchorStore?: AnchorStore;

  /** AI-driven RCA. Requires either anthropicApiKey or an adapter (for tests). */
  readonly autoRca?: {
    readonly anthropicApiKey?: string;
    readonly model?: string;
    readonly adapter?: LlmAdapter;
  };

  /** Policy simulator endpoint. Enabled when `simulatorEnabled: true`. */
  readonly simulatorEnabled?: boolean;

  /** Cost-optimizer endpoint. Enabled when `costOptimizerEnabled: true`. */
  readonly costOptimizerEnabled?: boolean;

  /** Agent reputation endpoint (public). Enabled when `reputationEnabled: true`. */
  readonly reputationEnabled?: boolean;

  /** Risk network endpoint. Requires `riskNetworkSalt`. */
  readonly riskNetworkSalt?: string;

  /** Webhook management endpoints. Requires the control plane. */
  readonly webhooks?: {
    readonly controlPlane: ControlPlane;
  };

  /** Stripe checkout endpoint. Requires the control plane and Stripe config. */
  readonly billing?: {
    readonly controlPlane: ControlPlane;
    readonly stripeSecretKey?: string;
    readonly priceIdForTier: (tier: string) => string | null;
    readonly successUrl: string;
    readonly cancelUrl: string;
    readonly fetchImpl?: typeof fetch;
  };
}

export interface ExtensionWiringDeps {
  readonly ledger: Ledger;
  readonly clock: Clock;
  readonly ids: IdGenerator;
}

export function registerExtensions(
  app: FastifyInstance,
  deps: ExtensionWiringDeps,
  options: ExtensionOptions,
): void {
  if (options.complianceEnabled) {
    registerComplianceRoutes(app, { ledger: deps.ledger });
  }
  if (options.anchorStore) {
    registerReceiptRoutes(app, {
      ledger: deps.ledger,
      anchorStore: options.anchorStore,
      clock: deps.clock,
      ids: deps.ids,
    });
  }
  if (options.simulatorEnabled) {
    registerSimulatorRoutes(app, { ledger: deps.ledger });
  }
  if (options.costOptimizerEnabled) {
    registerCostOptimizerRoutes(app, { ledger: deps.ledger });
  }
  if (options.reputationEnabled) {
    registerAgentReputationRoutes(app, { ledger: deps.ledger });
  }
  if (options.riskNetworkSalt) {
    registerRiskNetworkRoutes(app, {
      ledger: deps.ledger,
      orgSalt: options.riskNetworkSalt,
    });
  }
  if (options.autoRca) {
    registerRcaRoutes(app, {
      ledger: deps.ledger,
      ...(options.autoRca.anthropicApiKey !== undefined
        ? { anthropicApiKey: options.autoRca.anthropicApiKey }
        : {}),
      ...(options.autoRca.model !== undefined ? { model: options.autoRca.model } : {}),
      ...(options.autoRca.adapter !== undefined ? { adapter: options.autoRca.adapter } : {}),
    });
  }
  if (options.webhooks) {
    registerWebhookRoutes(app, { controlPlane: options.webhooks.controlPlane });
  }
  if (options.billing) {
    registerBillingRoutes(app, {
      controlPlane: options.billing.controlPlane,
      ...(options.billing.stripeSecretKey !== undefined
        ? { stripeSecretKey: options.billing.stripeSecretKey }
        : {}),
      priceIdForTier: options.billing.priceIdForTier,
      successUrl: options.billing.successUrl,
      cancelUrl: options.billing.cancelUrl,
      ...(options.billing.fetchImpl !== undefined ? { fetchImpl: options.billing.fetchImpl } : {}),
    });
  }
}
