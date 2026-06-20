/**
 * `@veritrail/permissions` — a deny-by-default policy engine that gates agent
 * actions.
 *
 * Policies are evaluated as a pure projection over an in-memory rule set; the
 * *decision* is then enforced by appending the appropriate facts to the shared
 * ledger (`policy.evaluated`, plus `action.authorized` / `action.denied`). The
 * ledger remains the single system of record — this module never invents a
 * parallel store of decisions.
 *
 * Safe by construction: when no enabled policy matches an action, the engine
 * applies the configured default effect, which defaults to `deny`.
 */
import type {
  Action,
  Actor,
  ModuleContext,
  Policy,
  PolicyEffect,
  Result,
  VeritrailError,
  VeritrailModule,
} from '@veritrail/core';
import {
  PolicySchema,
  VeritrailError as VeritrailErrorClass,
  err,
  isErr,
  ok,
} from '@veritrail/core';

import { matchesAction } from './matching.js';

/** The outcome of evaluating an action against the policy set. */
export interface PolicyDecision {
  readonly effect: PolicyEffect;
  readonly matchedPolicyId?: string;
  readonly reason: string;
}

/** A set of exact tenant labels constraining which policies apply. */
export type PolicyScope = Readonly<Record<string, string>>;

/**
 * Is a policy in scope for a principal with the given label scope? A global
 * policy (no `tenant`) always applies; an unscoped principal (no `scope`) sees
 * every policy; otherwise the policy's `tenant` labels must all be present in
 * the principal's scope. See ADR-0004.
 */
function policyInScope(policy: Policy, scope: PolicyScope | undefined): boolean {
  if (policy.tenant === undefined) return true;
  if (scope === undefined) return true;
  return Object.entries(policy.tenant).every(([key, value]) => scope[key] === value);
}

/** Construction-time options for {@link PermissionsModule}. */
export interface PermissionsConfig {
  /** Effect applied when no enabled policy matches. SAFE DEFAULT: `deny`. */
  readonly defaultEffect?: PolicyEffect;
}

/** Tie-break ranking when two policies share the same priority: deny wins. */
const EFFECT_RANK: Record<PolicyEffect, number> = {
  deny: 2,
  require_approval: 1,
  allow: 0,
};

/**
 * Order policies the way evaluation prefers them: highest priority first, then
 * by effect rank (deny > require_approval > allow) so equal-priority ties
 * resolve toward the most restrictive effect.
 */
function comparePolicies(a: Policy, b: Policy): number {
  if (a.priority !== b.priority) return b.priority - a.priority;
  return EFFECT_RANK[b.effect] - EFFECT_RANK[a.effect];
}

/**
 * The permissions engine. Holds a set of {@link Policy} rules and gates actions
 * against them.
 */
export class PermissionsModule implements VeritrailModule {
  readonly info = {
    name: '@veritrail/permissions',
    version: '0.1.0',
    capability: 'permissions' as const,
  };

  readonly #ctx: ModuleContext;
  readonly #defaultEffect: PolicyEffect;
  readonly #policies = new Map<string, Policy>();

  constructor(ctx: ModuleContext, config?: PermissionsConfig) {
    this.#ctx = ctx;
    this.#defaultEffect = config?.defaultEffect ?? 'deny';
  }

  /**
   * Validate and register a policy. An id is minted via `ids.next('pol')` when
   * the input omits one. Returns the stored, fully-parsed policy or a
   * VALIDATION error.
   */
  addPolicy(input: unknown): Result<Policy, VeritrailError> {
    // Mint an id before validation when the caller did not supply one, so the
    // schema's required `id` is satisfied without mutating caller input shape.
    let candidate = input;
    if (
      input !== null &&
      typeof input === 'object' &&
      !('id' in (input as Record<string, unknown>))
    ) {
      candidate = { ...(input as Record<string, unknown>), id: this.#ctx.ids.next('pol') };
    }

    const parsed = PolicySchema.safeParse(candidate);
    if (!parsed.success) {
      return err(
        new VeritrailErrorClass('VALIDATION', 'invalid policy', {
          details: parsed.error.flatten(),
        }),
      );
    }

    const policy = parsed.data;
    this.#policies.set(policy.id, policy);
    this.#ctx.logger.debug('policy added', { policyId: policy.id, effect: policy.effect });
    return ok(policy);
  }

  /** Remove a policy by id. Returns `true` if a policy was removed. */
  removePolicy(id: string): boolean {
    return this.#policies.delete(id);
  }

  /**
   * Registered policies, ordered by priority desc (then effect rank). With a
   * `scope`, only global policies and policies in that tenant scope are
   * returned; without one, every policy is returned. See ADR-0004.
   */
  listPolicies(scope?: PolicyScope): Policy[] {
    return [...this.#policies.values()]
      .filter((p) => policyInScope(p, scope))
      .sort(comparePolicies);
  }

  /**
   * Evaluate an action against the policy set. PURE — performs no I/O and
   * appends nothing. Among enabled policies whose `match` applies, the highest
   * priority wins (ties resolve deny > require_approval > allow). When nothing
   * matches, the configured default effect is used.
   *
   * A `scope` restricts evaluation to global + in-scope policies, so a tenant is
   * judged only by rules that govern it; deny-by-default still applies when no
   * in-scope policy matches.
   */
  evaluate(action: Action, opts?: { actor?: Actor; scope?: PolicyScope }): PolicyDecision {
    const actor = opts?.actor;
    const candidates = this.listPolicies(opts?.scope).filter(
      (p) => p.enabled && matchesAction(p.match, action, actor),
    );

    const winner = candidates[0];
    if (!winner) {
      return {
        effect: this.#defaultEffect,
        reason: `no policy matched; applied default effect '${this.#defaultEffect}'`,
      };
    }

    return {
      effect: winner.effect,
      matchedPolicyId: winner.id,
      reason: `matched policy '${winner.name}' (${winner.id}) with effect '${winner.effect}'`,
    };
  }

  /**
   * Evaluate then enforce: append a `policy.evaluated` fact for the decision and,
   * depending on the effect, the corresponding action lifecycle event.
   *
   * - `allow`            → append `action.authorized`; return `ok(decision)`.
   * - `deny`             → append `action.denied`; return `err(POLICY_DENIED)`.
   * - `require_approval` → append nothing further; return `ok(decision)`.
   */
  async enforce(
    action: Action,
    opts?: { actor?: Actor; scope?: PolicyScope; labels?: Readonly<Record<string, string>> },
  ): Promise<Result<PolicyDecision, VeritrailError>> {
    const decision = this.evaluate(action, opts);
    const labels = opts?.labels;
    const labelEnvelope = labels !== undefined ? { labels } : {};

    const evalRes = await this.#ctx.ledger.append({
      type: 'policy.evaluated',
      actorId: action.actorId,
      correlationId: action.id,
      causationId: action.id,
      ...labelEnvelope,
      payload: {
        actionId: action.id,
        effect: decision.effect,
        ...(decision.matchedPolicyId !== undefined
          ? { matchedPolicyId: decision.matchedPolicyId }
          : {}),
        reason: decision.reason,
      },
    });
    if (isErr(evalRes)) return err(evalRes.error);

    switch (decision.effect) {
      case 'allow': {
        const res = await this.#ctx.ledger.append({
          type: 'action.authorized',
          actorId: action.actorId,
          correlationId: action.id,
          causationId: action.id,
          ...labelEnvelope,
          payload: {
            actionId: action.id,
            ...(decision.matchedPolicyId !== undefined
              ? { policyId: decision.matchedPolicyId }
              : {}),
          },
        });
        if (isErr(res)) return err(res.error);
        return ok(decision);
      }
      case 'deny': {
        const res = await this.#ctx.ledger.append({
          type: 'action.denied',
          actorId: action.actorId,
          correlationId: action.id,
          causationId: action.id,
          ...labelEnvelope,
          payload: {
            actionId: action.id,
            reason: decision.reason,
            ...(decision.matchedPolicyId !== undefined
              ? { policyId: decision.matchedPolicyId }
              : {}),
          },
        });
        if (isErr(res)) return err(res.error);
        return err(
          new VeritrailErrorClass('POLICY_DENIED', decision.reason, {
            details: { actionId: action.id },
          }),
        );
      }
      case 'require_approval':
        return ok(decision);
      default:
        // Exhaustive: PolicyEffect has no other members.
        return ok(decision);
    }
  }
}

/** Factory mirroring the other modules' construction convention. */
export function createPermissionsModule(
  ctx: ModuleContext,
  config?: PermissionsConfig,
): PermissionsModule {
  return new PermissionsModule(ctx, config);
}

export { globToRegExp, matchesAction } from './matching.js';
