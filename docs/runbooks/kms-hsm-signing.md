# KMS/HSM Signing Runbook

Veritrail can sign ledger records without loading the private key into the
process by using `RemoteEd25519Signer`. The signer delegates signing to a
remote key-custody client and verifies locally with trusted public keys, so
`Ledger.verify()` does not depend on KMS/HSM availability.

## Deployment Shape

1. Create an Ed25519 signing key in the chosen KMS/HSM provider.
2. Record a stable key id such as `kms-prod-2026-06`.
3. Export or register the public verification key for that key id.
4. Use a provider adapter from `@veritrail/provider-signers`, or implement
   `RemoteSignerClient.sign(data: Buffer): Promise<Buffer>` in deployment code.
5. Construct the ledger with `RemoteEd25519Signer`.

```ts
import { Ledger, RemoteEd25519Signer } from '@veritrail/core';

const signer = new RemoteEd25519Signer({
  keyId: 'kms-prod-2026-06',
  client: kmsClient,
  publicKey: publicKeyPem,
  trustedPublicKeys: {
    'kms-prod-2026-03': previousPublicKeyPem,
  },
});

const ledger = new Ledger({ store, signer });
```

## Rotation

- Create the new remote Ed25519 key.
- Deploy the new `keyId` and public key for signing.
- Keep previous public keys in `trustedPublicKeys` until all retained ledger
  records signed by those keys are outside the audit retention window.
- Verify the ledger after deployment; records signed with old keys should still
  pass because verification uses each record's `signerKeyId`.

## Failure Behavior

If the remote signer cannot produce a signature, `Ledger.append()` returns a
`STORAGE` error and does not persist the record. Operators should alert on
append signing failures because the system has stopped accepting signed writes.

## Provider Wrappers

Provider-specific SDK packages are intentionally not dependencies of
`@veritrail/core`. The `@veritrail/provider-signers` package provides thin
`RemoteSignerClient` adapters around SDK-compatible client shapes:

- `AwsKmsRemoteSignerClient` wraps `@aws-sdk/client-kms` `KMSClient` +
  `SignCommand` and uses `ED25519_SHA_512` with `MessageType: 'RAW'`.
- `GcpKmsRemoteSignerClient` wraps a Cloud KMS
  `KeyManagementServiceClient.asymmetricSign` call.
- `AzureKeyVaultRemoteSignerClient` wraps a Key Vault
  `CryptographyClient.signData` call.
- `HsmRemoteSignerClient` wraps a generic HSM/PKCS#11-shaped session with
  `sign(keyHandle, data, mechanism)`.

Install only the SDKs used by your deployment and pass their clients into these
adapters; Veritrail does not bundle every cloud SDK into the trust core.
