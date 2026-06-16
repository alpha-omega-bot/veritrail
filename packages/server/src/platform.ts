import {
  ConsoleLogger,
  DefaultIdGenerator,
  noopLogger,
  systemClock,
  type Clock,
  type IdGenerator,
  type Ledger,
  type Logger,
  type ModuleContext,
} from '@veritrail/core';
import { createAuditModule, type AuditModule } from '@veritrail/audit';
import {
  createPermissionsModule,
  type PermissionsConfig,
  type PermissionsModule,
} from '@veritrail/permissions';
import { createSpendGuardModule, type SpendGuardModule } from '@veritrail/spend-guard';
import { createRollbackModule, type RollbackModule } from '@veritrail/rollback';
import { createForensicsModule, type ForensicsModule } from '@veritrail/forensics';
import { createEvidenceModule, type EvidenceModule } from '@veritrail/evidence';
import { createDecisionMemoryModule, type DecisionMemoryModule } from '@veritrail/decision-memory';
import { createVendorRiskModule, type VendorRiskModule } from '@veritrail/vendor-risk';

export interface PlatformOptions {
  clock?: Clock;
  ids?: IdGenerator;
  logger?: Logger;
  permissions?: PermissionsConfig;
}

/**
 * The full set of governance engines wired to one ledger via one shared
 * `ModuleContext`. This is the in-process platform the HTTP server, the CLI, and
 * tests all build on, so every surface sees identical behavior.
 */
export interface Platform {
  readonly ledger: Ledger;
  readonly ctx: ModuleContext;
  readonly audit: AuditModule;
  readonly permissions: PermissionsModule;
  readonly spendGuard: SpendGuardModule;
  readonly rollback: RollbackModule;
  readonly forensics: ForensicsModule;
  readonly evidence: EvidenceModule;
  readonly decisionMemory: DecisionMemoryModule;
  readonly vendorRisk: VendorRiskModule;
}

export function createPlatform(ledger: Ledger, options: PlatformOptions = {}): Platform {
  const clock = options.clock ?? systemClock;
  const ctx: ModuleContext = {
    ledger,
    clock,
    ids: options.ids ?? new DefaultIdGenerator(clock),
    logger: options.logger ?? noopLogger,
  };
  return {
    ledger,
    ctx,
    audit: createAuditModule(ctx),
    permissions: createPermissionsModule(ctx, options.permissions ?? {}),
    spendGuard: createSpendGuardModule(ctx),
    rollback: createRollbackModule(ctx),
    forensics: createForensicsModule(ctx),
    evidence: createEvidenceModule(ctx),
    decisionMemory: createDecisionMemoryModule(ctx),
    vendorRisk: createVendorRiskModule(ctx),
  };
}

/** A development logger that emits structured JSON to stderr. */
export const developmentLogger: Logger = new ConsoleLogger({ component: 'veritrail-server' });
