import {
  ActionSchema,
  err,
  ok,
  validationError,
  VeritrailError,
  type Action,
  type ActionReversal,
  type Actor,
  type JsonValue,
  type Ledger,
  type Money,
  type ModuleContext,
  type Result,
  type RiskLevel,
} from '@veritrail/core';
import {
  createPermissionsModule,
  type PermissionsConfig,
  type PermissionsModule,
  type PolicyDecision,
} from '@veritrail/permissions';
import { createSpendGuardModule, type SpendGuardModule } from '@veritrail/spend-guard';

import { createModuleContext, type ContextOverrides } from './context.js';

/** The fields a caller supplies to govern an action (the id and status are assigned). */
export interface ActionInput {
  actorId: string;
  type: string;
  target?: string;
  params?: JsonValue;
  reversible?: boolean;
  reversal?: ActionReversal;
  cost?: Money;
  risk?: RiskLevel;
  context?: JsonValue;
}

export interface GovernanceConfig extends ContextOverrides {
  permissions?: PermissionsConfig;
}

export interface RunOptions {
  actor?: Actor;
  correlationId?: string;
  labels?: Record<string, string>;
}

export interface GovernedExecution<T> {
  action: Action;
  decision: PolicyDecision;
  value: T;
}

/**
 * The `Governor` is the in-process instrumentation entry point. `run()` enforces
 * the canonical lifecycle around an agent action and records every step on the
 * ledger:
 *
 *   propose → permission check → spend pre-authorization → execute →
 *   charge + record executed   (or record failed on throw)
 *
 * This is how an integrating agent gets audit, permissions, and spend guard for
 * free by routing its side effects through one call.
 */
export class Governor {
  readonly ctx: ModuleContext;
  readonly permissions: PermissionsModule;
  readonly spendGuard: SpendGuardModule;

  constructor(ledger: Ledger, config: GovernanceConfig = {}) {
    this.ctx = createModuleContext(ledger, config);
    this.permissions = createPermissionsModule(this.ctx, config.permissions ?? {});
    this.spendGuard = createSpendGuardModule(this.ctx);
  }

  async run<T>(
    input: ActionInput,
    execute: () => Promise<T>,
    options: RunOptions = {},
  ): Promise<Result<GovernedExecution<T>, VeritrailError>> {
    const parsed = ActionSchema.safeParse({
      id: this.ctx.ids.next('act'),
      status: 'proposed',
      ...input,
    });
    if (!parsed.success) {
      return err(validationError('invalid action input'));
    }
    const action = parsed.data;
    const corr = options.correlationId;
    const envelope = corr !== undefined ? { correlationId: corr } : {};

    await this.ctx.ledger.append({
      type: 'action.proposed',
      actorId: action.actorId,
      ...envelope,
      payload: { action },
    });

    const decision = await this.permissions.enforce(
      action,
      options.actor !== undefined ? { actor: options.actor } : {},
    );
    if (!decision.ok) return err(decision.error);
    if (decision.value.effect === 'require_approval') {
      return err(
        new VeritrailError('POLICY_DENIED', 'action requires manual approval', {
          details: { requiresApproval: true, reason: decision.value.reason },
        }),
      );
    }

    if (action.cost) {
      const authorized = await this.spendGuard.authorize({
        actorId: action.actorId,
        amount: action.cost,
        actionId: action.id,
        ...(options.labels !== undefined ? { labels: options.labels } : {}),
      });
      if (!authorized.ok) return err(authorized.error);
    }

    try {
      const value = await execute();
      if (action.cost) {
        const charged = await this.spendGuard.charge({
          actorId: action.actorId,
          amount: action.cost,
          actionId: action.id,
          ...(options.labels !== undefined ? { labels: options.labels } : {}),
        });
        if (!charged.ok) {
          // The side effect ran but spend could not be recorded (e.g. a
          // concurrent action consumed the headroom). Record the failure rather
          // than silently letting the budget drift below the system of record.
          await this.ctx.ledger.append({
            type: 'action.failed',
            actorId: action.actorId,
            causationId: action.id,
            ...envelope,
            payload: {
              actionId: action.id,
              error: `spend charge failed: ${charged.error.message}`,
            },
          });
          return err(charged.error);
        }
      }
      await this.ctx.ledger.append({
        type: 'action.executed',
        actorId: action.actorId,
        causationId: action.id,
        ...envelope,
        payload: {
          actionId: action.id,
          outcome: 'success',
          ...(action.cost !== undefined ? { cost: action.cost } : {}),
        },
      });
      return ok({ action, decision: decision.value, value });
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      await this.ctx.ledger.append({
        type: 'action.failed',
        actorId: action.actorId,
        causationId: action.id,
        ...envelope,
        payload: { actionId: action.id, error: message },
      });
      return err(cause instanceof VeritrailError ? cause : new VeritrailError('INTERNAL', message));
    }
  }
}

/** Convenience constructor mirroring the module factory style. */
export function createGovernor(ledger: Ledger, config: GovernanceConfig = {}): Governor {
  return new Governor(ledger, config);
}
