/**
 * @veritrail/auto-rca
 *
 * AI-driven Root Cause Analysis for incidents recorded on the Veritrail
 * ledger. Reads the existing GA forensics output (timeline, causal chain,
 * blast radius, ranked candidates) and asks an LLM to produce a structured,
 * plain-English RCA *plus* a proposed Veritrail policy that would have
 * prevented the incident.
 *
 * The proposed policy is shaped so it can be piped directly into the
 * `@veritrail/policy-simulator` to verify, *against real history*, that it
 * would not unintentionally break other workflows.
 *
 * LLM provider is pluggable — the default adapter targets Anthropic's Claude
 * API. Per the current Claude API knowledge cutoff (see system prompt /
 * `/claude-api` skill), the recommended model id for the deepest analysis on
 * long incident traces is **`claude-opus-4-7`** with 1M-context flag
 * (`claude-opus-4-7[1m]`). The Claude 4.X family also includes
 * `claude-opus-4-8` and `claude-sonnet-4-6`. Choose the model in
 * `AnthropicClaudeOptions.model`; default is `claude-opus-4-7`.
 */

export {
  analyzeIncident,
  type AnalyzeIncidentOptions,
  type RcaReport,
  type ProposedFix,
} from './analyze.js';
export { AnthropicClaudeAdapter, type AnthropicClaudeOptions } from './anthropic.js';
export type { LlmAdapter, LlmRequest, LlmResponse } from './adapter.js';
