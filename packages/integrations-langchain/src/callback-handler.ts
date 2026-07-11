import type { VeritrailClient } from '@veritrail/sdk';

/**
 * Options for constructing a {@link VeritrailCallbackHandler}.
 *
 * - `client` posts every recorded event to the Veritrail server.
 * - `agentId` is used as the `actorId` envelope field on every emitted event;
 *   it identifies the agent in audit views and policy rules.
 * - `correlationId` (optional) groups every event from one run so the forensics
 *   engine can replay them together. When omitted, events are still appended
 *   without a correlation, but cross-event grouping must happen out-of-band.
 */
export interface VeritrailCallbackHandlerOptions {
  /** The HTTP client that appends events to the Veritrail server. */
  readonly client: VeritrailClient;
  /** Stable identifier of the agent emitting the events (becomes `actorId`). */
  readonly agentId: string;
  /** Run-scoped correlation id. When omitted, events carry no `correlationId`. */
  readonly correlationId?: string;
}

/** Shape of the run object LangChain hands to LLM lifecycle hooks. */
export interface LangChainLLMStartRun {
  readonly runId?: string;
  readonly extra?: { readonly invocation_params?: Record<string, unknown> };
}

/** Shape of the LLM-end output payload LangChain hands to `handleLLMEnd`. */
export interface LangChainLLMResult {
  readonly llmOutput?: {
    readonly tokenUsage?: Record<string, number>;
    readonly tokens?: Record<string, number>;
  };
}

/** Counter that yields stable, locally unique action ids per handler instance. */
class ActionIdCounter {
  #seq = 0;
  next(): string {
    this.#seq += 1;
    const ts = Date.now().toString(36);
    const seq = this.#seq.toString(36).padStart(4, '0');
    return `lc-act-${ts}-${seq}`;
  }
}

/**
 * Duck-typed LangChain callback handler that forwards lifecycle events into
 * Veritrail. The class deliberately does not import from `langchain` — LangChain
 * is a peer concern, and method shapes match `BaseCallbackHandler` by name.
 *
 * Each method appends one Veritrail event via {@link VeritrailClient.appendEvent}.
 * `handleToolStart` allocates a fresh action id and remembers it so that the
 * matching `handleToolEnd` can close the loop with `action.executed`.
 */
export class VeritrailCallbackHandler {
  /** Name LangChain uses to register the handler in its registry. */
  readonly name = 'veritrail_callback_handler';

  readonly #client: VeritrailClient;
  readonly #agentId: string;
  readonly #correlationId: string | undefined;
  readonly #counter = new ActionIdCounter();
  readonly #toolActions = new Map<string, string>();

  constructor(options: VeritrailCallbackHandlerOptions) {
    this.#client = options.client;
    this.#agentId = options.agentId;
    this.#correlationId = options.correlationId;
  }

  /** Build the envelope fields shared by every emitted event. */
  #envelope(): { actorId: string; correlationId?: string } {
    return this.#correlationId !== undefined
      ? { actorId: this.#agentId, correlationId: this.#correlationId }
      : { actorId: this.#agentId };
  }

  /** Summarise a prompt batch into a short, stable string for the `note` data. */
  static #summarisePrompts(prompts: ReadonlyArray<string>): string {
    if (prompts.length === 0) return '';
    const first = prompts[0] ?? '';
    const trimmed = first.length > 200 ? `${first.slice(0, 200)}...` : first;
    return prompts.length === 1 ? trimmed : `${trimmed} (+${prompts.length - 1} more)`;
  }

  /** Extract a model name from the LangChain LLM-start `llm` descriptor. */
  static #extractModel(llm: { id?: ReadonlyArray<string>; name?: string } | undefined): string {
    if (!llm) return 'unknown';
    if (typeof llm.name === 'string' && llm.name.length > 0) return llm.name;
    if (Array.isArray(llm.id) && llm.id.length > 0) {
      const last = llm.id[llm.id.length - 1];
      if (typeof last === 'string' && last.length > 0) return last;
    }
    return 'unknown';
  }

  /**
   * Append a `note` event tagged as `llm-start` with the model and a prompt
   * summary. Matches the LangChain `BaseCallbackHandler.handleLLMStart` shape.
   */
  async handleLLMStart(
    llm: { id?: ReadonlyArray<string>; name?: string },
    prompts: ReadonlyArray<string>,
  ): Promise<void> {
    await this.#client.appendEvent({
      type: 'note',
      ...this.#envelope(),
      payload: {
        text: 'llm-start',
        data: {
          model: VeritrailCallbackHandler.#extractModel(llm),
          prompt_summary: VeritrailCallbackHandler.#summarisePrompts(prompts),
        },
      },
    });
  }

  /**
   * Append a `note` event tagged as `llm-end` with model, latency, and token
   * usage. Latency is the elapsed time since the matching `handleLLMStart` when
   * the caller passes one via `startedAt`; otherwise it is `0`.
   */
  async handleLLMEnd(
    output: LangChainLLMResult,
    _runId?: string,
    options?: { readonly model?: string; readonly startedAt?: number },
  ): Promise<void> {
    const tokens = output.llmOutput?.tokenUsage ?? output.llmOutput?.tokens ?? {};
    const latency =
      options?.startedAt !== undefined ? Math.max(0, Date.now() - options.startedAt) : 0;
    await this.#client.appendEvent({
      type: 'note',
      ...this.#envelope(),
      payload: {
        text: 'llm-end',
        data: {
          model: options?.model ?? 'unknown',
          latency_ms: latency,
          tokens,
        },
      },
    });
  }

  /**
   * Propose a `tool.invoke` action on the ledger and remember its id so the
   * matching `handleToolEnd` can close it with `action.executed`. The action id
   * is per-call unique even when the same tool fires repeatedly in one run.
   */
  async handleToolStart(
    tool: { name?: string; id?: ReadonlyArray<string> },
    input: string,
    runId?: string,
  ): Promise<void> {
    const actionId = this.#counter.next();
    if (typeof runId === 'string' && runId.length > 0) {
      this.#toolActions.set(runId, actionId);
    }
    const toolName =
      tool.name ??
      (Array.isArray(tool.id) && tool.id.length > 0 ? (tool.id[tool.id.length - 1] ?? '') : '') ??
      '';
    await this.#client.appendEvent({
      type: 'action.proposed',
      ...this.#envelope(),
      payload: {
        action: {
          id: actionId,
          actorId: this.#agentId,
          type: 'tool.invoke',
          target: toolName,
          params: { input },
        },
      },
    });
  }

  /**
   * Append an `action.executed` event whose `actionId` matches the one issued
   * by the corresponding `handleToolStart`. `result` is `"ok"` on success and
   * `"error"` when `error` is true.
   */
  async handleToolEnd(
    _output: string,
    runId?: string,
    options?: { readonly error?: boolean; readonly actionId?: string },
  ): Promise<void> {
    const lookup =
      options?.actionId ??
      (typeof runId === 'string' ? this.#toolActions.get(runId) : undefined) ??
      '';
    if (typeof runId === 'string') this.#toolActions.delete(runId);
    const result = options?.error === true ? 'error' : 'ok';
    await this.#client.appendEvent({
      type: 'action.executed',
      ...this.#envelope(),
      payload: {
        actionId: lookup,
        outcome: options?.error === true ? 'partial' : 'success',
        result,
      },
    });
  }

  /** Append a `chain-start` note carrying the chain name. */
  async handleChainStart(chain: { name?: string; id?: ReadonlyArray<string> }): Promise<void> {
    await this.#client.appendEvent({
      type: 'note',
      ...this.#envelope(),
      payload: {
        text: 'chain-start',
        data: { name: VeritrailCallbackHandler.#extractModel(chain) },
      },
    });
  }

  /** Append a `chain-end` note carrying the chain name. */
  async handleChainEnd(_outputs: unknown, options?: { readonly name?: string }): Promise<void> {
    await this.#client.appendEvent({
      type: 'note',
      ...this.#envelope(),
      payload: {
        text: 'chain-end',
        data: { name: options?.name ?? 'unknown' },
      },
    });
  }
}
