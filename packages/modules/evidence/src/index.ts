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
  async attach(input: unknown): Promise<Result<LedgerRecord, VeritrailError>> {
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
      payload: { evidence },
    });
  }

  /** Project all attached evidence from the ledger, in attachment order. */
  async list(): Promise<Evidence[]> {
    const records = await this.#ctx.ledger.query({ types: ['evidence.attached'] });
    const out: Evidence[] = [];
    for (const record of records) {
      const evidence = extractEvidence(record);
      if (evidence) out.push(evidence);
    }
    return out;
  }

  /**
   * Look up a single piece of evidence by id. Returns the most recent
   * attachment for that id, or `null` when none exists.
   */
  async get(evidenceId: string): Promise<Evidence | null> {
    const all = await this.list();
    let found: Evidence | null = null;
    for (const evidence of all) {
      if (evidence.id === evidenceId) found = evidence;
    }
    return found;
  }

  /**
   * Build a provenance graph rooted at `evidenceId`, following
   * `links.evidenceIds` as `derived_from` edges via depth-first traversal.
   *
   * A `visited` set guards against cycles and a depth cap of
   * {@link MAX_TRACE_DEPTH} bounds pathological chains. Returns `NOT_FOUND`
   * when the root evidence does not exist. Dangling upstream references (ids
   * with no matching evidence) are silently skipped — they are not nodes.
   */
  async trace(evidenceId: string): Promise<Result<ProvenanceGraph, VeritrailError>> {
    const byId = new Map<string, Evidence>();
    for (const evidence of await this.list()) {
      byId.set(evidence.id, evidence);
    }

    const root = byId.get(evidenceId);
    if (!root) {
      return err(notFoundError(`evidence not found: ${evidenceId}`, { evidenceId }));
    }

    const nodes: ProvenanceNode[] = [];
    const edges: ProvenanceEdge[] = [];
    const visited = new Set<string>();

    const stack: Array<{ id: string; depth: number }> = [{ id: evidenceId, depth: 0 }];
    while (stack.length > 0) {
      const frame = stack.pop();
      if (!frame) break;
      const { id, depth } = frame;

      if (visited.has(id)) continue;
      visited.add(id);

      const evidence = byId.get(id);
      if (!evidence) continue; // dangling reference — not a node.

      nodes.push(toNode(evidence));

      if (depth >= MAX_TRACE_DEPTH) continue;

      for (const upstreamId of evidence.links.evidenceIds) {
        // Record the edge even when the upstream is dangling, so the provenance
        // intent is visible; the node simply will not exist.
        edges.push({ from: id, to: upstreamId, relation: 'derived_from' });
        if (!visited.has(upstreamId)) {
          stack.push({ id: upstreamId, depth: depth + 1 });
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
  ): Promise<Result<boolean, VeritrailError>> {
    const evidence = await this.get(evidenceId);
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
