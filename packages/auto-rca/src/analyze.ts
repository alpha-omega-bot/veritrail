import type { LlmAdapter, LlmRequest } from './adapter.js';

/**
 * Structured RCA report. Strict-shaped so the console can render it without
 * massaging, and so the proposed-policy field can feed into the simulator.
 */
export interface RcaReport {
  /** One-line executive headline. */
  readonly headline: string;
  /** 2-3 sentence summary suitable for an incident channel. */
  readonly summary: string;
  /** Specific actions or omissions identified as causal contributors. */
  readonly causalContributors: ReadonlyArray<string>;
  /** The model's confidence, 0..1. Anything <0.5 should be treated as advisory. */
  readonly confidence: number;
  /** Recommended preventive fix, formatted as a Veritrail Policy candidate. */
  readonly proposedFix?: ProposedFix;
  /** Other operational follow-ups that don't fit a policy. */
  readonly recommendations: ReadonlyArray<string>;
  /** Provenance metadata for auditability. */
  readonly metadata: {
    readonly modelId: string;
    readonly generatedAt: string;
    readonly inputTokens?: number;
    readonly outputTokens?: number;
  };
}

/**
 * A policy proposal an operator can click "Simulate" on. The shape matches
 * @veritrail/core's Policy but with `id` optional and timestamps omitted so
 * the simulator can mint them.
 */
export interface ProposedFix {
  readonly name: string;
  readonly description: string;
  readonly effect: 'allow' | 'deny' | 'require_approval';
  readonly match: {
    readonly actorKinds?: ReadonlyArray<string>;
    readonly actorIds?: ReadonlyArray<string>;
    readonly actionTypes?: ReadonlyArray<string>;
    readonly targets?: ReadonlyArray<string>;
  };
  readonly priority: number;
}

export interface AnalyzeIncidentOptions {
  readonly adapter: LlmAdapter;
  /**
   * Structured forensics payload — usually an `IncidentReport` plus
   * `BlastRadiusReport` and ranked `RootCauseCandidate[]` from
   * `@veritrail/forensics`. We accept `unknown` so the package doesn't take
   * a hard dependency on the forensics module shape; the prompt names the
   * expected fields explicitly.
   */
  readonly forensics: unknown;
  /** Optional extra context (free text the operator types in). */
  readonly operatorContext?: string;
  /** Cap output length. */
  readonly maxOutputTokens?: number;
}

const SYSTEM_PROMPT = `You are an AI safety incident analyst for Veritrail, the tamper-evident governance ledger for AI agents.

You are given a JSON forensics payload (timeline, causal chain, blast-radius report, and ranked root-cause candidates). Produce a strict JSON object of shape RcaReport-v1:

{
  "headline": string,                       // one short sentence
  "summary": string,                        // 2-3 sentences for an incident channel
  "causalContributors": string[],            // each entry one sentence
  "confidence": number,                     // 0..1; reflect uncertainty truthfully
  "proposedFix": {                          // optional; omit if no policy would help
    "name": string,
    "description": string,
    "effect": "allow" | "deny" | "require_approval",
    "match": { "actorKinds"?: string[], "actorIds"?: string[], "actionTypes"?: string[], "targets"?: string[] },
    "priority": number                      // 0..1000
  },
  "recommendations": string[]                // non-policy follow-ups
}

Rules:
- Output VALID JSON only. No prose, no code fences, no commentary.
- Do not fabricate event ids, agent ids, or policy ids that aren't in the payload.
- Be conservative: if the data is thin, lower confidence and prefer "require_approval" to "deny".
- "proposedFix.match.actionTypes" supports a trailing "*" wildcard (e.g. "tool.*").`;

export async function analyzeIncident(options: AnalyzeIncidentOptions): Promise<RcaReport> {
  const userPrompt = [
    'INCIDENT FORENSICS PAYLOAD:',
    '```json',
    JSON.stringify(options.forensics, null, 2),
    '```',
    options.operatorContext
      ? `OPERATOR CONTEXT:\n${options.operatorContext}`
      : 'OPERATOR CONTEXT: (none)',
    '',
    'Return RcaReport-v1 JSON now.',
  ].join('\n');

  const request: LlmRequest = {
    system: SYSTEM_PROMPT,
    user: userPrompt,
    responseSchemaHint: 'rca-report-v1',
    ...(options.maxOutputTokens !== undefined ? { maxOutputTokens: options.maxOutputTokens } : {}),
  };

  const response = await options.adapter.call(request);
  const parsed = safeParseJson(response.text);
  if (!parsed) {
    throw new Error('LLM did not return parseable JSON; refusing to fabricate an RCA');
  }

  return shapeReport(parsed, response);
}

function safeParseJson(text: string): unknown {
  // Strip the most common LLM fenced-output mistakes before parsing. We do
  // NOT silently coerce — if the JSON is malformed, return null.
  let candidate = text.trim();
  const fenceMatch = candidate.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  if (fenceMatch?.[1]) candidate = fenceMatch[1].trim();
  try {
    return JSON.parse(candidate);
  } catch {
    return null;
  }
}

function shapeReport(
  parsed: unknown,
  response: { modelId: string; usage?: { inputTokens?: number; outputTokens?: number } },
): RcaReport {
  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error('RCA payload is not an object');
  }
  const p = parsed as Record<string, unknown>;
  const headline = typeof p['headline'] === 'string' ? p['headline'] : '(no headline)';
  const summary = typeof p['summary'] === 'string' ? p['summary'] : '';
  const confidence = typeof p['confidence'] === 'number' ? clamp01(p['confidence']) : 0.5;
  const causalContributors = Array.isArray(p['causalContributors'])
    ? p['causalContributors'].filter((x): x is string => typeof x === 'string')
    : [];
  const recommendations = Array.isArray(p['recommendations'])
    ? p['recommendations'].filter((x): x is string => typeof x === 'string')
    : [];
  const proposedFix = shapeProposedFix(p['proposedFix']);

  return {
    headline,
    summary,
    causalContributors,
    confidence,
    ...(proposedFix !== undefined ? { proposedFix } : {}),
    recommendations,
    metadata: {
      modelId: response.modelId,
      generatedAt: new Date().toISOString(),
      ...(response.usage?.inputTokens !== undefined
        ? { inputTokens: response.usage.inputTokens }
        : {}),
      ...(response.usage?.outputTokens !== undefined
        ? { outputTokens: response.usage.outputTokens }
        : {}),
    },
  };
}

function shapeProposedFix(input: unknown): ProposedFix | undefined {
  if (typeof input !== 'object' || input === null) return undefined;
  const f = input as Record<string, unknown>;
  const effect = f['effect'];
  if (effect !== 'allow' && effect !== 'deny' && effect !== 'require_approval') return undefined;
  const name = typeof f['name'] === 'string' ? f['name'] : '';
  const description = typeof f['description'] === 'string' ? f['description'] : '';
  const priority = typeof f['priority'] === 'number' ? Math.round(f['priority']) : 0;
  const matchRaw = (f['match'] ?? {}) as Record<string, unknown>;
  const match = {
    ...(Array.isArray(matchRaw['actorKinds'])
      ? {
          actorKinds: (matchRaw['actorKinds'] as unknown[]).filter(
            (x): x is string => typeof x === 'string',
          ),
        }
      : {}),
    ...(Array.isArray(matchRaw['actorIds'])
      ? {
          actorIds: (matchRaw['actorIds'] as unknown[]).filter(
            (x): x is string => typeof x === 'string',
          ),
        }
      : {}),
    ...(Array.isArray(matchRaw['actionTypes'])
      ? {
          actionTypes: (matchRaw['actionTypes'] as unknown[]).filter(
            (x): x is string => typeof x === 'string',
          ),
        }
      : {}),
    ...(Array.isArray(matchRaw['targets'])
      ? {
          targets: (matchRaw['targets'] as unknown[]).filter(
            (x): x is string => typeof x === 'string',
          ),
        }
      : {}),
  };
  return { name, description, effect, match, priority };
}

function clamp01(n: number): number {
  if (Number.isNaN(n)) return 0.5;
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}
