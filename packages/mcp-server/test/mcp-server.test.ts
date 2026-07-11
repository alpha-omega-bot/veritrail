import { describe, expect, it } from 'vitest';

import { createMcpServer } from '../src/server.js';
import { TOOLS } from '../src/tools.js';

/**
 * Build a fetch impl that records every call and returns a canned response.
 * This keeps the tests hermetic — no Veritrail server required.
 */
function recordingFetch(response: unknown, status = 200) {
  const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
  const impl: typeof fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : '';
    calls.push({ url, init });
    return new Response(JSON.stringify(response), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  };
  return { impl, calls };
}

describe('MCP server', () => {
  it('lists exactly the documented tools with JSON Schemas', () => {
    const server = createMcpServer({ fetchImpl: recordingFetch({}).impl });
    const tools = server.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      'veritrail.check_permission',
      'veritrail.note_evidence',
      'veritrail.query_audit',
      'veritrail.record_decision',
      'veritrail.request_budget',
      'veritrail.verify_integrity',
    ]);
    expect(tools).toHaveLength(TOOLS.length);
    for (const tool of tools) {
      expect(tool.description).toBeTruthy();
      expect((tool.inputSchema as { type?: string }).type).toBe('object');
    }
  });

  it('rejects unknown tool names', async () => {
    const server = createMcpServer({ fetchImpl: recordingFetch({}).impl });
    const result = await server.callTool('veritrail.nope', {});
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toMatch(/unknown tool/);
  });

  it('validates input arguments and surfaces a Zod error', async () => {
    const server = createMcpServer({ fetchImpl: recordingFetch({}).impl });
    const result = await server.callTool('veritrail.record_decision', { decision: 'x' });
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toMatch(/invalid arguments/);
  });

  it('record_decision forwards an event to the SDK', async () => {
    const { impl, calls } = recordingFetch({ record: { seq: 1, hash: 'abc' } }, 201);
    const server = createMcpServer({ fetchImpl: impl });
    const result = await server.callTool('veritrail.record_decision', {
      agentId: 'agent-1',
      decision: 'use-cached-result',
      rationale: 'faster and equivalent',
      correlationId: 'corr-1',
    });
    expect(result.isError).toBeFalsy();
    expect(calls).toHaveLength(1);
    const call = calls[0]!;
    expect(call.url).toContain('/api/events');
    expect(call.init?.method).toBe('POST');
    const body = JSON.parse(call.init?.body as string);
    expect(body.type).toBe('decision.recorded');
    expect(body.actor).toEqual({ id: 'agent-1', kind: 'agent' });
    expect(body.correlationId).toBe('corr-1');
  });

  it('request_budget posts a Money payload to /api/spend/authorize', async () => {
    const { impl, calls } = recordingFetch({ allowed: true });
    const server = createMcpServer({ fetchImpl: impl });
    await server.callTool('veritrail.request_budget', {
      agentId: 'agent-1',
      amountUsdMinor: 250,
      scope: 'project-x',
    });
    const body = JSON.parse(calls[0]!.init?.body as string);
    expect(body.actorId).toBe('agent-1');
    expect(body.amount).toEqual({ currency: 'USD', minorUnits: 250 });
    expect(body.scope).toBe('project-x');
  });

  it('check_permission omits target when not given', async () => {
    const { impl, calls } = recordingFetch({ effect: 'allow' });
    const server = createMcpServer({ fetchImpl: impl });
    await server.callTool('veritrail.check_permission', {
      agentId: 'agent-1',
      actionType: 'tool.search',
    });
    const body = JSON.parse(calls[0]!.init?.body as string);
    expect(body.action.type).toBe('tool.search');
    expect(body.action.target).toBeUndefined();
  });

  it('attaches Authorization header when apiKey is given', async () => {
    const { impl, calls } = recordingFetch({ ok: true });
    const server = createMcpServer({ apiKey: 'vt_test_abc', fetchImpl: impl });
    await server.callTool('veritrail.check_permission', {
      agentId: 'a',
      actionType: 'tool.x',
    });
    const headers = (calls[0]!.init?.headers ?? {}) as Record<string, string>;
    expect(headers['authorization']).toBe('Bearer vt_test_abc');
  });

  it('passes optional query filters to query_audit', async () => {
    const { impl, calls } = recordingFetch([]);
    const server = createMcpServer({ fetchImpl: impl });
    await server.callTool('veritrail.query_audit', {
      correlationId: 'corr-7',
      limit: 25,
    });
    expect(calls[0]!.url).toContain('correlationId=corr-7');
    expect(calls[0]!.url).toContain('limit=25');
  });
});
