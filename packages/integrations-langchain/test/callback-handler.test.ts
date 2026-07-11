import { describe, expect, it } from 'vitest';

import { VeritrailClient } from '@veritrail/sdk';

import { VeritrailCallbackHandler } from '../src/index.js';

interface CapturedRequest {
  readonly url: string;
  readonly method: string;
  readonly body: unknown;
}

function recorder(): { client: VeritrailClient; calls: CapturedRequest[] } {
  const calls: CapturedRequest[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const bodyText = typeof init?.body === 'string' ? init.body : '';
    const parsed = bodyText ? (JSON.parse(bodyText) as unknown) : undefined;
    calls.push({
      url: String(input),
      method: init?.method ?? 'GET',
      body: parsed,
    });
    return new Response(JSON.stringify({ record: { seq: calls.length } }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };
  const client = new VeritrailClient({ baseUrl: 'http://test.local', fetchImpl });
  return { client, calls };
}

describe('VeritrailCallbackHandler', () => {
  it('handleLLMStart posts a note event to /api/events with the agentId as actorId', async () => {
    const { client, calls } = recorder();
    const handler = new VeritrailCallbackHandler({ client, agentId: 'agent-7' });

    await handler.handleLLMStart({ name: 'gpt-4o-mini' }, ['What is 2 + 2?']);

    expect(calls).toHaveLength(1);
    const call = calls[0]!;
    expect(call.url).toBe('http://test.local/api/events');
    expect(call.method).toBe('POST');
    const body = call.body as {
      type: string;
      actorId: string;
      payload: { text: string; data: { model: string; prompt_summary: string } };
    };
    expect(body.type).toBe('note');
    expect(body.actorId).toBe('agent-7');
    expect(body.payload.text).toBe('llm-start');
    expect(body.payload.data.model).toBe('gpt-4o-mini');
    expect(body.payload.data.prompt_summary).toContain('2 + 2');
  });

  it('propagates correlationId on every emitted event', async () => {
    const { client, calls } = recorder();
    const handler = new VeritrailCallbackHandler({
      client,
      agentId: 'agent-9',
      correlationId: 'corr-abc',
    });

    await handler.handleLLMStart({ name: 'claude' }, ['hello']);
    await handler.handleChainStart({ name: 'plan' });
    await handler.handleChainEnd(undefined, { name: 'plan' });

    expect(calls).toHaveLength(3);
    for (const call of calls) {
      const body = call.body as { correlationId?: string; actorId: string };
      expect(body.correlationId).toBe('corr-abc');
      expect(body.actorId).toBe('agent-9');
    }
  });

  it('omits correlationId when not provided', async () => {
    const { client, calls } = recorder();
    const handler = new VeritrailCallbackHandler({ client, agentId: 'agent-1' });

    await handler.handleChainStart({ name: 'root' });

    const body = calls[0]!.body as Record<string, unknown>;
    expect('correlationId' in body).toBe(false);
    expect(body.actorId).toBe('agent-1');
  });

  it('handleToolStart proposes an action with type tool.invoke and a unique actionId per call', async () => {
    const { client, calls } = recorder();
    const handler = new VeritrailCallbackHandler({ client, agentId: 'agent-3' });

    await handler.handleToolStart({ name: 'search' }, '{"q":"news"}', 'run-1');
    await handler.handleToolStart({ name: 'search' }, '{"q":"weather"}', 'run-2');

    const seen = new Set<string>();
    for (const call of calls) {
      const body = call.body as {
        type: string;
        payload: { action: { id: string; type: string; target: string; actorId: string } };
      };
      expect(body.type).toBe('action.proposed');
      expect(body.payload.action.type).toBe('tool.invoke');
      expect(body.payload.action.target).toBe('search');
      expect(body.payload.action.actorId).toBe('agent-3');
      seen.add(body.payload.action.id);
    }
    expect(seen.size).toBe(2);
  });

  it('handleToolEnd records action.executed referencing the matching tool-start action id', async () => {
    const { client, calls } = recorder();
    const handler = new VeritrailCallbackHandler({ client, agentId: 'agent-5' });

    await handler.handleToolStart({ name: 'search' }, '{}', 'run-x');
    const start = calls[0]!.body as { payload: { action: { id: string } } };
    const startedActionId = start.payload.action.id;

    await handler.handleToolEnd('results', 'run-x');

    expect(calls).toHaveLength(2);
    const end = calls[1]!.body as {
      type: string;
      payload: { actionId: string; result: string };
    };
    expect(end.type).toBe('action.executed');
    expect(end.payload.actionId).toBe(startedActionId);
    expect(end.payload.result).toBe('ok');
  });

  it('handleToolEnd marks result as error when error flag is set', async () => {
    const { client, calls } = recorder();
    const handler = new VeritrailCallbackHandler({ client, agentId: 'agent-err' });

    await handler.handleToolStart({ name: 'flaky' }, '{}', 'run-e');
    await handler.handleToolEnd('boom', 'run-e', { error: true });

    const end = calls[1]!.body as { payload: { result: string } };
    expect(end.payload.result).toBe('error');
  });

  it('handleChainStart and handleChainEnd round-trip as note events with the chain name', async () => {
    const { client, calls } = recorder();
    const handler = new VeritrailCallbackHandler({ client, agentId: 'agent-c' });

    await handler.handleChainStart({ name: 'router' });
    await handler.handleChainEnd({ ok: true }, { name: 'router' });

    expect(calls).toHaveLength(2);
    const start = calls[0]!.body as {
      type: string;
      payload: { text: string; data: { name: string } };
    };
    const end = calls[1]!.body as {
      type: string;
      payload: { text: string; data: { name: string } };
    };
    expect(start.type).toBe('note');
    expect(start.payload.text).toBe('chain-start');
    expect(start.payload.data.name).toBe('router');
    expect(end.type).toBe('note');
    expect(end.payload.text).toBe('chain-end');
    expect(end.payload.data.name).toBe('router');
  });

  it('handleLLMEnd posts an llm-end note with model, latency_ms, and tokens', async () => {
    const { client, calls } = recorder();
    const handler = new VeritrailCallbackHandler({ client, agentId: 'agent-llm' });

    const startedAt = Date.now() - 25;
    await handler.handleLLMEnd(
      { llmOutput: { tokenUsage: { promptTokens: 10, completionTokens: 5 } } },
      'run-llm',
      { model: 'gpt-4', startedAt },
    );

    const body = calls[0]!.body as {
      type: string;
      payload: {
        text: string;
        data: { model: string; latency_ms: number; tokens: Record<string, number> };
      };
    };
    expect(body.type).toBe('note');
    expect(body.payload.text).toBe('llm-end');
    expect(body.payload.data.model).toBe('gpt-4');
    expect(body.payload.data.latency_ms).toBeGreaterThanOrEqual(0);
    expect(body.payload.data.tokens.promptTokens).toBe(10);
  });
});
