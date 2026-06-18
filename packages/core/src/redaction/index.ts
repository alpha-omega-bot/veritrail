import type { EventInput } from '../domain/event.js';
import type { JsonValue } from '../util/canonical.js';

export interface EventRedactor {
  /** Return the event that should be committed to the ledger. */
  redact(event: EventInput): EventInput;
}

export interface RedactionRule {
  /** Dot path relative to the event object. Use `*` to match one object/array segment. */
  readonly path: string;
  /** Replacement value. Defaults to `[REDACTED]`. */
  readonly replacement?: JsonValue;
}

interface CompiledRule {
  readonly segments: readonly string[];
  readonly replacement: JsonValue;
}

const DEFAULT_REPLACEMENT = '[REDACTED]';

/**
 * JSON-path-like field redactor for event inputs. It runs at the append boundary
 * before hashing/signing, so sensitive fields never enter the committed record.
 */
export class PathEventRedactor implements EventRedactor {
  readonly #rules: readonly CompiledRule[];

  /** Create a redactor from dot-path rules evaluated against the full event object. */
  constructor(rules: readonly RedactionRule[]) {
    this.#rules = rules.map((rule) => ({
      segments: compilePath(rule.path),
      replacement: rule.replacement === undefined ? DEFAULT_REPLACEMENT : rule.replacement,
    }));
  }

  redact(event: EventInput): EventInput {
    let next: JsonValue = structuredClone(event) as JsonValue;
    for (const rule of this.#rules) {
      next = redactAt(next, rule.segments, rule.replacement);
    }
    return next as EventInput;
  }
}

function compilePath(path: string): readonly string[] {
  const segments = path.split('.').filter((segment) => segment.length > 0);
  if (segments.length === 0) {
    throw new Error('redaction path must contain at least one segment');
  }
  return segments;
}

function redactAt(
  value: JsonValue,
  segments: readonly string[],
  replacement: JsonValue,
): JsonValue {
  if (segments.length === 0) return replacement;
  if (Array.isArray(value)) {
    const head = segments[0]!;
    const tail = segments.slice(1);
    return value.map((item, index) => {
      if (head === '*' || head === String(index)) return redactAt(item, tail, replacement);
      return item;
    });
  }
  if (value === null || typeof value !== 'object') return value;

  const head = segments[0]!;
  const tail = segments.slice(1);
  const out: Record<string, JsonValue> = { ...value };
  if (head === '*') {
    for (const key of Object.keys(out)) {
      out[key] = redactAt(out[key]!, tail, replacement);
    }
    return out;
  }
  if (Object.prototype.hasOwnProperty.call(out, head)) {
    out[head] = redactAt(out[head]!, tail, replacement);
  }
  return out;
}
