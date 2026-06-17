import { z } from 'zod';

const BinarySignatureSchema = z.custom<Buffer | Uint8Array | ArrayBuffer>(
  (value) => Buffer.isBuffer(value) || value instanceof Uint8Array || value instanceof ArrayBuffer,
);

export class ProviderSignerError extends Error {
  readonly provider: string;

  constructor(provider: string, message: string) {
    super(`${provider}: ${message}`);
    this.name = 'ProviderSignerError';
    this.provider = provider;
  }
}

export function signatureBuffer(provider: string, value: unknown): Buffer {
  const parsed = BinarySignatureSchema.safeParse(value);
  if (!parsed.success) {
    throw new ProviderSignerError(provider, 'sign response did not include a binary signature');
  }
  if (Buffer.isBuffer(parsed.data)) return parsed.data;
  if (parsed.data instanceof ArrayBuffer) return Buffer.from(parsed.data);
  return Buffer.from(parsed.data);
}
