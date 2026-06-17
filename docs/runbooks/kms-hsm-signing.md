# KMS/HSM Signing Runbook

Veritrail can sign ledger records without loading the private key into the
process by using `RemoteEd25519Signer`. The signer delegates signing to a
remote key-custody client and verifies locally with trusted public keys, so
`Ledger.verify()` does not depend on KMS/HSM availability.

## Deployment Shape

1. Create an Ed25519 signing key in the chosen KMS/HSM provider.
2. Record a stable key id such as `kms-prod-2026-06`.
3. Export or register the public verification key for that key id.
4. Implement `RemoteSignerClient.sign(data: Buffer): Promise<Buffer>` by calling
   the provider's sign API for the configured key.
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
`@veritrail/core`. Keep AWS KMS, GCP Cloud KMS, Azure Key Vault, or HSM SDK usage
in edge packages or deployment code that implements `RemoteSignerClient`.
