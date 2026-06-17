import type { EventInput } from '@veritrail/core';

/**
 * Produce a short, human-readable one-line summary of a ledger event.
 *
 * The output is intentionally terse and deterministic so it can be embedded in
 * timelines, incident reports, and log lines. Every event type in the core's
 * closed union is handled explicitly.
 */
export function summarize(event: EventInput): string {
  switch (event.type) {
    case 'action.proposed': {
      const { action } = event.payload;
      return `proposed action ${action.id} (${action.type})`;
    }
    case 'action.authorized': {
      const { actionId, authorizedBy } = event.payload;
      return authorizedBy !== undefined
        ? `authorized action ${actionId} by ${authorizedBy}`
        : `authorized action ${actionId}`;
    }
    case 'action.denied': {
      const { actionId, reason } = event.payload;
      return reason ? `denied action ${actionId}: ${reason}` : `denied action ${actionId}`;
    }
    case 'action.executed': {
      const { actionId, outcome } = event.payload;
      return `executed action ${actionId} (${outcome})`;
    }
    case 'action.failed': {
      const { actionId, error } = event.payload;
      return `failed action ${actionId}: ${error}`;
    }
    case 'action.rolled_back': {
      const { actionId, reason } = event.payload;
      return reason
        ? `rolled back action ${actionId}: ${reason}`
        : `rolled back action ${actionId}`;
    }
    case 'decision.recorded': {
      const { decision } = event.payload;
      return `recorded decision ${decision.id}: ${decision.summary}`;
    }
    case 'evidence.attached': {
      const { evidence } = event.payload;
      return `attached evidence ${evidence.id} (${evidence.kind})`;
    }
    case 'policy.evaluated': {
      const { actionId, effect, matchedPolicyId } = event.payload;
      return matchedPolicyId !== undefined
        ? `policy ${matchedPolicyId} evaluated action ${actionId} -> ${effect}`
        : `policy evaluated action ${actionId} -> ${effect}`;
    }
    case 'budget.charged': {
      const { amount, scope } = event.payload;
      const target = scope.kind === 'global' ? 'global' : `${scope.kind} ${scope.value}`;
      return `charged ${amount.amountMinor} ${amount.currency} to ${target} budget`;
    }
    case 'budget.exceeded': {
      const { budgetId, attempted, limit } = event.payload;
      return `budget ${budgetId} exceeded: attempted ${attempted.amountMinor} ${attempted.currency} > limit ${limit.amountMinor} ${limit.currency}`;
    }
    case 'admin.action': {
      const { action, targetType, targetId, outcome } = event.payload;
      const target = targetId !== undefined ? `${targetType} ${targetId}` : targetType;
      return `admin ${action} on ${target} (${outcome})`;
    }
    case 'vendor.registered': {
      const { vendor } = event.payload;
      return `registered vendor ${vendor.id} (${vendor.name})`;
    }
    case 'vendor.signal': {
      const { signal } = event.payload;
      return `vendor signal for ${signal.vendorId} (${signal.kind})`;
    }
    case 'note': {
      const { text } = event.payload;
      return `note: ${text}`;
    }
  }
}
