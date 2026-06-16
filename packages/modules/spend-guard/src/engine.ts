import {
  BudgetSchema,
  VeritrailError,
  addMoney,
  compareMoney,
  isErr,
  err,
  ok,
  unwrap,
  zeroMoney,
  type Budget,
  type LedgerRecord,
  type ModuleContext,
  type Money,
  type Result,
  type VeritrailModule,
} from '@veritrail/core';

import { withinWindow } from './windows.js';

/** A budget paired with its current window-aware spend and headroom. */
export type SpendStatus = {
  /** The budget this status describes. */
  budget: Budget;
  /** Total charged within the budget's window. */
  spent: Money;
  /** Headroom remaining (`limit - spent`); may be negative if a soft budget overran. */
  remaining: Money;
  /** True when `spent` has reached or passed the limit. */
  exceeded: boolean;
};

/** Request to authorize or charge spend against the active budgets. */
export interface AuthorizeInput {
  /** Actor responsible for the spend (used for `actor`-scoped budgets). */
  actorId: string;
  /** The amount being authorized/charged. */
  amount: Money;
  /** Labels carried by the action (used for `label`-scoped budgets). */
  labels?: Record<string, string>;
  /** The action this spend belongs to, recorded on emitted events. */
  actionId?: string;
}

/** Negate a money amount (for `limit - spent` via {@link addMoney}). */
function negate(m: Money): Money {
  return { currency: m.currency, amountMinor: -m.amountMinor };
}

/**
 * Spend Guard — budget tracking and hard-stop enforcement as a projection over
 * the ledger's `budget.charged`/`budget.exceeded` events.
 *
 * Budgets are held in memory (the operator's configuration), but *spend* is
 * always re-derived from the ledger so the engine is stateless with respect to
 * accumulated cost and cannot drift from the system of record.
 */
export class SpendGuardModule implements VeritrailModule {
  readonly info = {
    name: '@veritrail/spend-guard',
    version: '0.1.0',
    capability: 'spend-guard' as const,
  };

  readonly #ctx: ModuleContext;
  readonly #budgets = new Map<string, Budget>();

  constructor(ctx: ModuleContext) {
    this.#ctx = ctx;
  }

  /**
   * Validate and upsert a budget. An absent `id` is assigned via
   * `ctx.ids.next('bud')` before validation. Returns the stored budget.
   */
  setBudget(input: unknown): Result<Budget, VeritrailError> {
    const withId = this.#ensureId(input);
    const parsed = BudgetSchema.safeParse(withId);
    if (!parsed.success) {
      return err(
        new VeritrailError('VALIDATION', 'budget failed validation', {
          details: parsed.error.issues.map((i) => ({
            path: i.path.map(String).join('.'),
            message: i.message,
          })),
        }),
      );
    }
    const budget = parsed.data;
    this.#budgets.set(budget.id, budget);
    this.#ctx.logger.debug('spend-guard.setBudget', { id: budget.id, name: budget.name });
    return ok(budget);
  }

  /** All configured budgets, in insertion order. */
  listBudgets(): Budget[] {
    return [...this.#budgets.values()];
  }

  /**
   * Check a prospective spend against every matching budget WITHOUT recording it.
   *
   * For each matching hard-stop budget, if `spent + amount` would exceed the
   * limit, a `budget.exceeded` event is appended and a `BUDGET_EXCEEDED` error is
   * returned (the first offender wins). Soft budgets that would overrun are
   * allowed but logged at warn level. A `VALIDATION` error is returned if the
   * amount currency differs from a matching budget's currency.
   */
  async authorize(input: AuthorizeInput): Promise<Result<void, VeritrailError>> {
    const matches = this.#matching(input);
    for (const budget of matches) {
      // A budget in another currency does not apply to this charge — skip it,
      // consistent with how #spent attributes charges. (Do not abort the charge.)
      if (budget.limit.currency !== input.amount.currency) continue;

      const spent = await this.#spent(budget);
      const projectedResult = addMoney(spent, input.amount);
      if (isErr(projectedResult)) return projectedResult;
      const projected = unwrap(projectedResult);

      // `projected > limit` exceeds; reaching the limit exactly is allowed.
      if (compareMoney(projected, budget.limit) <= 0) continue;

      if (!budget.hardStop) {
        this.#ctx.logger.warn('spend-guard.soft-budget-exceeded', {
          budgetId: budget.id,
          name: budget.name,
          spent: spent.amountMinor,
          attempted: input.amount.amountMinor,
          limit: budget.limit.amountMinor,
        });
        continue;
      }

      const exceeded = await this.#ctx.ledger.append({
        type: 'budget.exceeded',
        actorId: input.actorId,
        ...(input.labels !== undefined ? { labels: input.labels } : {}),
        payload: {
          budgetId: budget.id,
          scope: budget.scope,
          attempted: projected,
          limit: budget.limit,
          ...(input.actionId !== undefined ? { actionId: input.actionId } : {}),
        },
      });
      if (isErr(exceeded)) return exceeded;

      return err(
        new VeritrailError('BUDGET_EXCEEDED', `spend would exceed budget ${budget.name}`, {
          details: {
            budgetId: budget.id,
            spent: spent.amountMinor,
            attempted: input.amount.amountMinor,
            projected: projected.amountMinor,
            limit: budget.limit.amountMinor,
            currency: budget.limit.currency,
          },
        }),
      );
    }
    return ok(undefined);
  }

  /**
   * Authorize then record the spend by appending a `budget.charged` event. The
   * charge records its `actorId` and `labels`; spend is later attributed to a
   * budget by re-applying the same scope match used in {@link authorize}, so a
   * single charge accrues against the global, the actor's, and every matching
   * label budget at once. Returns the appended record.
   */
  async charge(input: AuthorizeInput): Promise<Result<LedgerRecord, VeritrailError>> {
    const authorized = await this.authorize(input);
    if (isErr(authorized)) return authorized;

    return this.#ctx.ledger.append({
      type: 'budget.charged',
      actorId: input.actorId,
      ...(input.labels !== undefined ? { labels: input.labels } : {}),
      payload: {
        scope: { kind: 'actor', value: input.actorId },
        amount: input.amount,
        ...(input.actionId !== undefined ? { actionId: input.actionId } : {}),
      },
    });
  }

  /** Window-aware spend status for every configured budget. */
  async status(): Promise<SpendStatus[]> {
    const out: SpendStatus[] = [];
    for (const budget of this.#budgets.values()) {
      const spent = await this.#spent(budget);
      const remainingResult = addMoney(budget.limit, negate(spent));
      const remaining = isErr(remainingResult)
        ? zeroMoney(budget.limit.currency)
        : unwrap(remainingResult);
      out.push({
        budget,
        spent,
        remaining,
        exceeded: compareMoney(spent, budget.limit) >= 0,
      });
    }
    return out;
  }

  /** Budgets that are enabled and match the input's actor/labels. */
  #matching(input: AuthorizeInput): Budget[] {
    return [...this.#budgets.values()].filter(
      (b) => b.enabled && this.#budgetMatchesInput(b, input),
    );
  }

  /** Whether `budget`'s scope selects this authorize input. */
  #budgetMatchesInput(budget: Budget, input: AuthorizeInput): boolean {
    const { scope } = budget;
    switch (scope.kind) {
      case 'global':
        return true;
      case 'actor':
        return scope.value === input.actorId;
      case 'label': {
        const eq = scope.value.indexOf('=');
        if (eq <= 0) return false;
        const key = scope.value.slice(0, eq);
        const value = scope.value.slice(eq + 1);
        return input.labels?.[key] === value;
      }
      default:
        return false;
    }
  }

  /**
   * Project total spend for a budget from `budget.charged` events that match the
   * budget's scope (by the charge's recorded `actorId`/`labels`, identical to the
   * matching used in {@link authorize}) and whose receipt timestamp falls within
   * the budget's window relative to `ctx.clock.now()`. Amounts are summed in the
   * budget's currency; charges in a different currency are ignored.
   */
  async #spent(budget: Budget): Promise<Money> {
    const now = this.#ctx.clock.now();
    const records = await this.#ctx.ledger.query({ types: ['budget.charged'] });
    let total = zeroMoney(budget.limit.currency);

    for (const record of records) {
      const event = record.event;
      if (event.type !== 'budget.charged') continue;
      const { amount } = event.payload;
      if (amount.currency !== budget.limit.currency) continue;
      if (
        !this.#budgetMatchesInput(budget, { actorId: event.actorId, amount, labels: event.labels })
      ) {
        continue;
      }
      if (!withinWindow(budget.window, record.timestamp, now)) continue;

      const summed = addMoney(total, amount);
      if (isErr(summed)) continue;
      total = unwrap(summed);
    }
    return total;
  }

  /** Assign an `id` from `ctx.ids` when the input object lacks one. */
  #ensureId(input: unknown): unknown {
    if (input === null || typeof input !== 'object') return input;
    const obj = input as Record<string, unknown>;
    if (obj['id'] !== undefined) return input;
    return { ...obj, id: this.#ctx.ids.next('bud') };
  }
}

/** Construct a {@link SpendGuardModule} from a module context. */
export function createSpendGuardModule(ctx: ModuleContext): SpendGuardModule {
  return new SpendGuardModule(ctx);
}
