import { buildServer, type BuildServerOptions } from './app.js';

const port = Number(process.env['PORT'] ?? 8787);
const host = process.env['HOST'] ?? '0.0.0.0';

const options: BuildServerOptions = { logger: true };
const ledgerFile = process.env['VERITRAIL_LEDGER_FILE'];
if (ledgerFile) options.ledgerFile = ledgerFile;
const signerSecret = process.env['VERITRAIL_SIGNER_SECRET'];
if (signerSecret) options.signerSecret = signerSecret;

const app = await buildServer(options);

try {
  await app.listen({ port, host });
} catch (error) {
  app.log.error(error);
  process.exit(1);
}
