/**
 * `@veritrail/spend-guard` — budget tracking and hard-stop enforcement.
 *
 * The engine projects spend from the ledger's `budget.charged` events and,
 * on authorize/charge, enforces configured {@link Budget} limits — appending a
 * `budget.exceeded` event and returning a `BUDGET_EXCEEDED` error when a
 * hard-stop budget would be breached.
 */
export {
  SpendGuardModule,
  createSpendGuardModule,
  type SpendStatus,
  type AuthorizeInput,
} from './engine.js';
export { WINDOW_MS, windowStart, withinWindow } from './windows.js';
