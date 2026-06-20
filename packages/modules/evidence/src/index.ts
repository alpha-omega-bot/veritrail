/**
 * `@veritrail/evidence` — the Evidence Tracing engine (scaffold baseline).
 *
 * Evidence is a content-addressed provenance graph layered over the single
 * tamper-evident ledger. Attaching evidence appends an `evidence.attached`
 * fact; every read (`list`, `get`, `trace`, `verifyContent`) is a projection
 * over those facts. The ledger remains the system of record — this module never
 * keeps a parallel store.
 *
 * `trace` walks the `links.evidenceIds` of a root piece of evidence as
 * `derived_from` edges, producing a provenance graph with a cycle guard and a
 * depth cap. `verifyContent` re-hashes supplied content and compares it against
 * the stored `contentHash`, proving the referenced content has not changed.
 */

import type {
  Evidence,
  EvidenceKind,
  EventQuery,
  LedgerRecord,
  ModuleContext,
  Result,
  VeritrailError,
  VeritrailModule,
} from '@veritrail/core';
import {
  EvidenceSchema,
  err,
  notFoundError,
  ok,
  sha256Hex,
  validationError,
} from '@veritrail/core';

/** Maximum traversal depth for {@link EvidenceModule.trace}. */
const MAX_TRACE_DEPTH = 100;

/** A node in a provenance graph: one piece of evidence. */
export interface ProvenanceNode {
  readonly id: string;
  readonly kind: EvidenceKind;
  readonly source: string;
  readonly summary: string;
  readonly contentHash?: string;
}

/** A directed edge: `from` was derived from `to` (upstream) evidence. */
export interface ProvenanceEdge {
  readonly from: string;
  readonly to: string;
  readonly relation: 'derived_from';
}

/** A provenance graph rooted at a single piece of evidence. */
export interface ProvenanceGraph {
  readonly rootId: string;
  readonly nodes: ProvenanceNode[];
  readonly edges: ProvenanceEdge[];
}

/** Optional ledger envelope values for attached evidence facts. */
export interface EvidenceAttachOptions {
  /** Labels to write onto the `evidence.attached` event envelope. */
  readonly labels?: Readonly<Record<string, string>>;
}

/** Optional projection filters for evidence reads. */
export interface EvidenceProjectionOptions {
  /** Restrict reads to evidence records carrying these exact ledger labels. */
  readonly labels?: Readonly<Record<string, string>>;
}

/** Options for {@link EvidenceModule.list}: projection filters plus pagination. */
export interface EvidenceListOptions extends EvidenceProjectionOptions {
  /** Skip this many records from the start (clamped to >= 0). Default 0. */
  readonly offset?: number;
  /** Cap the number of records returned. Omit for all; a negative value yields none. */
  readonly limit?: number;
}

/**
 * Evidence Tracing engine. Reads (and, via {@link EvidenceModule.attach},
 * appends to) the shared ledger.
 */
export class EvidenceModule implements VeritrailModule {
  readonly info = {
    name: '@veritrail/evidence',
    version: '0.1.0',
    capability: 'evidence' as const,
  };

  readonly #ctx: ModuleContext;

  constructor(ctx: ModuleContext) {
    this.#ctx = ctx;
  }

  /**
   * Validate and attach a piece of evidence by appending an
   * `evidence.attached` event. An `id` is assigned via `ids.next('evd')` when
   * absent. The caller supplies the ledger envelope's `actorId` (required) and
   * an optional `correlationId` alongside the evidence body.
   */
  async attach(
    input: unknown,
    opts?: EvidenceAttachOptions,
  ): Promise<Result<LedgerRecord, VeritrailError>> {
    if (typeof input !== 'object' || input === null) {
      return err(validationError('evidence attach input must be an object'));
    }
    const raw = input as Record<string, unknown>;

    // Separate the ledger envelope's actorId/correlationId from the evidence
    // body so the evidence schema (strict) validates cleanly.
    const { actorId, correlationId, ...evidenceFields } = raw;
    if (typeof actorId !== 'string' || actorId.length === 0) {
      return err(validationError('evidence attach requires a non-empty actorId'));
    }

    // Assign an id before validation when the caller did not supply one.
    const candidate =
      evidenceFields['id'] === undefined
        ? { ...evidenceFields, id: this.#ctx.ids.next('evd') }
        : evidenceFields;

    const parsed = EvidenceSchema.safeParse(candidate);
    if (!parsed.success) {
      return err(
        validationError('invalid evidence', {
          issues: parsed.error.issues.map((i) => ({
            path: i.path.map(String).join('.'),
            message: i.message,
          })),
        }),
      );
    }
    const evidence = parsed.data;

    this.#ctx.logger.debug('attaching evidence', { id: evidence.id, kind: evidence.kind });

    return this.#ctx.ledger.append({
      type: 'evidence.attached',
      actorId,
      ...(typeof correlationId === 'string' ? { correlationId } : {}),
      ...(opts?.labels !== undefined ? { labels: opts.labels } : {}),
      payload: { evidence },
    });
  }

  /**
   * Project attached evidence from the ledger, in attachment order. With
   * `offset`/`limit` it returns a page of that ordering: `offset` is clamped to
   * `>= 0`, and a negative `limit` yields an empty page (consistent with the
   * other modules' limit handling). Omitting `limit` returns all records from
   * `offset` onward.
   */
  async list(opts?: EvidenceListOptions): Promise<Evidence[]> {
    const records = await this.#ctx.ledger.query(evidenceQuery(opts));
    const out: Evidence[] = [];
    for (const record of records) {
      const evidence = extractEvidence(record);
      if (evidence) out.push(evidence);
    }
    const offset = opts?.offset !== undefined ? Math.max(0, opts.offset) : 0;
    if (opts?.limit === undefined) {
      return offset === 0 ? out : out.slice(offset);
    }
    return out.slice(offset, offset + Math.max(0, opts.limit));
  }

  /**
   * Look up a single piece of evidence by id. Returns the most recent
   * attachment for that id, or `null` when none exists.
   */
  async get(evidenceId: string, opts?: EvidenceProjectionOptions): Promise<Evidence | null> {
    const all = await this.list(opts);
    let found: Evidence | null = null;
    for (const evidence of all) {
      if (evidence.id === evidenceId) found = evidence;
    }
    return found;
  }

  /**
   * Project the evidence that supports a decision: every distinct piece of
   * evidence whose `links.decisionIds` includes `decisionId`. When an id was
   * re-attached, the most recent version wins (consistent with {@link get}), so
   * a link added or removed by a later attachment is honored. Results are in
   * ascending id order for stable output. The decision itself need not exist —
   * this answers "what evidence claims to support this decision".
   */
  async evidenceForDecision(
    decisionId: string,
    opts?: EvidenceProjectionOptions,
  ): Promise<Evidence[]> {
    // Latest-by-id (the ledger is append-only; a re-attach supersedes earlier).
    const latest = new Map<string, Evidence>();
    for (const evidence of await this.list(opts)) {
      latest.set(evidence.id, evidence);
    }
    return [...latest.values()]
      .filter((evidence) => evidence.links.decisionIds.includes(decisionId))
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  }

  /**
   * Build a provenance graph rooted at `evidenceId`, following
   * `links.evidenceIds` as `derived_from` edges.
   *
   * Traversal is **breadth-first**, so every reachable node is visited at its
   * *minimum* depth from the root. This matters because of the depth cap
   * ({@link MAX_TRACE_DEPTH}): a node reachable within the cap via a short path
   * must not be pruned just because it is *also* reachable via a long one. Each
   * node is emitted once, and each `(from, to)` edge is emitted once (repeated
   * upstream ids do not produce duplicate edges). Returns `NOT_FOUND` when the
   * root evidence does not exist. A dangling upstream reference (an id with no
   * matching evidence) still records its edge — so the provenance intent is
   * visible — but creates no node.
   */
  async trace(
    evidenceId: string,
    opts?: EvidenceProjectionOptions,
  ): Promise<Result<ProvenanceGraph, VeritrailError>> {
    const byId = new Map<string, Evidence>();
    for (const evidence of await this.list(opts)) {
      byId.set(evidence.id, evidence);
    }

    const root = byId.get(evidenceId);
    if (!root) {
      return err(notFoundError(`evidence not found: ${evidenceId}`, { evidenceId }));
    }

    const nodes: ProvenanceNode[] = [];
    const edges: ProvenanceEdge[] = [];
    const seenEdge = new Set<string>();
    // `enqueued` is set when an id is added to the queue, so each node is
    // processed once at its minimum (first-reached, i.e. shallowest) depth.
    const enqueued = new Set<string>([evidenceId]);

    const queue: Array<{ id: string; depth: number }> = [{ id: evidenceId, depth: 0 }];
    for (let head = 0; head < queue.length; head += 1) {
      const { id, depth } = queue[head]!;

      const evidence = byId.get(id);
      if (!evidence) continue; // dangling reference — its edge is recorded, but it is not a node.

      nodes.push(toNode(evidence));

      if (depth >= MAX_TRACE_DEPTH) continue;

      for (const upstreamId of evidence.links.evidenceIds) {
        const edgeKey = `${id} ${upstreamId}`;
        if (!seenEdge.has(edgeKey)) {
          seenEdge.add(edgeKey);
          edges.push({ from: id, to: upstreamId, relation: 'derived_from' });
        }
        if (!enqueued.has(upstreamId)) {
          enqueued.add(upstreamId);
          queue.push({ id: upstreamId, depth: depth + 1 });
        }
      }
    }

    return ok({ rootId: evidenceId, nodes, edges });
  }

  /**
   * Verify that `content` matches the stored `contentHash` of an evidence
   * record. Returns `NOT_FOUND` when the evidence is missing or has no
   * `contentHash`; otherwise `ok(true|false)`.
   */
  async verifyContent(
    evidenceId: string,
    content: string,
    opts?: EvidenceProjectionOptions,
  ): Promise<Result<boolean, VeritrailError>> {
    const evidence = await this.get(evidenceId, opts);
    if (!evidence) {
      return err(notFoundError(`evidence not found: ${evidenceId}`, { evidenceId }));
    }
    if (evidence.contentHash === undefined) {
      return err(notFoundError(`evidence has no contentHash: ${evidenceId}`, { evidenceId }));
    }
    return ok(sha256Hex(content) === evidence.contentHash);
  }
}

/** Construct an {@link EvidenceModule} from a {@link ModuleContext}. */
export function createEvidenceModule(ctx: ModuleContext): EvidenceModule {
  return new EvidenceModule(ctx);
}

/** Build the ledger query used by evidence projections. */
function evidenceQuery(opts?: EvidenceProjectionOptions): EventQuery {
  return {
    types: ['evidence.attached'],
    ...(opts?.labels !== undefined ? { labels: opts.labels } : {}),
  };
}

/** Pull the `evidence` payload out of an `evidence.attached` record. */
function extractEvidence(record: LedgerRecord): Evidence | null {
  const event = record.event as { type?: string; payload?: { evidence?: Evidence } };
  if (event.type !== 'evidence.attached') return null;
  return event.payload?.evidence ?? null;
}

/** Project an {@link Evidence} into a {@link ProvenanceNode}. */
function toNode(evidence: Evidence): ProvenanceNode {
  return {
    id: evidence.id,
    kind: evidence.kind,
    source: evidence.source,
    summary: evidence.summary,
    ...(evidence.contentHash !== undefined ? { contentHash: evidence.contentHash } : {}),
  };
}
