import { buildServer, type BuildServerOptions } from './app.js';
import type { ApiKeyConfig, ServerRole } from './auth.js';

const port = Number(process.env['PORT'] ?? 8787);
const host = process.env['HOST'] ?? '0.0.0.0';

const options: BuildServerOptions = { logger: true };
const ledgerFile = process.env['VERITRAIL_LEDGER_FILE'];
if (ledgerFile) options.ledgerFile = ledgerFile;
const signerSecret = process.env['VERITRAIL_SIGNER_SECRET'];
if (signerSecret) options.signerSecret = signerSecret;
const apiKeys = parseApiKeys(process.env['VERITRAIL_API_KEYS']);
if (apiKeys.length > 0) options.auth = { apiKeys };

const app = await buildServer(options);

try {
  await app.listen({ port, host });
} catch (error) {
  app.log.error(error);
  process.exit(1);
}

function parseApiKeys(raw: string | undefined): ApiKeyConfig[] {
  if (!raw) return [];
  return raw
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
    .map((entry) => {
      const [id, actorId, secret, rolesRaw] = entry.split(':');
      if (!id || !actorId || !secret || !rolesRaw) {
        throw new Error('VERITRAIL_API_KEYS entries must be id:actorId:secret:role1|role2');
      }
      return {
        id,
        actorId,
        secret,
        roles: rolesRaw
          .split('|')
          .filter(
            (role): role is ServerRole =>
              role === 'ingest' || role === 'operator' || role === 'admin',
          ),
      };
    });
}
