/**
 * Minimal LLM adapter interface. The auto-rca engine doesn't care which model
 * runs the analysis — we just need text-in / structured-JSON-out. Concrete
 * adapters (Anthropic Claude, OpenAI, local Ollama) live next to this file.
 */

export interface LlmRequest {
  /** System / role prompt for the analyzer. */
  readonly system: string;
  /** User prompt containing the forensics payload. */
  readonly user: string;
  /**
   * The adapter MUST return JSON parseable into this shape. Adapters can use
   * provider-native structured output (JSON mode, tool calls) when available.
   */
  readonly responseSchemaHint: 'rca-report-v1';
  /** Soft cap; the adapter is free to ignore. */
  readonly maxOutputTokens?: number;
}

export interface LlmResponse {
  /** Raw JSON string the model produced. Must parse into RcaReport. */
  readonly text: string;
  /** Model id used (for audit metadata stamped on the RCA event). */
  readonly modelId: string;
  /** Optional usage metadata from the provider. */
  readonly usage?: {
    inputTokens?: number;
    outputTokens?: number;
  };
}

export interface LlmAdapter {
  call(request: LlmRequest): Promise<LlmResponse>;
}
