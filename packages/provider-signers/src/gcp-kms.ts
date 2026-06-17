import type { RemoteSignerClient } from '@veritrail/core';

import { ProviderSignerError, signatureBuffer } from './errors.js';

export interface GcpKmsSignRequest {
  readonly name: string;
  readonly data: Uint8Array;
}

export interface GcpKmsSignResponse {
  readonly signature?: Uint8Array | string | null;
}

export interface GcpKmsClient {
  asymmetricSign(request: GcpKmsSignRequest): Promise<[GcpKmsSignResponse] | GcpKmsSignResponse>;
}

export interface GcpKmsRemoteSignerClientOptions {
  /** Full Cloud KMS crypto key version resource name. */
  readonly keyVersionName: string;
  /** `@google-cloud/kms` KeyManagementServiceClient-compatible object. */
  readonly client: GcpKmsClient;
}

/** GCP Cloud KMS implementation of core `RemoteSignerClient` for Ed25519 keys. */
export class GcpKmsRemoteSignerClient implements RemoteSignerClient {
  readonly #keyVersionName: string;
  readonly #client: GcpKmsClient;

  constructor(options: GcpKmsRemoteSignerClientOptions) {
    this.#keyVersionName = options.keyVersionName;
    this.#client = options.client;
  }

  async sign(data: Buffer): Promise<Buffer> {
    const response = await this.#client.asymmetricSign({
      name: this.#keyVersionName,
      data,
    });
    const result = Array.isArray(response) ? response[0] : response;
    if (typeof result.signature === 'string') {
      return Buffer.from(result.signature, 'base64');
    }
    if (result.signature === undefined || result.signature === null) {
      throw new ProviderSignerError('gcp-kms', 'sign response did not include signature');
    }
    return signatureBuffer('gcp-kms', result.signature);
  }
}
