import type { LlmAdapter, LlmRequest, LlmResponse } from './adapter.js';

export interface AnthropicClaudeOptions {
  readonly apiKey: string;
  /**
   * Model id. Per the current Claude API knowledge cutoff, the latest models
   * in the Claude 4.X family are `claude-opus-4-7`, `claude-opus-4-8`, and
   * `claude-sonnet-4-6`. For long incident traces, prefer `claude-opus-4-7`
   * (1M context) — the default.
   */
  readonly model?: string;
  readonly baseUrl?: string;
  readonly fetchImpl?: typeof fetch;
  /** Optional Anthropic API version header. Defaults to the current stable value. */
  readonly apiVersion?: string;
}

interface AnthropicMessagesResponse {
  readonly id?: string;
  readonly model?: string;
  readonly content?: ReadonlyArray<{ type: string; text?: string }>;
  readonly usage?: {
    readonly input_tokens?: number;
    readonly output_tokens?: number;
  };
  readonly error?: { message?: string };
}

/**
 * Direct Anthropic Messages API adapter. Kept dependency-light so the package
 * doesn't drag a heavyweight SDK into a server build.
 */
export class AnthropicClaudeAdapter implements LlmAdapter {
  readonly #apiKey: string;
  readonly #model: string;
  readonly #baseUrl: string;
  readonly #fetch: typeof fetch;
  readonly #apiVersion: string;

  constructor(options: AnthropicClaudeOptions) {
    if (!options.apiKey) throw new Error('AnthropicClaudeAdapter requires apiKey');
    this.#apiKey = options.apiKey;
    this.#model = options.model ?? 'claude-opus-4-7';
    this.#baseUrl = (options.baseUrl ?? 'https://api.anthropic.com').replace(/\/$/, '');
    this.#fetch = options.fetchImpl ?? globalThis.fetch;
    this.#apiVersion = options.apiVersion ?? '2023-06-01';
  }

  async call(request: LlmRequest): Promise<LlmResponse> {
    const body = {
      model: this.#model,
      max_tokens: request.maxOutputTokens ?? 4096,
      system: request.system,
      messages: [{ role: 'user', content: request.user }],
    };

    const response = await this.#fetch(`${this.#baseUrl}/v1/messages`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': this.#apiKey,
        'anthropic-version': this.#apiVersion,
      },
      body: JSON.stringify(body),
    });

    const payload = (await response.json()) as AnthropicMessagesResponse;
    if (!response.ok) {
      throw new Error(
        `Anthropic API error (${response.status}): ${payload.error?.message ?? 'unknown'}`,
      );
    }

    const text = (payload.content ?? [])
      .filter((block) => block.type === 'text' && typeof block.text === 'string')
      .map((block) => block.text!)
      .join('\n')
      .trim();

    return {
      text,
      modelId: payload.model ?? this.#model,
      ...(payload.usage
        ? {
            usage: {
              ...(payload.usage.input_tokens !== undefined
                ? { inputTokens: payload.usage.input_tokens }
                : {}),
              ...(payload.usage.output_tokens !== undefined
                ? { outputTokens: payload.usage.output_tokens }
                : {}),
            },
          }
        : {}),
    };
  }
}
