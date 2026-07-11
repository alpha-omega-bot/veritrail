# Veritrail Backup & Restore Utilities

Scripts for creating encrypted, verified backups of Veritrail ledgers.

## Backup Script

Creates compressed, optionally encrypted backups with integrity verification.

### Usage

```bash
# Basic backup (encrypted)
export VERITRAIL_BACKUP_PASSPHRASE="your-secure-passphrase"
tsx scripts/backup-ledger.ts /data/veritrail-ledger.jsonl /backups/veritrail-backup-$(date +%Y%m%d).gz

# Unencrypted backup
tsx scripts/backup-ledger.ts /data/veritrail-ledger.jsonl /backups/backup.gz --no-encrypt

# Skip verification (faster)
tsx scripts/backup-ledger.ts /data/veritrail-ledger.jsonl /backups/backup.gz --no-verify
```

### Features

- **Compression**: gzip level 9 for maximum compression
- **Encryption**: AES-256-CBC with passphrase-derived keys
- **Verification**: Integrity checks after backup
- **Metadata**: Stores backup timestamp and configuration
- **Checksums**: SHA-256 hashes for tamper detection

### Output

- `backup.gz` - Compressed/encrypted ledger data
- `backup.gz.meta` - Backup metadata (timestamp, encryption info)

## Restore Script

Restores compressed, encrypted backups with verification.

### Usage

```bash
# Basic restore (decrypts if needed)
export VERITRAIL_BACKUP_PASSPHRASE="your-secure-passphrase"
tsx scripts/restore-ledger.ts /backups/veritrail-backup-20260630.gz /data/veritrail-ledger.jsonl

# Force overwrite existing file
tsx scripts/restore-ledger.ts /backups/backup.gz /data/ledger.jsonl --force

# Skip verification (faster)
tsx scripts/restore-ledger.ts /backups/backup.gz /data/ledger.jsonl --no-verify
```

### Features

- **Decompression**: Automatic gzip decompression
- **Decryption**: AES-256-CBC with passphrase
- **Verification**: JSONL format validation
- **Safety**: Won't overwrite without --force
- **Checksums**: SHA-256 verification

## Automated Backups

### Cron Example

```bash
# Daily backup at 2:00 AM
0 2 * * * /usr/bin/env VERITRAIL_BACKUP_PASSPHRASE="..." tsx /app/scripts/backup-ledger.ts /data/veritrail-ledger.jsonl /backups/veritrail-$(date +\%Y\%m\%d).gz
```

### Docker Example

```yaml
services:
  backup:
    image: node:20-alpine
    volumes:
      - veritrail-data:/data:ro
      - backup-data:/backups
    environment:
      - VERITRAIL_BACKUP_PASSPHRASE=${BACKUP_PASSPHRASE}
    command: >
      sh -c "
        apk add --no-cache corepack &&
        corepack enable &&
        cd /app &&
        pnpm install &&
        pnpm tsx scripts/backup-ledger.ts /data/veritrail-ledger.jsonl /backups/backup-$(date +%Y%m%d).gz
      "
```

### Kubernetes CronJob

```yaml
apiVersion: batch/v1
kind: CronJob
metadata:
  name: veritrail-backup
  namespace: veritrail
spec:
  schedule: '0 2 * * *'
  jobTemplate:
    spec:
      template:
        spec:
          containers:
            - name: backup
              image: node:20-alpine
              volumeMounts:
                - name: data
                  mountPath: /data
                  readOnly: true
                - name: backups
                  mountPath: /backups
              env:
                - name: VERITRAIL_BACKUP_PASSPHRASE
                  valueFrom:
                    secretKeyRef:
                      name: backup-secrets
                      key: passphrase
              command:
                - sh
                - -c
                - |
                  apk add --no-cache git
                  git clone https://github.com/veritrail/veritrail /app
                  cd /app
                  corepack enable
                  pnpm install
                  pnpm tsx scripts/backup-ledger.ts /data/veritrail-ledger.jsonl /backups/backup-$(date +%Y%m%d).gz
          restartPolicy: OnFailure
          volumes:
            - name: data
              persistentVolumeClaim:
                claimName: veritrail-data
            - name: backups
              persistentVolumeClaim:
                claimName: veritrail-backups
```

## Best Practices

### Passphrase Management

- **Never hardcode**: Use environment variables or secrets management
- **Strong passphrases**: Minimum 32 characters, random
- **Rotation**: Rotate passphrases regularly
- **Storage**: Use Kubernetes Secrets, Vault, or similar

### Backup Strategy

- **3-2-1 Rule**: 3 copies, 2 different media, 1 offsite
- **Frequency**: Daily at minimum, hourly for critical systems
- **Retention**: Keep 7 daily, 4 weekly, 12 monthly
- **Testing**: Test restore process monthly
- **Monitoring**: Alert on backup failures

### Security

- **Encryption**: Always encrypt backups containing sensitive data
- **Access Control**: Restrict backup access to authorized personnel
- **Audit Logs**: Log all backup/restore operations
- **Verification**: Always verify backups after creation
- **Offsite Storage**: Store backups in different geographic location

## Troubleshooting

### Backup fails with "Ledger file not found"

Check the ledger path:

```bash
ls -l /data/veritrail-ledger.jsonl
```

### Restore fails with "Passphrase required"

Set the passphrase environment variable:

```bash
export VERITRAIL_BACKUP_PASSPHRASE="your-passphrase"
```

### "Output file already exists"

Use --force to overwrite:

```bash
tsx scripts/restore-ledger.ts backup.gz output.jsonl --force
```

### Verification fails

Check backup integrity:

```bash
sha256sum backup.gz
cat backup.gz.meta
```
