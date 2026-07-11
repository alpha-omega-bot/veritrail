import { VeritrailClient } from '@veritrail/sdk';
import { z } from 'zod';

import {
  TOOLS,
  errorResult,
  okResult,
  toolByName,
  type CheckPermissionInput,
  type McpToolResult,
  type NoteEvidenceInput,
  type QueryAuditInput,
  type RecordDecisionInput,
  type RequestBudgetInput,
  type VerifyIntegrityInput,
} from './tools.js';

export interface McpServerOptions {
  /** Veritrail backend base URL. Defaults to http://localhost:8787 or VERITRAIL_API env. */
  readonly baseUrl?: string;
  /** API key for the Veritrail backend. Read from VERITRAIL_API_KEY env if not given. */
  readonly apiKey?: string;
  /** Override fetch (for tests). */
  readonly fetchImpl?: typeof fetch;
  /** Default agent id reported when a tool call omits one (lets hosts auto-tag every call). */
  readonly defaultAgentId?: string;
}

/**
 * Build an MCP server. The result is a plain function map from tool name to a
 * validated call handler. The transport (stdio JSON-RPC, sse, etc.) is
 * separate so this stays unit-testable without spawning a subprocess.
 */
export function createMcpServer(options: McpServerOptions = {}) {
  const baseUrl = options.baseUrl ?? process.env['VERITRAIL_API'] ?? 'http://localhost:8787';
  const apiKey = options.apiKey ?? process.env['VERITRAIL_API_KEY'];
  const headers: Record<string, string> = apiKey ? { authorization: `Bearer ${apiKey}` } : {};
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const client = new VeritrailClient({
    baseUrl,
    headers,
    fetchImpl,
  });

  const defaultAgentId = options.defaultAgentId;

  const post = async (path: string, body: unknown): Promise<unknown> => {
    const result = await fetchImpl(`${baseUrl}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
    });
    return result.json();
  };

  async function callTool(name: string, rawArgs: unknown): Promise<McpToolResult> {
    const tool = toolByName(name);
    if (!tool) return errorResult(`unknown tool: ${name}`);
    const parsed = (tool.inputSchema as z.ZodTypeAny).safeParse(rawArgs ?? {});
    if (!parsed.success) {
      return errorResult('invalid arguments', parsed.error.flatten());
    }

    try {
      switch (name) {
        case 'veritrail.record_decision': {
          const args = parsed.data as z.infer<typeof RecordDecisionInput>;
          const agentId = args.agentId ?? defaultAgentId;
          const event = {
            type: 'decision.recorded',
            actor: { id: agentId, kind: 'agent' },
            payload: {
              decision: args.decision,
              rationale: args.rationale,
              evidenceIds: args.evidenceIds ?? [],
            },
            ...(args.correlationId !== undefined ? { correlationId: args.correlationId } : {}),
          };
          const result = await client.appendEvent(event);
          return okResult(result);
        }
        case 'veritrail.check_permission': {
          const args = parsed.data as z.infer<typeof CheckPermissionInput>;
          const payload = {
            actor: { id: args.agentId, kind: 'agent' },
            action: {
              type: args.actionType,
              ...(args.target !== undefined ? { target: args.target } : {}),
            },
          };
          const body = await post('/api/permissions/evaluate', payload);
          return okResult(body);
        }
        case 'veritrail.request_budget': {
          const args = parsed.data as z.infer<typeof RequestBudgetInput>;
          const payload = {
            actorId: args.agentId,
            amount: { currency: 'USD', minorUnits: args.amountUsdMinor },
            ...(args.scope !== undefined ? { scope: args.scope } : {}),
            ...(args.actionId !== undefined ? { actionId: args.actionId } : {}),
          };
          const body = await post('/api/spend/authorize', payload);
          return okResult(body);
        }
        case 'veritrail.note_evidence': {
          const args = parsed.data as z.infer<typeof NoteEvidenceInput>;
          const event = {
            type: 'evidence.noted',
            payload: {
              label: args.label,
              content: args.content,
              ...(args.sourceUri !== undefined ? { sourceUri: args.sourceUri } : {}),
            },
            ...(args.correlationId !== undefined ? { correlationId: args.correlationId } : {}),
          };
          const result = await client.appendEvent(event);
          return okResult(result);
        }
        case 'veritrail.query_audit': {
          const args = parsed.data as z.infer<typeof QueryAuditInput>;
          const query: Record<string, string | number> = {};
          if (args.correlationId !== undefined) query['correlationId'] = args.correlationId;
          if (args.agentId !== undefined) query['actorId'] = args.agentId;
          if (args.type !== undefined) query['type'] = args.type;
          if (args.limit !== undefined) query['limit'] = args.limit;
          const result = await client.getEvents(query);
          return okResult(result);
        }
        case 'veritrail.verify_integrity': {
          // parsed.data: empty object (verified)
          void (parsed.data as z.infer<typeof VerifyIntegrityInput>);
          const result = await client.verifyIntegrity();
          return okResult(result);
        }
        default:
          return errorResult(`unhandled tool: ${name}`);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'unknown error';
      return errorResult('tool call failed', message);
    }
  }

  function listTools() {
    return TOOLS.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: zodToJsonSchema(t.inputSchema),
    }));
  }

  return { callTool, listTools, baseUrl };
}

/**
 * Minimal Zod → JSON Schema converter for the MCP `tools/list` response.
 * We deliberately avoid a runtime dependency: the schemas used by these tools
 * are simple objects with primitive fields, optional flags, and array fields.
 * Anything more complex is a smell — push the structure to the tool argument
 * naming, not into nested schemas.
 */
function zodToJsonSchema(schema: z.ZodTypeAny): unknown {
  if (schema instanceof z.ZodObject) {
    const shape = schema.shape as Record<string, z.ZodTypeAny>;
    const properties: Record<string, unknown> = {};
    const required: string[] = [];
    for (const [key, field] of Object.entries(shape)) {
      const isOptional = field instanceof z.ZodOptional;
      const inner = isOptional ? (field as z.ZodOptional<z.ZodTypeAny>).unwrap() : field;
      properties[key] = zodFieldToJsonSchema(inner);
      if (!isOptional) required.push(key);
    }
    return {
      type: 'object',
      properties,
      ...(required.length > 0 ? { required } : {}),
      additionalProperties: false,
    };
  }
  return zodFieldToJsonSchema(schema);
}

function zodFieldToJsonSchema(schema: z.ZodTypeAny): unknown {
  const description =
    typeof (schema as { description?: unknown }).description === 'string'
      ? (schema as { description: string }).description
      : undefined;
  const withDesc = (obj: Record<string, unknown>): Record<string, unknown> =>
    description !== undefined ? { ...obj, description } : obj;

  if (schema instanceof z.ZodString) return withDesc({ type: 'string' });
  if (schema instanceof z.ZodNumber) {
    const isInt = (
      schema as unknown as { _def?: { checks?: { kind: string }[] } }
    )._def?.checks?.some((c) => c.kind === 'int');
    return withDesc({ type: isInt ? 'integer' : 'number' });
  }
  if (schema instanceof z.ZodBoolean) return withDesc({ type: 'boolean' });
  if (schema instanceof z.ZodArray) {
    return withDesc({
      type: 'array',
      items: zodFieldToJsonSchema(schema._def.type as z.ZodTypeAny),
    });
  }
  if (schema instanceof z.ZodOptional) {
    return zodFieldToJsonSchema(schema.unwrap() as z.ZodTypeAny);
  }
  if (schema instanceof z.ZodObject) {
    return zodToJsonSchema(schema);
  }
  return withDesc({});
}
