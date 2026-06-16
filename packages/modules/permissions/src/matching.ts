/**
 * Pure predicate helpers used by the permissions engine to decide whether a
 * single policy's `match` block applies to a given action/actor.
 *
 * Every helper here is side-effect free and total: it returns `true` only when
 * the corresponding condition is *present and satisfied*. A missing actor (when
 * a condition needs one) makes that condition fail — never throw.
 */
import type { Action, Actor, PolicyMatch } from '@veritrail/core';
import { RISK_ORDER } from '@veritrail/core';

/** Escape every regular-expression metacharacter except `*`. */
function escapeRegexExceptStar(pattern: string): string {
  return pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Compile a glob pattern (where `*` matches any run of characters) into an
 * anchored, safe `RegExp`. All other characters are matched literally.
 */
export function globToRegExp(pattern: string): RegExp {
  const body = escapeRegexExceptStar(pattern)
    // Collapse runs of `*` to a single wildcard: adjacent `.*` groups are the
    // root cause of catastrophic backtracking (ReDoS) on non-matching input.
    .replace(/\*+/g, '*')
    // `[\s\S]*` matches any run of characters INCLUDING newlines, so a `*` glob
    // cannot be bypassed by embedding a newline in the target.
    .replace(/\*/g, '[\\s\\S]*');
  return new RegExp(`^${body}$`);
}

/** `actionTypes` entries support a single trailing `*`, e.g. `tool.*`. */
export function actionTypeMatches(pattern: string, type: string): boolean {
  if (pattern.endsWith('*')) {
    return type.startsWith(pattern.slice(0, -1));
  }
  return pattern === type;
}

/** A glob pattern matches the action's target string. */
export function targetMatches(pattern: string, target: string): boolean {
  return globToRegExp(pattern).test(target);
}

/**
 * Does `match` apply to `action` (and optional `actor`)? An empty match object
 * matches everything. All present conditions must hold (logical AND); within a
 * list-valued condition any element matching is sufficient (logical OR).
 */
export function matchesAction(match: PolicyMatch, action: Action, actor?: Actor): boolean {
  if (match.actorKinds !== undefined) {
    if (!actor || !match.actorKinds.includes(actor.kind)) return false;
  }

  if (match.actorIds !== undefined) {
    if (!match.actorIds.includes(action.actorId)) return false;
  }

  if (match.actionTypes !== undefined) {
    if (!match.actionTypes.some((p) => actionTypeMatches(p, action.type))) return false;
  }

  if (match.targets !== undefined) {
    if (!match.targets.some((p) => targetMatches(p, action.target))) return false;
  }

  if (match.minRisk !== undefined) {
    if (action.risk === undefined) return false;
    if (RISK_ORDER[action.risk] < RISK_ORDER[match.minRisk]) return false;
  }

  if (match.labels !== undefined) {
    const labels = actor?.labels ?? {};
    for (const [k, v] of Object.entries(match.labels)) {
      if (labels[k] !== v) return false;
    }
  }

  return true;
}
