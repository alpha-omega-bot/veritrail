/**
 * HTTP routes that expose `@veritrail/risk-network`.
 *
 * The risk network is a privacy-preserving cross-customer signal pool: orgs
 * contribute hashed observations of policy-denied patterns and can query
 * whether anyone else has seen the same pattern. Aggregates are filtered with
 * k-anonymity (`RECOMMENDED_K_ANON`) so a single contributor can never be
 * re-identified from a bucket.
 *
 * Contributions are persisted as `vendor.signal` ledger events: the raw
 * `RiskSignal` (which already contains only sha256 hashes) is JSON-encoded
 * into the `signal.summary` field, and an envelope label
 * `risk-network: 1` marks the record so queries can read it back without
 * conflating with operational vendor-risk signals.
 */

import { validationError, type LedgerReader, type LedgerWriter } from '@veritrail/core';
import {
  aggregateSignals,
  contributePattern,
  queryBucket,
  RECOMMENDED_K_ANON,
  type RiskSignal,
} from '@veritrail/risk-network';
import type { FastifyInstance } from 'fastify';

import { replyError } from './http.js';

/** Configuration for {@link registerRiskNetworkRoutes}. */
export interface RiskNetworkRoutesConfig {
  /** Ledger used for both appending contributions and reading them back. */
  readonly ledger: LedgerReader & LedgerWriter;
  /** Network-wide salt mixed into the contributor-id hash before persisting. */
  readonly orgSalt: string;
}

/** Marker label written on every risk-network-sourced `vendor.signal` event. */
const RISK_NETWORK_LABEL_KEY = 'risk-network';
const RISK_NETWORK_LABEL_VALUE = '1';

/** Stable sentinel vendorId used so the encoded signal satisfies `VendorSignalSchema`. */
const RISK_NETWORK_VENDOR_ID = 'risk-network';

/** Stable sentinel source string written into the vendor signal envelope. */
const RISK_NETWORK_SOURCE = 'risk-network';

/** Default actorId used when appending contributions. */
const RISK_NETWORK_ACTOR_ID = 'risk-network';

/** Hard cap on how many historical signals are aggregated per query. */
const QUERY_LIMIT = 10_000;

type Category = RiskSignal['category'];

const CATEGORIES: ReadonlySet<Category> = new Set([
  'prompt-injection',
  'unsafe-tool',
  'vendor-risk',
  'other',
]);

interface ContributionInput {
  readonly rawPattern: string;
  readonly category: Category;
  readonly orgId: string;
}

function parseContributions(value: unknown): ContributionInput[] | string {
  if (!Array.isArray(value)) return 'patterns must be an array';
  if (value.length === 0) return 'patterns must not be empty';
  const out: ContributionInput[] = [];
  for (let i = 0; i < value.length; i += 1) {
    const item = value[i];
    if (item === null || typeof item !== 'object') {
      return `patterns[${i}] must be an object`;
    }
    const { rawPattern, category, orgId } = item as Record<string, unknown>;
    if (typeof rawPattern !== 'string' || rawPattern.length === 0) {
      return `patterns[${i}].rawPattern must be a non-empty string`;
    }
    if (typeof category !== 'string' || !CATEGORIES.has(category as Category)) {
      return `patterns[${i}].category must be one of: ${[...CATEGORIES].join(', ')}`;
    }
    if (typeof orgId !== 'string' || orgId.length === 0) {
      return `patterns[${i}].orgId must be a non-empty string`;
    }
    out.push({ rawPattern, category: category as Category, orgId });
  }
  return out;
}

/**
 * Build the deterministic id used on the encoded `vendor.signal` event.
 * The id is unique per (patternHash, contributorIdHash, observedAt) tuple so
 * two identical contributions appended in the same millisecond still produce
 * distinct events; trailing entropy is harmless because the id is never
 * surfaced to clients.
 */
function encodedSignalId(signal: RiskSignal): string {
  return `rn_${signal.patternHash.slice(0, 16)}_${signal.contributorIdHash.slice(0, 16)}_${signal.observedAt}`;
}

/**
 * Try to decode a `vendor.signal` payload back into a `RiskSignal`. Returns
 * null for any payload that wasn't produced by this route (raw operational
 * vendor signals, malformed JSON, missing fields, unknown category).
 */
function decodeSignal(payload: unknown): RiskSignal | null {
  if (payload === null || typeof payload !== 'object') return null;
  const signal = (payload as { signal?: unknown }).signal;
  if (signal === null || typeof signal !== 'object') return null;
  const summary = (signal as { summary?: unknown }).summary;
  if (typeof summary !== 'string') return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(summary);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== 'object') return null;
  const { patternHash, category, observedAt, contributorIdHash } = parsed as Record<
    string,
    unknown
  >;
  if (typeof patternHash !== 'string' || patternHash.length === 0) return null;
  if (typeof category !== 'string' || !CATEGORIES.has(category as Category)) return null;
  if (typeof observedAt !== 'number' || !Number.isFinite(observedAt)) return null;
  if (typeof contributorIdHash !== 'string' || contributorIdHash.length === 0) return null;
  return {
    patternHash,
    category: category as Category,
    observedAt,
    contributorIdHash,
  };
}

/**
 * Register the risk-network routes on a Fastify instance. Mounts:
 *
 * - `POST /api/v1/risk-network/contribute` — hash a batch of `{ rawPattern,
 *   category, orgId }` observations into `RiskSignal`s, append each as a
 *   `vendor.signal` ledger event, and echo the produced signals.
 * - `POST /api/v1/risk-network/query`      — aggregate every risk-network
 *   `vendor.signal` event in the ledger (up to {@link QUERY_LIMIT}) and
 *   return the bucket matching `patternHash`, or `{ bucket: null, k }` when
 *   no bucket clears the k-anonymity threshold.
 */
export function registerRiskNetworkRoutes(
  app: FastifyInstance,
  opts: RiskNetworkRoutesConfig,
): void {
  const { ledger, orgSalt } = opts;

  app.post('/api/v1/risk-network/contribute', async (request, reply) => {
    const body = (request.body ?? {}) as { patterns?: unknown };
    const parsed = parseContributions(body.patterns);
    if (typeof parsed === 'string') {
      return replyError(reply, validationError(parsed));
    }

    const signals: RiskSignal[] = [];
    for (const input of parsed) {
      const signal = contributePattern({
        rawPattern: input.rawPattern,
        category: input.category,
        orgId: input.orgId,
        salt: orgSalt,
      });
      const append = await ledger.append({
        type: 'vendor.signal',
        actorId: RISK_NETWORK_ACTOR_ID,
        labels: { [RISK_NETWORK_LABEL_KEY]: RISK_NETWORK_LABEL_VALUE },
        payload: {
          signal: {
            id: encodedSignalId(signal),
            vendorId: RISK_NETWORK_VENDOR_ID,
            kind: 'other',
            severity: 'info',
            summary: JSON.stringify(signal),
            source: RISK_NETWORK_SOURCE,
            observedAt: signal.observedAt,
          },
        },
      });
      if (!append.ok) return replyError(reply, append.error);
      signals.push(signal);
    }

    return reply.send({ contributed: signals.length, signals });
  });

  app.post('/api/v1/risk-network/query', async (request, reply) => {
    const body = (request.body ?? {}) as { patternHash?: unknown };
    const patternHash = body.patternHash;
    if (typeof patternHash !== 'string' || patternHash.length === 0) {
      return replyError(reply, validationError('patternHash must be a non-empty string'));
    }

    const records = await ledger.query({
      types: ['vendor.signal'],
      labels: { [RISK_NETWORK_LABEL_KEY]: RISK_NETWORK_LABEL_VALUE },
      limit: QUERY_LIMIT,
    });

    const signals: RiskSignal[] = [];
    for (const record of records) {
      const decoded = decodeSignal(record.event.payload);
      if (decoded) signals.push(decoded);
    }

    const buckets = aggregateSignals(signals);
    const bucket = queryBucket(buckets, patternHash);
    if (!bucket) {
      return reply.send({ bucket: null, k: RECOMMENDED_K_ANON });
    }
    return reply.send(bucket);
  });
}
