import { createHash } from 'node:crypto';

/**
 * A single anonymized observation of a policy-denied pattern, suitable for
 * cross-customer aggregation. The raw prompt and orgId are never present;
 * only stable sha256 hashes are exposed.
 */
export interface RiskSignal {
  readonly patternHash: string;
  readonly category: 'prompt-injection' | 'unsafe-tool' | 'vendor-risk' | 'other';
  readonly observedAt: number;
  readonly contributorIdHash: string;
}

/**
 * Aggregated risk signal for a single (patternHash, category) pair. Surfaces
 * how many distinct contributors saw the pattern and how often, after k-anonymity
 * filtering. Never contains raw data.
 */
export interface RiskBucket {
  readonly patternHash: string;
  readonly category: RiskSignal['category'];
  readonly firstObservedMs: number;
  readonly lastObservedMs: number;
  readonly contributorCount: number;
  readonly observationCount: number;
}

/**
 * Minimum number of distinct contributors required for a bucket to be exposed.
 * Buckets below this threshold are dropped entirely to prevent re-identification
 * of any single contributor.
 */
export const RECOMMENDED_K_ANON = 5;

/**
 * Input to {@link contributePattern}. The salt is a network-wide shared secret
 * that prevents an attacker who learns one orgId from rainbow-table mapping
 * contributorIdHash back to an orgId.
 */
export interface ContributePatternInput {
  readonly rawPattern: string;
  readonly category: RiskSignal['category'];
  readonly orgId: string;
  readonly salt: string;
}

function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

/**
 * Pure function that converts a raw policy-denied pattern observation into a
 * shareable {@link RiskSignal}. Hashes the pattern and the salted orgId so the
 * resulting signal contains no recoverable raw data. The observedAt timestamp
 * is set to Date.now() at call time.
 */
export function contributePattern(input: ContributePatternInput): RiskSignal {
  const { rawPattern, category, orgId, salt } = input;
  return {
    patternHash: sha256Hex(rawPattern),
    category,
    observedAt: Date.now(),
    contributorIdHash: sha256Hex(`${orgId}${salt}`),
  };
}

/**
 * Aggregate a stream of signals into buckets grouped by (patternHash, category).
 * Counts distinct contributorIdHash values (not raw signal count) for the
 * contributorCount field. Applies k-anonymity using {@link RECOMMENDED_K_ANON}:
 * buckets with fewer than k distinct contributors are dropped entirely from the
 * result so a single contributor can never be re-identified. Result is sorted
 * by lastObservedMs descending.
 */
export function aggregateSignals(signals: ReadonlyArray<RiskSignal>): ReadonlyArray<RiskBucket> {
  const grouped = new Map<
    string,
    {
      patternHash: string;
      category: RiskSignal['category'];
      firstObservedMs: number;
      lastObservedMs: number;
      contributors: Set<string>;
      observationCount: number;
    }
  >();

  for (const signal of signals) {
    const key = `${signal.patternHash}:${signal.category}`;
    const existing = grouped.get(key);
    if (existing) {
      existing.contributors.add(signal.contributorIdHash);
      existing.observationCount += 1;
      if (signal.observedAt < existing.firstObservedMs) {
        existing.firstObservedMs = signal.observedAt;
      }
      if (signal.observedAt > existing.lastObservedMs) {
        existing.lastObservedMs = signal.observedAt;
      }
    } else {
      grouped.set(key, {
        patternHash: signal.patternHash,
        category: signal.category,
        firstObservedMs: signal.observedAt,
        lastObservedMs: signal.observedAt,
        contributors: new Set([signal.contributorIdHash]),
        observationCount: 1,
      });
    }
  }

  const buckets: RiskBucket[] = [];
  for (const entry of grouped.values()) {
    if (entry.contributors.size < RECOMMENDED_K_ANON) continue;
    buckets.push({
      patternHash: entry.patternHash,
      category: entry.category,
      firstObservedMs: entry.firstObservedMs,
      lastObservedMs: entry.lastObservedMs,
      contributorCount: entry.contributors.size,
      observationCount: entry.observationCount,
    });
  }

  buckets.sort((a, b) => b.lastObservedMs - a.lastObservedMs);
  return buckets;
}

/**
 * Convenience lookup that returns the first bucket matching the given
 * patternHash, or null if none exists. Useful for "has anyone else seen this?"
 * queries from a new customer's perspective.
 */
export function queryBucket(
  buckets: ReadonlyArray<RiskBucket>,
  patternHash: string,
): RiskBucket | null {
  return buckets.find((b) => b.patternHash === patternHash) ?? null;
}
