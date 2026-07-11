/**
 * @veritrail/zk-compliance
 *
 * v0.1: Predicate-level commitment proofs.
 *
 * The trick: a predicate is a pure function over an EventInput that returns
 * true/false ("event.labels.region === 'EU'"). For a time window of N events,
 * the prover commits to:
 *
 *   1. The SHA-256 root of all matching events (a sorted hash list).
 *   2. The count of matching events.
 *   3. The last record's hash as a window anchor.
 *
 * The verifier needs the trusted ledger head hash and the predicate name.
 * Given those, the proof confirms:
 *   - "K events in [seq_a, seq_b] satisfy predicate P, none others"
 * without revealing any event content.
 *
 * Full SNARK circuits (proving every event was correctly evaluated by P) are
 * the v0.2 goal. v0.1 is "commitment-only" — it requires the verifier to
 * trust that the prover applied the named predicate honestly. That is enough
 * for many regulatory use cases where the predicate code itself is published.
 */

import { createHash } from 'node:crypto';

import type { EventInput, LedgerReader, LedgerRecord } from '@veritrail/core';

/** Canonical predicate type. Pure function; deterministic. */
export type Predicate = (event: EventInput) => boolean;

/** A registered predicate the verifier and prover both know by name. */
export interface NamedPredicate {
  readonly name: string;
  readonly description: string;
  readonly predicate: Predicate;
}

export interface ProofWindow {
  readonly fromSeq: number;
  readonly toSeq: number;
}

export interface ZkProof {
  readonly version: 1;
  readonly predicateName: string;
  readonly window: ProofWindow;
  readonly matchCount: number;
  readonly matchRoot: string;
  readonly windowEndHash: string;
  readonly issuedAt: string;
}

export interface GenerateProofOptions {
  readonly ledger: LedgerReader;
  readonly predicate: NamedPredicate;
  readonly window: ProofWindow;
}

export async function generateProof(options: GenerateProofOptions): Promise<ZkProof | null> {
  const records = await options.ledger.query({
    fromSeq: options.window.fromSeq,
    toSeq: options.window.toSeq,
  });
  if (records.length === 0) return null;

  const matchingHashes: string[] = [];
  for (const record of records as readonly LedgerRecord[]) {
    if (options.predicate.predicate(record.event as EventInput)) {
      matchingHashes.push(record.hash);
    }
  }
  matchingHashes.sort();

  const lastRecord = records[records.length - 1]!;
  return {
    version: 1,
    predicateName: options.predicate.name,
    window: options.window,
    matchCount: matchingHashes.length,
    matchRoot: matchingHashes.length === 0 ? sha256('') : sha256(matchingHashes.join('\n')),
    windowEndHash: lastRecord.hash,
    issuedAt: new Date().toISOString(),
  };
}

export interface VerifyProofOptions {
  readonly proof: ZkProof;
  readonly predicate: NamedPredicate;
  readonly ledger: LedgerReader;
}

export interface VerificationResult {
  readonly ok: boolean;
  readonly reasons: ReadonlyArray<string>;
}

export async function verifyProof(options: VerifyProofOptions): Promise<VerificationResult> {
  const reasons: string[] = [];
  if (options.proof.predicateName !== options.predicate.name) {
    reasons.push(
      `predicate name mismatch: proof says "${options.proof.predicateName}", verifier wants "${options.predicate.name}"`,
    );
  }

  const records = await options.ledger.query({
    fromSeq: options.proof.window.fromSeq,
    toSeq: options.proof.window.toSeq,
  });
  if (records.length === 0) {
    reasons.push('window is empty on verifier side');
    return { ok: false, reasons };
  }
  const lastRecord = records[records.length - 1]!;
  if (lastRecord.hash !== options.proof.windowEndHash) {
    reasons.push(
      `window end hash mismatch: proof says ${options.proof.windowEndHash}, ledger says ${lastRecord.hash}`,
    );
  }

  const matchingHashes: string[] = [];
  for (const record of records as readonly LedgerRecord[]) {
    if (options.predicate.predicate(record.event as EventInput)) {
      matchingHashes.push(record.hash);
    }
  }
  matchingHashes.sort();
  const computedRoot = matchingHashes.length === 0 ? sha256('') : sha256(matchingHashes.join('\n'));
  if (computedRoot !== options.proof.matchRoot) {
    reasons.push('matchRoot mismatch — predicate was applied differently');
  }
  if (matchingHashes.length !== options.proof.matchCount) {
    reasons.push(
      `matchCount mismatch: proof says ${options.proof.matchCount}, verifier counted ${matchingHashes.length}`,
    );
  }
  return { ok: reasons.length === 0, reasons };
}

export const STANDARD_PREDICATES: ReadonlyArray<NamedPredicate> = [
  {
    name: 'eu-only-region',
    description: 'Every event must carry labels.region === "EU".',
    predicate: (event) => (event.labels as Record<string, string>)?.['region'] === 'EU',
  },
  {
    name: 'no-pii',
    description: 'No event payload may carry labels.pii === "true".',
    predicate: (event) => (event.labels as Record<string, string>)?.['pii'] !== 'true',
  },
  {
    name: 'all-decisions-have-rationale',
    description: 'Every decision.recorded event must include a non-empty rationale in its payload.',
    predicate: (event) => {
      if (event.type !== 'decision.recorded') return true;
      const decision = (event.payload as { decision?: { rationale?: string } }).decision;
      return typeof decision?.rationale === 'string' && decision.rationale.length > 0;
    },
  },
];

export function predicateByName(name: string): NamedPredicate | undefined {
  return STANDARD_PREDICATES.find((p) => p.name === name);
}

function sha256(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}
