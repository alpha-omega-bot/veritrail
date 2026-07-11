import { describe, expect, it } from 'vitest';

import { createInMemoryLedger, FixedClock } from '@veritrail/core';

import {
  collectEvidence,
  compliancePercent,
  FRAMEWORK_IDS,
  FRAMEWORK_TEMPLATES,
  getFramework,
  renderMarkdown,
  requireFramework,
  type EvidenceWindow,
  type Framework,
} from '../src/index.js';

const WINDOW: EvidenceWindow = { fromMs: 1_000, toMs: 10_000 };

describe('FRAMEWORK_TEMPLATES', () => {
  it('exposes well-formed templates for all four built-in frameworks', () => {
    expect(FRAMEWORK_IDS).toEqual([
      'soc2-cc7',
      'eu-ai-act-annex-iv',
      'hipaa-security',
      'iso-42001',
    ]);
    for (const id of FRAMEWORK_IDS) {
      const framework = FRAMEWORK_TEMPLATES[id];
      expect(framework.id).toBe(id);
      expect(framework.name.length).toBeGreaterThan(0);
      expect(framework.version.length).toBeGreaterThan(0);
      expect(framework.controls.length).toBeGreaterThanOrEqual(3);
      for (const control of framework.controls) {
        expect(control.id).toMatch(/^[A-Za-z0-9.\-_]+$/);
        expect(control.name.length).toBeGreaterThan(0);
        expect(control.description.length).toBeGreaterThan(0);
        expect(control.requiredEventTypes.length).toBeGreaterThan(0);
        expect(['must', 'should']).toContain(control.severity);
      }
    }
    expect(getFramework('does-not-exist')).toBeNull();
    expect(() => requireFramework('does-not-exist')).toThrow(/unknown framework/);
  });
});

describe('collectEvidence — empty ledger', () => {
  it('marks every control unsatisfied when the ledger has no matching events', async () => {
    const ledger = createInMemoryLedger();
    const evidence = await collectEvidence(ledger, 'soc2-cc7', WINDOW);
    expect(evidence.length).toBe(FRAMEWORK_TEMPLATES['soc2-cc7'].controls.length);
    for (const item of evidence) {
      expect(item.satisfied).toBe(false);
      expect(item.evidenceCount).toBe(0);
      expect(item.evidenceEventIds).toEqual([]);
      expect(item.missingEventTypes).toEqual(item.control.requiredEventTypes);
    }
  });

  it('handles a framework whose ledger has zero events without throwing', async () => {
    const ledger = createInMemoryLedger();
    const evidence = await collectEvidence(ledger, 'iso-42001', WINDOW);
    expect(evidence.every((item) => !item.satisfied)).toBe(true);
    expect(compliancePercent(evidence)).toBe(0);
  });
});

describe('collectEvidence — populated ledger', () => {
  it('finds matching events for the controls whose required types are present', async () => {
    const clock = new FixedClock(5_000);
    const ledger = createInMemoryLedger({ clock });

    const proposed = await ledger.append({
      type: 'action.proposed',
      actorId: 'actor-1',
      payload: {
        action: {
          id: 'act-1',
          actorId: 'actor-1',
          type: 'network.egress',
          target: 'example.com',
        },
      },
    });
    expect(proposed.ok).toBe(true);

    await ledger.append({
      type: 'action.executed',
      actorId: 'actor-1',
      payload: { actionId: 'act-1', outcome: 'success' },
    });
    await ledger.append({
      type: 'action.failed',
      actorId: 'actor-1',
      payload: { actionId: 'act-1', error: 'simulated failure' },
    });

    const evidence = await collectEvidence(ledger, 'soc2-cc7', WINDOW);
    const cc72 = evidence.find((item) => item.control.id === 'SOC2.CC7.2');
    expect(cc72).toBeDefined();
    expect(cc72?.satisfied).toBe(true);
    expect(cc72?.evidenceCount).toBeGreaterThanOrEqual(2);
    expect(cc72?.missingEventTypes).toEqual([]);

    const cc71 = evidence.find((item) => item.control.id === 'SOC2.CC7.1');
    expect(cc71?.satisfied).toBe(false);
  });

  it('respects the report window — events outside it are excluded', async () => {
    const clock = new FixedClock(500);
    const ledger = createInMemoryLedger({ clock });

    await ledger.append({
      type: 'action.executed',
      actorId: 'actor-1',
      payload: { actionId: 'act-outside', outcome: 'success' },
    });
    clock.set(20_000);
    await ledger.append({
      type: 'action.executed',
      actorId: 'actor-1',
      payload: { actionId: 'act-also-outside', outcome: 'success' },
    });
    clock.set(5_000);
    await ledger.append({
      type: 'action.executed',
      actorId: 'actor-1',
      payload: { actionId: 'act-inside', outcome: 'success' },
    });

    const evidence = await collectEvidence(ledger, 'soc2-cc7', WINDOW);
    const cc72 = evidence.find((item) => item.control.id === 'SOC2.CC7.2');
    expect(cc72?.evidenceCount).toBe(1);
  });
});

describe('renderMarkdown', () => {
  it('contains framework name, period, every control id, and a gaps section', async () => {
    const ledger = createInMemoryLedger();
    const framework = FRAMEWORK_TEMPLATES['hipaa-security'];
    const evidence = await collectEvidence(ledger, framework.id, WINDOW);
    const markdown = renderMarkdown(framework, evidence, {
      window: WINDOW,
      generatedAtMs: 12_345,
      entity: 'Acme Corp',
    });

    expect(markdown).toContain(framework.name);
    expect(markdown).toContain(new Date(WINDOW.fromMs).toISOString());
    expect(markdown).toContain(new Date(WINDOW.toMs).toISOString());
    expect(markdown).toContain('Acme Corp');
    expect(markdown).toContain('## Gaps');
    for (const control of framework.controls) {
      expect(markdown).toContain(control.id);
    }
  });

  it("distinguishes 'must' from 'should' controls in the rendered output", async () => {
    const framework: Framework = {
      id: 'demo',
      name: 'Demo Framework',
      version: 'v0',
      controls: [
        {
          id: 'DEMO.A.1',
          name: 'Required control',
          description: 'A must-have control with no satisfying evidence.',
          requiredEventTypes: ['action.executed'],
          severity: 'must',
        },
        {
          id: 'DEMO.B.1',
          name: 'Recommended control',
          description: 'A should-have control with no satisfying evidence.',
          requiredEventTypes: ['evidence.attached'],
          severity: 'should',
        },
      ],
    };
    const ledger = createInMemoryLedger();
    const evidence = await collectEvidence(ledger, framework, WINDOW);
    const markdown = renderMarkdown(framework, evidence, { window: WINDOW, generatedAtMs: 0 });
    expect(markdown).toContain('GAP (must)');
    expect(markdown).toContain('GAP (should)');
    expect(markdown).toContain('| must |');
    expect(markdown).toContain('| should |');
  });
});

describe('compliancePercent', () => {
  it('returns 100 for an empty evidence batch', () => {
    expect(compliancePercent([])).toBe(100);
  });

  it('returns a 0..100 integer that weighs must heavier than should', async () => {
    const clock = new FixedClock(5_000);
    const ledger = createInMemoryLedger({ clock });
    await ledger.append({
      type: 'note',
      actorId: 'actor-1',
      payload: { text: 'unrelated' },
    });
    const evidence = await collectEvidence(ledger, 'iso-42001', WINDOW);
    const score = compliancePercent(evidence);
    expect(Number.isInteger(score)).toBe(true);
    expect(score).toBeGreaterThanOrEqual(0);
    expect(score).toBeLessThanOrEqual(100);
    expect(score).toBe(0);

    const framework: Framework = {
      id: 'mix',
      name: 'mix',
      version: 'v0',
      controls: [
        {
          id: 'MIX.A',
          name: 'a',
          description: 'a',
          requiredEventTypes: ['note'],
          severity: 'must',
        },
        {
          id: 'MIX.B',
          name: 'b',
          description: 'b',
          requiredEventTypes: ['evidence.attached'],
          severity: 'should',
        },
      ],
    };
    const mixEvidence = await collectEvidence(ledger, framework, WINDOW);
    expect(mixEvidence.find((item) => item.control.id === 'MIX.A')?.satisfied).toBe(true);
    expect(mixEvidence.find((item) => item.control.id === 'MIX.B')?.satisfied).toBe(false);
    expect(compliancePercent(mixEvidence)).toBe(75);
  });
});
