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
import { DecisionSchema, err, validationError } from '@veritrail/core';

/** A decision returned by {@link DecisionMemoryModule.recall}, with its score. */
export interface DecisionMatch {
  /** The matched decision. */
  readonly decision: Decision;
  /**
   * Relevance score in `[0, 1]`: the fraction of *distinct* query tokens that
   * appear in the decision's searchable text. Empty-text recall yields a score
   * of `1`.
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

  constructor(ctx: ModuleContext) {
    this.#ctx = ctx;
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

    // `#projectDecisions` returns oldest-first; index gives recency tie-breaks.
    const decisions = await this.#projectDecisions({
      ...(query.actorId !== undefined ? { actorId: query.actorId } : {}),
      ...(query.labels !== undefined ? { labels: query.labels } : {}),
    });

    const queryTokens = tokenize(query.text ?? '');

    // No usable query text: pure recency ordering, score 1.
    if (queryTokens.length === 0) {
      const recent: DecisionMatch[] = [];
      for (let i = decisions.length - 1; i >= 0; i -= 1) {
        const decision = decisions[i];
        if (!decision) continue;
        recent.push({ decision, score: 1 });
      }
      return recent.slice(0, limit);
    }

    const querySet = new Set(queryTokens);

    interface Scored {
      readonly match: DecisionMatch;
      readonly index: number;
    }
    const scored: Scored[] = [];
    for (let index = 0; index < decisions.length; index += 1) {
      const decision = decisions[index];
      if (!decision) continue;
      const docTokens = tokenize(searchableText(decision));
      const docSet = new Set(docTokens);
      let shared = 0;
      for (const token of querySet) {
        if (docSet.has(token)) shared += 1;
      }
      if (shared === 0) continue; // not relevant.
      const score = shared / Math.max(1, querySet.size);
      scored.push({ match: { decision, score }, index });
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
    const query: EventQuery = {
      types: ['decision.recorded'],
      ...(opts?.actorId !== undefined ? { actorId: opts.actorId } : {}),
      ...(opts?.labels !== undefined ? { labels: opts.labels } : {}),
    };
    const records = await this.#ctx.ledger.query(query);
    const out: Decision[] = [];
    for (const record of records) {
      const decision = extractDecision(record);
      if (decision) out.push(decision);
    }
    return out;
  }
}

/** Construct a {@link DecisionMemoryModule} from a {@link ModuleContext}. */
export function createDecisionMemoryModule(ctx: ModuleContext): DecisionMemoryModule {
  return new DecisionMemoryModule(ctx);
}

/** Pull the `decision` payload out of a `decision.recorded` record. */
function extractDecision(record: LedgerRecord): Decision | null {
  const event = record.event as { type?: string; payload?: { decision?: Decision } };
  if (event.type !== 'decision.recorded') return null;
  return event.payload?.decision ?? null;
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
