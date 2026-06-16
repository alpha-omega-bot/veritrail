import { describe, expect, it } from 'vitest';

import { money } from '@veritrail/core';

import { summarize } from '../src/index.js';

describe('summarize budget.charged', () => {
  it('renders the scope readably (no "[object Object]")', () => {
    const actorScope = summarize({
      type: 'budget.charged',
      actorId: 'agent-1',
      labels: {},
      payload: { scope: { kind: 'actor', value: 'agent-1' }, amount: money(120) },
    });
    expect(actorScope).toContain('actor agent-1');
    expect(actorScope).not.toContain('[object Object]');

    const globalScope = summarize({
      type: 'budget.charged',
      actorId: 'agent-1',
      labels: {},
      payload: { scope: { kind: 'global', value: '' }, amount: money(50) },
    });
    expect(globalScope).toContain('global');
    expect(globalScope).not.toContain('[object Object]');
  });
});
