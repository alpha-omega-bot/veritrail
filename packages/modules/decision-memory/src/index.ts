/**
 * `@veritrail/decision-memory` — the Decision Memory engine (scaffold baseline).
 *
 * Decision Memory records *why* an agent did what it did and lets you recall it
 * later. Recording a decision appends a `decision.recorded` fact to the single
 * tamper-evident ledger; every read (`list`, `get`, `recall`) is a projection
 * over those facts. The ledger remains the system of record — this module keeps
 * no parallel store.
 *
 * `recall` is a deliberately simple lexical ranker: it tokenizes the query and
 * scores each decision by the fraction of query tokens it shares with the
 * decision's `summary + rationale + chosen` text. Phase 1 will replace this with
 * semantic recall (see the README's "Phase 1 TODO").
 */

import type {
  Decision,
  EventQuery,
  LedgerRecord,
  ModuleContext,
  Result,
  VeritrailError,
  VeritrailModule,
} from '@veritrail/core';
import { DecisionSchema, err, notFoundError, ok, validationError } from '@veritrail/core';

/** A decision returned by {@link DecisionMemoryModule.recall}, with its score. */
export interface DecisionMatch {
  /** The matched decision. */
  readonly decision: Decision;
  /**
   * Relevance score in `[0, 1]`: the fraction of *distinct* query tokens that
   * appear in the decision's searchable text. Empty-text recall yields a base
   * score of `1`. When `recencyHalfLifeMs` is set, the score is additionally
   * scaled by an age-decay factor in `(0, 1]`.
   */
  readonly score: number;
}

/** A recall request: free-text and/or an actor filter, with an optional limit. */
export interface RecallQuery {
  /** Free-text query; tokenized and matched against decision text. */
  readonly text?: string;
  /** Restrict results to decisions made by this actor. */
  readonly actorId?: string;
  /** Maximum number of matches to return (default {@link DEFAULT_RECALL_LIMIT}). */
  readonly limit?: number;
  /** Restrict recalled decisions to records carrying these exact ledger labels. */
  readonly labels?: Readonly<Record<string, string>>;
  /**
   * Opt-in recency weighting. When set to a positive number of milliseconds, the
   * lexical score is multiplied by `0.5 ^ (ageMs / recencyHalfLifeMs)`, where age
   * is measured from the decision's authoritative ledger timestamp to the
   * injected clock's `now`. So a decision's contribution halves every
   * `recencyHalfLifeMs`. Unset (or non-positive) leaves ranking purely lexical
   * with recency only as a tie-break.
   */
  readonly recencyHalfLifeMs?: number;
}

/** Optional ledger envelope values for recorded decision facts. */
export interface DecisionRecordOptions {
  /** Labels to write onto the `decision.recorded` event envelope. */
  readonly labels?: Readonly<Record<string, string>>;
}

/** Optional projection filters for listing/getting recorded decisions. */
export interface DecisionProjectionOptions {
  /** Restrict decisions to records carrying these exact ledger labels. */
  readonly labels?: Readonly<Record<string, string>>;
}

/**
 * A pluggable text-embedding model for semantic recall. Implementations turn
 * text into fixed-length vectors; the module ranks decisions by cosine
 * similarity to the query vector. The reference {@link HashingEmbeddingProvider}
 * is dependency-free; production deployments inject a real model (the same way
 * `Signer` / `MonitorSource` are injected). Kept out of `@veritrail/core` so no
 * model SDK becomes a runtime dependency.
 */
export interface EmbeddingProvider {
  /**
   * Embed each input string into a vector. Called once per `recall` with the
   * query followed by every candidate's text, so a networked model makes one
   * round-trip. Must return one vector per input, in order, all the same length.
   */
  embed(texts: readonly string[]): Promise<number[][]>;
}

/** Construction-time options for {@link DecisionMemoryModule}. */
export interface DecisionMemoryConfig {
  /**
   * When provided, `recall` ranks by embedding cosine similarity instead of
   * lexical token overlap (recency weighting still applies). Omitted → lexical
   * recall, the default.
   */
  readonly embeddingProvider?: EmbeddingProvider;
}

/** The terminal outcome of a single related action, derived from its lifecycle events. */
export type ActionOutcome = 'succeeded' | 'failed' | 'denied' | 'rolled_back' | 'pending';

/** One related action and the outcome it reached. */
export interface ActionResult {
  readonly actionId: string;
  readonly outcome: ActionOutcome;
}

/** A rolled-up verdict on whether a decision's actions worked out. */
export type DecisionVerdict = 'effective' | 'failed' | 'mixed' | 'pending' | 'no_actions';

/** The outcome of a decision: per-action results plus a rolled-up verdict. */
export interface DecisionOutcomeReport {
  readonly decisionId: string;
  /** One entry per `relatedActionId`, in the decision's declared order. */
  readonly actions: ActionResult[];
  /** `no_actions` (none related) · `pending` (in flight, none bad) · `effective`
   *  (all succeeded) · `failed` (bad, none succeeded) · `mixed` (some of each). */
  readonly verdict: DecisionVerdict;
}

/** Default number of matches `recall` returns when no `limit` is supplied. */
const DEFAULT_RECALL_LIMIT = 10;

/**
 * Decision Memory engine. Reads (and, via {@link DecisionMemoryModule.record},
 * appends to) the shared ledger.
 */
export class DecisionMemoryModule implements VeritrailModule {
  readonly info = {
    name: '@veritrail/decision-memory',
    version: '0.1.0',
    capability: 'decision-memory' as const,
  };

  readonly #ctx: ModuleContext;
  readonly #embeddingProvider: EmbeddingProvider | undefined;

  constructor(ctx: ModuleContext, config?: DecisionMemoryConfig) {
    this.#ctx = ctx;
    this.#embeddingProvider = config?.embeddingProvider;
  }

  /**
   * Validate a decision and record it by appending a `decision.recorded`
   * event. An `id` is assigned via `ids.next('dec')` when absent. The decision's
   * own `actorId` becomes the ledger envelope's `actorId`, so decisions are
   * queryable by actor. Returns a `VALIDATION` error for non-object or
   * schema-invalid input.
   */
  async record(
    input: unknown,
    opts?: DecisionRecordOptions,
  ): Promise<Result<LedgerRecord, VeritrailError>> {
    if (typeof input !== 'object' || input === null) {
      return err(validationError('decision record input must be an object'));
    }
    const raw = input as Record<string, unknown>;

    // Assign an id before validation when the caller did not supply one.
    const candidate = raw['id'] === undefined ? { ...raw, id: this.#ctx.ids.next('dec') } : raw;

    const parsed = DecisionSchema.safeParse(candidate);
    if (!parsed.success) {
      return err(
        validationError('invalid decision', {
          issues: parsed.error.issues.map((i) => ({
            path: i.path.map(String).join('.'),
            message: i.message,
          })),
        }),
      );
    }
    const decision = parsed.data;

    this.#ctx.logger.debug('recording decision', {
      id: decision.id,
      actorId: decision.actorId,
    });

    return this.#ctx.ledger.append({
      type: 'decision.recorded',
      actorId: decision.actorId,
      ...(opts?.labels !== undefined ? { labels: opts.labels } : {}),
      payload: { decision },
    });
  }

  /**
   * Project recorded decisions from the ledger, most-recent first. When the
   * same `id` is recorded more than once, every recording is included (the
   * ledger is append-only); use {@link DecisionMemoryModule.get} for the latest
   * by id. Filters by `actorId` and applies `limit` when supplied.
   */
  async list(opts?: {
    actorId?: string;
    limit?: number;
    labels?: Readonly<Record<string, string>>;
  }): Promise<Decision[]> {
    const decisions = await this.#projectDecisions({
      ...(opts?.actorId !== undefined ? { actorId: opts.actorId } : {}),
      ...(opts?.labels !== undefined ? { labels: opts.labels } : {}),
    });
    decisions.reverse(); // ledger order is oldest-first; surface newest first.
    if (opts?.limit !== undefined) {
      // A negative limit clamps to an empty result (consistent with limit=0),
      // rather than falling through and returning everything.
      return decisions.slice(0, Math.max(0, opts.limit));
    }
    return decisions;
  }

  /**
   * Look up a single decision by id, returning the most recent recording for
   * that id, or `null` when none exists.
   */
  async get(decisionId: string, opts?: DecisionProjectionOptions): Promise<Decision | null> {
    const decisions = await this.#projectDecisions(opts);
    let found: Decision | null = null;
    for (const decision of decisions) {
      if (decision.id === decisionId) found = decision; // keep the latest.
    }
    return found;
  }

  /**
   * Report whether a decision's actions worked out ("did the decision work?").
   *
   * Looks up the decision (latest by id), then classifies each `relatedActionId`
   * by replaying its action lifecycle events into a terminal {@link ActionOutcome}
   * (`rolled_back` > `failed` > `denied` > `succeeded`, else `pending` when no
   * terminal event is recorded yet), and rolls those into a {@link DecisionVerdict}.
   * Returns `NOT_FOUND` when the decision does not exist (in scope). Tenant-scoped:
   * only in-scope action events count, so an out-of-scope outcome reads as pending.
   */
  async outcomesFor(
    decisionId: string,
    opts?: DecisionProjectionOptions,
  ): Promise<Result<DecisionOutcomeReport, VeritrailError>> {
    const decision = await this.get(decisionId, opts);
    if (!decision) {
      return err(notFoundError(`decision not found: ${decisionId}`, { decisionId }));
    }

    const byActionId = await this.#actionOutcomes(opts);
    const actions: ActionResult[] = decision.relatedActionIds.map((actionId) => ({
      actionId,
      outcome: byActionId.get(actionId) ?? 'pending',
    }));

    return ok({ decisionId, actions, verdict: verdictFor(actions) });
  }

  /**
   * Map each action id to its terminal outcome by replaying action lifecycle
   * events in ledger order. Later terminal events override earlier ones, so a
   * `rolled_back` after an `executed` correctly reads as rolled back.
   */
  async #actionOutcomes(opts?: DecisionProjectionOptions): Promise<Map<string, ActionOutcome>> {
    const records = await this.#ctx.ledger.query({
      types: ['action.executed', 'action.failed', 'action.denied', 'action.rolled_back'],
      ...(opts?.labels !== undefined ? { labels: opts.labels } : {}),
    });
    const byActionId = new Map<string, ActionOutcome>();
    for (const record of records) {
      const event = record.event;
      let outcome: ActionOutcome;
      switch (event.type) {
        case 'action.executed':
          outcome = 'succeeded';
          break;
        case 'action.failed':
          outcome = 'failed';
          break;
        case 'action.denied':
          outcome = 'denied';
          break;
        case 'action.rolled_back':
          outcome = 'rolled_back';
          break;
        default:
          continue;
      }
      byActionId.set(event.payload.actionId, outcome);
    }
    return byActionId;
  }

  /**
   * Recall decisions relevant to `query.text`, ranked by lexical overlap.
   *
   * The query text is tokenized (lowercased, split on non-alphanumerics, empties
   * dropped) and reduced to its *distinct* tokens. Each decision is scored as
   * `distinctSharedTokens / distinctQueryTokens` against the distinct tokens of
   * `summary + ' ' + rationale + ' ' + chosen` — so a full match scores `1`
   * regardless of token repetition. Results are filtered by `actorId`, sorted by
   * score descending then most-recent, and truncated to `limit` (default
   * {@link DEFAULT_RECALL_LIMIT}).
   *
   * When `query.text` is absent or has no tokens, returns the most-recent
   * decisions (each with score `1`), filtered by `actorId`.
   */
  async recall(query: RecallQuery): Promise<DecisionMatch[]> {
    // undefined → default; a supplied limit is honored, with negatives clamped
    // to 0 (empty) rather than silently falling back to the default.
    const limit = query.limit === undefined ? DEFAULT_RECALL_LIMIT : Math.max(0, query.limit);

    // `#projectTimestamped` returns oldest-first; index gives recency tie-breaks.
    const decisions = await this.#projectTimestamped({
      ...(query.actorId !== undefined ? { actorId: query.actorId } : {}),
      ...(query.labels !== undefined ? { labels: query.labels } : {}),
    });

    const halfLife =
      query.recencyHalfLifeMs !== undefined && query.recencyHalfLifeMs > 0
        ? query.recencyHalfLifeMs
        : undefined;
    const now = halfLife !== undefined ? this.#ctx.clock.now() : 0;
    const decay = (timestamp: number): number =>
      halfLife === undefined ? 1 : Math.pow(0.5, Math.max(0, now - timestamp) / halfLife);

    const queryTokens = tokenize(query.text ?? '');

    interface Scored {
      readonly match: DecisionMatch;
      readonly index: number;
    }
    const scored: Scored[] = [];

    // No usable query text: base score 1, optionally recency-weighted.
    if (queryTokens.length === 0) {
      for (let index = 0; index < decisions.length; index += 1) {
        const entry = decisions[index];
        if (!entry) continue;
        scored.push({ match: { decision: entry.decision, score: decay(entry.timestamp) }, index });
      }
    } else {
      // Semantic scoring when an embedding provider is configured; falls back to
      // lexical scoring if the provider fails, so recall never hard-errors.
      const semantic =
        this.#embeddingProvider !== undefined
          ? await this.#semanticScores(query.text ?? '', decisions, this.#embeddingProvider)
          : undefined;

      const querySet = new Set(queryTokens);
      for (let index = 0; index < decisions.length; index += 1) {
        const entry = decisions[index];
        if (!entry) continue;
        let relevance: number;
        if (semantic !== undefined) {
          relevance = semantic[index] ?? 0;
        } else {
          const docSet = new Set(tokenize(searchableText(entry.decision)));
          let shared = 0;
          for (const token of querySet) {
            if (docSet.has(token)) shared += 1;
          }
          relevance = shared / querySet.size;
        }
        if (relevance <= 0) continue; // not relevant.
        scored.push({
          match: { decision: entry.decision, score: relevance * decay(entry.timestamp) },
          index,
        });
      }
    }

    // Score descending, then most-recent (higher ledger index) first.
    scored.sort((a, b) => b.match.score - a.match.score || b.index - a.index);

    return scored.slice(0, limit).map((s) => s.match);
  }

  /**
   * Project decisions from the ledger in append (oldest-first) order, optionally
   * filtered by `actorId`.
   */
  async #projectDecisions(
    opts?: DecisionProjectionOptions & { actorId?: string },
  ): Promise<Decision[]> {
    const timestamped = await this.#projectTimestamped(opts);
    return timestamped.map((entry) => entry.decision);
  }

  /**
   * Project decisions paired with their authoritative ledger timestamps, in
   * append (oldest-first) order, optionally filtered by `actorId`.
   */
  async #projectTimestamped(
    opts?: DecisionProjectionOptions & { actorId?: string },
  ): Promise<Array<{ decision: Decision; timestamp: number }>> {
    const query: EventQuery = {
      types: ['decision.recorded'],
      ...(opts?.actorId !== undefined ? { actorId: opts.actorId } : {}),
      ...(opts?.labels !== undefined ? { labels: opts.labels } : {}),
    };
    const records = await this.#ctx.ledger.query(query);
    const out: Array<{ decision: Decision; timestamp: number }> = [];
    for (const record of records) {
      const decision = extractDecision(record);
      if (decision) out.push({ decision, timestamp: record.timestamp });
    }
    return out;
  }

  /**
   * Cosine-similarity relevance per decision (aligned with `decisions` by index),
   * clamped to `[0, 1]`. One `embed` call for the query plus every candidate.
   * Returns `undefined` on provider failure or a malformed response so the caller
   * falls back to lexical scoring; `recall` never hard-fails on the model.
   */
  async #semanticScores(
    queryText: string,
    decisions: ReadonlyArray<{ decision: Decision; timestamp: number }>,
    provider: EmbeddingProvider,
  ): Promise<number[] | undefined> {
    const inputs = [queryText, ...decisions.map((d) => searchableText(d.decision))];
    let vectors: number[][];
    try {
      vectors = await provider.embed(inputs);
    } catch (cause) {
      this.#ctx.logger.warn('decision-memory embedding failed; falling back to lexical recall', {
        reason: cause instanceof Error ? cause.message : String(cause),
      });
      return undefined;
    }
    if (vectors.length !== inputs.length) {
      this.#ctx.logger.warn(
        'decision-memory embedding returned wrong count; using lexical recall',
        {
          expected: inputs.length,
          got: vectors.length,
        },
      );
      return undefined;
    }
    const queryVec = vectors[0]!;
    return decisions.map((_, i) => Math.max(0, cosineSimilarity(queryVec, vectors[i + 1]!)));
  }
}

/** Construct a {@link DecisionMemoryModule} from a {@link ModuleContext}. */
export function createDecisionMemoryModule(
  ctx: ModuleContext,
  config?: DecisionMemoryConfig,
): DecisionMemoryModule {
  return new DecisionMemoryModule(ctx, config);
}

/** Pull the `decision` payload out of a `decision.recorded` record. */
function extractDecision(record: LedgerRecord): Decision | null {
  const event = record.event as { type?: string; payload?: { decision?: Decision } };
  if (event.type !== 'decision.recorded') return null;
  return event.payload?.decision ?? null;
}

/** Roll per-action outcomes into a single decision verdict. */
function verdictFor(actions: ReadonlyArray<ActionResult>): DecisionVerdict {
  if (actions.length === 0) return 'no_actions';
  let succeeded = 0;
  let bad = 0;
  let pending = 0;
  for (const { outcome } of actions) {
    if (outcome === 'succeeded') succeeded += 1;
    else if (outcome === 'pending') pending += 1;
    else bad += 1; // failed | denied | rolled_back
  }
  if (bad > 0) return succeeded > 0 ? 'mixed' : 'failed';
  return pending > 0 ? 'pending' : 'effective';
}

/** The text a decision is matched against during {@link DecisionMemoryModule.recall}. */
function searchableText(decision: Decision): string {
  return `${decision.summary} ${decision.rationale} ${decision.chosen}`;
}

/**
 * Tokenize text into lowercased alphanumeric tokens: split on any run of
 * non-alphanumeric characters and drop empty tokens.
 */
function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 0);
}

/** Cosine similarity of two equal-length vectors; 0 when either has zero magnitude. */
function cosineSimilarity(a: readonly number[], b: readonly number[]): number {
  const n = Math.min(a.length, b.length);
  let dot = 0;
  let magA = 0;
  let magB = 0;
  for (let i = 0; i < n; i += 1) {
    const x = a[i]!;
    const y = b[i]!;
    dot += x * y;
    magA += x * x;
    magB += y * y;
  }
  if (magA === 0 || magB === 0) return 0;
  return dot / (Math.sqrt(magA) * Math.sqrt(magB));
}

/** Deterministic 32-bit FNV-1a hash of a token, used to bucket it into a dimension. */
function fnv1a(token: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < token.length; i += 1) {
    hash ^= token.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/**
 * Dependency-free, deterministic reference {@link EmbeddingProvider} using the
 * hashing trick: each token is hashed into one of `dimensions` buckets and the
 * bucket counts form a bag-of-words vector. It is fully reproducible and needs no
 * model, which makes it ideal for tests and offline/local use — but it captures
 * only lexical overlap (hashed), NOT true synonymy. Inject a real embedding model
 * for genuine semantic recall.
 */
export class HashingEmbeddingProvider implements EmbeddingProvider {
  readonly #dimensions: number;

  constructor(dimensions = 256) {
    if (!Number.isInteger(dimensions) || dimensions <= 0) {
      throw new Error('HashingEmbeddingProvider: dimensions must be a positive integer');
    }
    this.#dimensions = dimensions;
  }

  async embed(texts: readonly string[]): Promise<number[][]> {
    return texts.map((text) => {
      const vec = new Array<number>(this.#dimensions).fill(0);
      for (const token of tokenize(text)) {
        const bucket = fnv1a(token) % this.#dimensions;
        vec[bucket] = (vec[bucket] ?? 0) + 1;
      }
      return vec;
    });
  }
}
