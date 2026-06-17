import type { RemoteSignerClient } from '@veritrail/core';

import { ProviderSignerError, signatureBuffer } from './errors.js';

export interface AwsKmsSignCommandInput {
  readonly KeyId: string;
  readonly Message: Uint8Array;
  readonly MessageType: 'RAW' | 'DIGEST';
  readonly SigningAlgorithm: 'ED25519_SHA_512';
}

export interface AwsKmsSignCommandOutput {
  readonly Signature?: Uint8Array;
}

export type AwsKmsSignCommandType = new (input: AwsKmsSignCommandInput) => unknown;

export interface AwsKmsClient {
  send(command: unknown): Promise<AwsKmsSignCommandOutput>;
}

export interface AwsKmsRemoteSignerClientOptions {
  /** AWS KMS asymmetric Ed25519 key id or ARN. */
  readonly keyId: string;
  /** `@aws-sdk/client-kms` KMSClient-compatible object. */
  readonly client: AwsKmsClient;
  /** `SignCommand` constructor from `@aws-sdk/client-kms`. */
  readonly SignCommand: AwsKmsSignCommandType;
}

/** AWS KMS implementation of core `RemoteSignerClient` for Ed25519 keys. */
export class AwsKmsRemoteSignerClient implements RemoteSignerClient {
  readonly #keyId: string;
  readonly #client: AwsKmsClient;
  readonly #SignCommand: AwsKmsSignCommandType;

  constructor(options: AwsKmsRemoteSignerClientOptions) {
    this.#keyId = options.keyId;
    this.#client = options.client;
    this.#SignCommand = options.SignCommand;
  }

  async sign(data: Buffer): Promise<Buffer> {
    const command = new this.#SignCommand({
      KeyId: this.#keyId,
      Message: data,
      MessageType: 'RAW',
      SigningAlgorithm: 'ED25519_SHA_512',
    });
    const response = await this.#client.send(command);
    if (response.Signature === undefined) {
      throw new ProviderSignerError('aws-kms', 'sign response did not include Signature');
    }
    return signatureBuffer('aws-kms', response.Signature);
  }
}
