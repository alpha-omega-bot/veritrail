/**
 * Deterministic JSON canonicalization.
 *
 * The ledger's tamper-evidence depends on hashing a *stable* byte representation
 * of each record: the same logical value must always serialize to exactly the
 * same string, regardless of object key insertion order. `JSON.stringify` does
 * not guarantee this (key order is insertion order), so we implement a canonical
 * form with lexicographically sorted object keys and no insignificant whitespace.
 *
 * Non-finite numbers (NaN, Infinity) are rejected: they have no portable JSON
 * representation and would make hashes non-reproducible across runtimes.
 */

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };

export function canonicalize(value: JsonValue): string {
  return serialize(value);
}

function serialize(value: JsonValue): string {
  if (value === null) return 'null';

  switch (typeof value) {
    case 'boolean':
      return value ? 'true' : 'false';
    case 'number':
      if (!Number.isFinite(value)) {
        throw new Error(`canonicalize: cannot serialize non-finite number ${String(value)}`);
      }
      return JSON.stringify(value);
    case 'string':
      return JSON.stringify(value);
    case 'object': {
      if (Array.isArray(value)) {
        return `[${value.map(serialize).join(',')}]`;
      }
      const keys = Object.keys(value).sort();
      const parts: string[] = [];
      for (const key of keys) {
        const entry = value[key];
        // Skip keys whose value is `undefined` (mirrors JSON.stringify) so that
        // an explicit `undefined` and an absent key hash identically.
        if (entry === undefined) continue;
        parts.push(`${JSON.stringify(key)}:${serialize(entry)}`);
      }
      return `{${parts.join(',')}}`;
    }
    default:
      throw new Error(`canonicalize: unsupported value of type ${typeof value}`);
  }
}

/**
 * Best-effort structural conversion of an arbitrary value into a `JsonValue`.
 * Used at trust boundaries where a value is known to be JSON-compatible by
 * construction (e.g. a Zod-validated event). Throws on values that cannot be
 * represented as JSON.
 */
export function asJson(value: unknown): JsonValue {
  return coerce(value);
}

function coerce(value: unknown): JsonValue {
  if (value === null) return null;
  switch (typeof value) {
    case 'boolean':
    case 'string':
      return value;
    case 'number':
      if (!Number.isFinite(value)) {
        throw new Error('asJson: non-finite number is not JSON-representable');
      }
      return value;
    case 'object': {
      if (Array.isArray(value)) return value.map(coerce);
      const out: JsonObject = {};
      for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
        if (entry === undefined) continue;
        out[key] = coerce(entry);
      }
      return out;
    }
    default:
      throw new Error(`asJson: cannot represent value of type ${typeof value} as JSON`);
  }
}
