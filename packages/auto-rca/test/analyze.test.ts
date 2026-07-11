import { describe, expect, it } from 'vitest';

import { analyzeIncident } from '../src/analyze.js';
import type { LlmAdapter } from '../src/adapter.js';

function mockAdapter(jsonText: string, modelId = 'claude-opus-4-7'): LlmAdapter {
  return {
    async call() {
      return { text: jsonText, modelId, usage: { inputTokens: 42, outputTokens: 17 } };
    },
  };
}

const wellFormed = JSON.stringify({
  headline: 'Repeated egress to non-allowlisted host',
  summary:
    'Agent agent-support attempted egress to api.unknown-vendor.io three times in 10 minutes, each blocked by an existing policy. The repeated attempts suggest a prompt-injection trigger upstream.',
  causalContributors: [
    'Upstream user message contained a URL the agent treated as authoritative.',
    'No tool-call confirmation step before initiating egress.',
  ],
  confidence: 0.72,
  proposedFix: {
    name: 'Require approval for non-allowlisted egress',
    description: 'Force human approval before any network.egress to hosts not on the allowlist.',
    effect: 'require_approval',
    match: { actionTypes: ['network.egress'] },
    priority: 200,
  },
  recommendations: [
    'Audit the agent’s system prompt for an instruction that biases toward URL trust.',
    'Add user-facing warning when a denied egress occurs more than twice in a session.',
  ],
});

describe('analyzeIncident', () => {
  it('parses a well-formed JSON response into an RcaReport', async () => {
    const report = await analyzeIncident({
      adapter: mockAdapter(wellFormed),
      forensics: { incidentId: 'inc-1' },
    });
    expect(report.headline).toMatch(/egress/);
    expect(report.confidence).toBeCloseTo(0.72);
    expect(report.proposedFix?.effect).toBe('require_approval');
    expect(report.proposedFix?.match.actionTypes).toEqual(['network.egress']);
    expect(report.metadata.modelId).toBe('claude-opus-4-7');
    expect(report.metadata.inputTokens).toBe(42);
  });

  it('strips ```json fences before parsing', async () => {
    const fenced = '```json\n' + wellFormed + '\n```';
    const report = await analyzeIncident({
      adapter: mockAdapter(fenced),
      forensics: {},
    });
    expect(report.headline).toMatch(/egress/);
  });

  it('throws rather than fabricate when JSON does not parse', async () => {
    await expect(
      analyzeIncident({
        adapter: mockAdapter('this is not json at all'),
        forensics: {},
      }),
    ).rejects.toThrow(/parseable JSON/);
  });

  it('drops a malformed proposedFix but keeps the rest of the report', async () => {
    const payload = JSON.stringify({
      headline: 'x',
      summary: 'y',
      confidence: 0.5,
      proposedFix: { effect: 'maybe' },
      recommendations: ['a'],
      causalContributors: ['b'],
    });
    const report = await analyzeIncident({
      adapter: mockAdapter(payload),
      forensics: {},
    });
    expect(report.proposedFix).toBeUndefined();
    expect(report.recommendations).toEqual(['a']);
  });

  it('clamps confidence to [0,1]', async () => {
    const payload = JSON.stringify({
      headline: 'x',
      summary: 'y',
      confidence: 99,
      causalContributors: [],
      recommendations: [],
    });
    const report = await analyzeIncident({
      adapter: mockAdapter(payload),
      forensics: {},
    });
    expect(report.confidence).toBe(1);
  });
});
