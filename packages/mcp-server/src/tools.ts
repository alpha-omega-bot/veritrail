import { z } from 'zod';

/**
 * Each MCP tool is a typed JSON-RPC method the host can invoke. Schemas are
 * Zod so we can both validate inputs and emit a JSON Schema for the MCP
 * handshake. Outputs are always `{ content: [{ type: 'text', text }] }` per
 * the MCP spec; we serialize structured data as JSON inside the text payload
 * so hosts can show it raw and parse it.
 */

export interface McpToolResult {
  readonly content: ReadonlyArray<{ type: 'text'; text: string }>;
  readonly isError?: boolean;
}

export interface McpTool {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: z.ZodTypeAny;
}

export const RecordDecisionInput = z
  .object({
    agentId: z.string().min(1).describe('Identifier of the agent making the decision.'),
    decision: z.string().min(1).describe('Short label for the decision, e.g. "chose-search-tool".'),
    rationale: z
      .string()
      .min(1)
      .describe('Free-form reasoning the agent recorded for this decision.'),
    correlationId: z
      .string()
      .optional()
      .describe('Optional correlation id linking this decision to a wider incident or workflow.'),
    evidenceIds: z
      .array(z.string())
      .optional()
      .describe('Identifiers of supporting evidence records previously stored.'),
  })
  .strict();

export const CheckPermissionInput = z
  .object({
    agentId: z.string().min(1),
    actionType: z
      .string()
      .min(1)
      .describe('Dotted action type, e.g. "tool.search.web" or "network.egress".'),
    target: z.string().optional().describe('Resource the action affects, e.g. a URL or file path.'),
  })
  .strict();

export const RequestBudgetInput = z
  .object({
    agentId: z.string().min(1),
    amountUsdMinor: z
      .number()
      .int()
      .positive()
      .describe(
        'Cost in integer minor USD units (cents). Floats are rejected to avoid rounding drift.',
      ),
    scope: z
      .string()
      .optional()
      .describe('Budget scope (project, team, agent). Defaults to the agent id.'),
    actionId: z.string().optional(),
  })
  .strict();

export const NoteEvidenceInput = z
  .object({
    label: z.string().min(1).describe('Short human-readable label for this evidence.'),
    content: z
      .string()
      .min(1)
      .describe(
        'The evidence body. The server hashes the content and stores the hash in the tamper-evident ledger.',
      ),
    sourceUri: z.string().optional().describe('URI of the original source if any.'),
    correlationId: z.string().optional(),
  })
  .strict();

export const QueryAuditInput = z
  .object({
    correlationId: z.string().optional(),
    agentId: z.string().optional(),
    type: z.string().optional(),
    limit: z.number().int().positive().max(500).optional(),
  })
  .strict();

export const VerifyIntegrityInput = z.object({}).strict();

export const TOOLS: ReadonlyArray<McpTool> = [
  {
    name: 'veritrail.record_decision',
    description:
      'Record an agent decision (with rationale) on the tamper-evident Veritrail ledger. Use whenever the agent picks one option over another so the choice is auditable later.',
    inputSchema: RecordDecisionInput,
  },
  {
    name: 'veritrail.check_permission',
    description:
      'Ask Veritrail whether the agent is allowed to perform an action. Returns allow/deny + the matched policy id. Call BEFORE side-effects (network egress, writes, spending).',
    inputSchema: CheckPermissionInput,
  },
  {
    name: 'veritrail.request_budget',
    description:
      'Reserve spend against the agent or project budget. Returns a hard deny if the budget is exhausted. Always call BEFORE making a paid API call so cost is bounded.',
    inputSchema: RequestBudgetInput,
  },
  {
    name: 'veritrail.note_evidence',
    description:
      'Record a piece of evidence the agent used (web page contents, user message, source document). The content is hashed and chained into the ledger so its provenance can be proven later.',
    inputSchema: NoteEvidenceInput,
  },
  {
    name: 'veritrail.query_audit',
    description:
      'Query the audit ledger for past events filtered by correlation id, agent, or event type. Use when investigating a previous action or building context.',
    inputSchema: QueryAuditInput,
  },
  {
    name: 'veritrail.verify_integrity',
    description:
      'Verify the ledger has not been tampered with. Returns the head hash and a boolean. Run when you need to prove a chain of events to a user or auditor.',
    inputSchema: VerifyIntegrityInput,
  },
];

export function toolByName(name: string): McpTool | undefined {
  return TOOLS.find((t) => t.name === name);
}

export function okResult(value: unknown): McpToolResult {
  return {
    content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) }],
  };
}

export function errorResult(message: string, detail?: unknown): McpToolResult {
  const text = detail === undefined ? message : `${message}: ${JSON.stringify(detail)}`;
  return { content: [{ type: 'text', text }], isError: true };
}
