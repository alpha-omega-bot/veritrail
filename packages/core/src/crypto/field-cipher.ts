import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

import type { EventInput } from '../domain/event.js';
import { notFoundError, validationError, type VeritrailError } from '../util/errors.js';
import { err, ok, type Result } from '../util/result.js';
import type { JsonValue } from '../util/canonical.js';
import type { EventRedactor } from '../redaction/index.js';

/**
 * Field-level encryption for PII at the append boundary, plus cryptographic
 * erasure by key destruction. See ADR-0005.
 *
 * A {@link FieldCipher} turns a plaintext string into an opaque, self-describing
 * token and back. Because encryption runs *before* hashing/signing (via
 * {@link EncryptingEventRedactor}), the committed record contains only the
 * ciphertext; destroying the key later renders the field unrecoverable without
 * mutating any record, so the hash chain stays intact and `verify()` still
 * passes.
 */
export interface FieldCipher {
  /** Stable identifier for the key this cipher encrypts with. */
  readonly keyId: string;
  /** Encrypt a plaintext string into a self-describing token. */
  encrypt(plaintext: string): string;
  /**
   * Decrypt a token produced by {@link encrypt}. Returns NOT_FOUND when the
   * token's key has been erased or is unknown, and VALIDATION when the token is
   * malformed or fails authentication. Never throws.
   */
  decrypt(token: string): Result<string, VeritrailError>;
}

const TOKEN_PREFIX = 'enc.v1';
const KEY_BYTES = 32; // AES-256
const IV_BYTES = 12; // GCM standard nonce length

/** Is this string an encrypted field token produced by this module? */
export function isEncryptedToken(value: unknown): value is string {
  return typeof value === 'string' && value.startsWith(`${TOKEN_PREFIX}.`);
}

function b64url(buf: Buffer): string {
  return buf.toString('base64url');
}

/**
 * In-memory AES-256-GCM keyring. Holds named keys and can encrypt with a
 * designated active key while decrypting any token whose key is still present
 * (so rotation works until a key is erased). The reference {@link FieldCipher}
 * adapter; production deployments implement {@link FieldCipher} over a KMS/HSM
 * where {@link eraseKey} maps to scheduled key deletion.
 */
export class AesGcmKeyring implements FieldCipher {
  readonly #keys = new Map<string, Buffer>();
  #activeKeyId: string;

  /**
   * @param keys      named 32-byte keys (Buffer or base64url string).
   * @param activeKeyId the key new encryptions use; defaults to the first key.
   */
  constructor(keys: Readonly<Record<string, Buffer | string>>, activeKeyId?: string) {
    const ids = Object.keys(keys);
    if (ids.length === 0) throw new Error('AesGcmKeyring: at least one key is required');
    for (const [id, material] of Object.entries(keys)) {
      const key = typeof material === 'string' ? Buffer.from(material, 'base64url') : material;
      if (key.length !== KEY_BYTES) {
        throw new Error(`AesGcmKeyring: key '${id}' must be ${KEY_BYTES} bytes`);
      }
      this.#keys.set(id, key);
    }
    const active = activeKeyId ?? ids[0]!;
    if (!this.#keys.has(active)) {
      throw new Error(`AesGcmKeyring: active key '${active}' is not in the keyring`);
    }
    this.#activeKeyId = active;
  }

  /** Generate a keyring with one fresh random key. */
  static generate(keyId = 'field-key-1'): AesGcmKeyring {
    return new AesGcmKeyring({ [keyId]: randomBytes(KEY_BYTES) }, keyId);
  }

  get keyId(): string {
    return this.#activeKeyId;
  }

  encrypt(plaintext: string): string {
    const key = this.#keys.get(this.#activeKeyId);
    if (!key) throw new Error(`AesGcmKeyring: active key '${this.#activeKeyId}' was erased`);
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return `${TOKEN_PREFIX}.${this.#activeKeyId}.${b64url(iv)}.${b64url(ct)}.${b64url(tag)}`;
  }

  decrypt(token: string): Result<string, VeritrailError> {
    const parts = token.split('.');
    // enc . v1 . keyId . iv . ct . tag
    if (parts.length !== 6 || `${parts[0]}.${parts[1]}` !== TOKEN_PREFIX) {
      return err(validationError('malformed encrypted field token'));
    }
    const keyId = parts[2]!;
    const key = this.#keys.get(keyId);
    if (!key) {
      // Key erased or never present: the plaintext is unrecoverable by design.
      return err(notFoundError('encryption key unavailable (possibly erased)', { keyId }));
    }
    try {
      const iv = Buffer.from(parts[3]!, 'base64url');
      const ct = Buffer.from(parts[4]!, 'base64url');
      const tag = Buffer.from(parts[5]!, 'base64url');
      const decipher = createDecipheriv('aes-256-gcm', key, iv);
      decipher.setAuthTag(tag);
      const pt = Buffer.concat([decipher.update(ct), decipher.final()]);
      return ok(pt.toString('utf8'));
    } catch {
      return err(validationError('encrypted field token failed authentication', { keyId }));
    }
  }

  /**
   * Cryptographically erase a key: once removed, every token encrypted with it is
   * permanently unrecoverable. The ledger records that referenced it are
   * untouched, so the hash chain and `verify()` are unaffected. Returns `true`
   * if a key was removed. Erasing the active key is allowed but disables further
   * encryption until a new active key is set.
   */
  eraseKey(keyId: string): boolean {
    return this.#keys.delete(keyId);
  }

  /** Add or rotate to a new active key. */
  setActiveKey(keyId: string, material: Buffer | string): void {
    const key = typeof material === 'string' ? Buffer.from(material, 'base64url') : material;
    if (key.length !== KEY_BYTES) throw new Error(`AesGcmKeyring: key must be ${KEY_BYTES} bytes`);
    this.#keys.set(keyId, key);
    this.#activeKeyId = keyId;
  }
}

interface CompiledPath {
  readonly segments: readonly string[];
}

/**
 * Append-boundary redactor that *encrypts* configured string fields rather than
 * blanking them. Runs before hashing/signing (same {@link EventRedactor}
 * contract as {@link PathEventRedactor}), so only ciphertext is committed.
 * Targeted fields must be strings; encrypting a non-string leaves it unchanged
 * (the subsequent schema re-validation is the backstop).
 */
export class EncryptingEventRedactor implements EventRedactor {
  readonly #cipher: FieldCipher;
  readonly #paths: readonly CompiledPath[];

  constructor(cipher: FieldCipher, paths: readonly string[]) {
    this.#cipher = cipher;
    this.#paths = paths.map((path) => ({ segments: compilePath(path) }));
  }

  redact(event: EventInput): EventInput {
    let next = structuredClone(event) as JsonValue;
    for (const path of this.#paths) {
      next = transformAt(next, path.segments, (leaf) =>
        typeof leaf === 'string' ? this.#cipher.encrypt(leaf) : leaf,
      );
    }
    return next as EventInput;
  }
}

/**
 * Recover encrypted fields on read: walk the same `paths` and replace each
 * encrypted token with its decrypted plaintext. Tokens whose key was erased (or
 * that fail to decrypt) are replaced with `onUnavailable` (default
 * `'[ERASED]'`), so an erased field is visibly gone rather than an opaque token.
 * Non-token values are left untouched.
 */
export function decryptEventFields(
  event: EventInput,
  cipher: FieldCipher,
  paths: readonly string[],
  onUnavailable: JsonValue = '[ERASED]',
): EventInput {
  let next = structuredClone(event) as JsonValue;
  for (const path of paths) {
    next = transformAt(next, compilePath(path), (leaf) => {
      if (!isEncryptedToken(leaf)) return leaf;
      const result = cipher.decrypt(leaf);
      return result.ok ? result.value : onUnavailable;
    });
  }
  return next as EventInput;
}

function compilePath(path: string): readonly string[] {
  const segments = path.split('.').filter((segment) => segment.length > 0);
  if (segments.length === 0) {
    throw new Error('encryption path must contain at least one segment');
  }
  return segments;
}

/** Apply `fn` to every leaf reached by `segments` (with `*` wildcard support). */
function transformAt(
  value: JsonValue,
  segments: readonly string[],
  fn: (leaf: JsonValue) => JsonValue,
): JsonValue {
  if (segments.length === 0) return fn(value);
  if (Array.isArray(value)) {
    const head = segments[0]!;
    const tail = segments.slice(1);
    return value.map((item, index) =>
      head === '*' || head === String(index) ? transformAt(item, tail, fn) : item,
    );
  }
  if (value === null || typeof value !== 'object') return value;

  const head = segments[0]!;
  const tail = segments.slice(1);
  const out: Record<string, JsonValue> = { ...value };
  if (head === '*') {
    for (const key of Object.keys(out)) out[key] = transformAt(out[key]!, tail, fn);
    return out;
  }
  if (Object.prototype.hasOwnProperty.call(out, head)) {
    out[head] = transformAt(out[head]!, tail, fn);
  }
  return out;
}
