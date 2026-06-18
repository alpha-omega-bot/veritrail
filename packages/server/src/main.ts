import { buildServer, type BuildServerOptions } from './app.js';
import { parseApiKeyEntries } from './auth.js';
import {
  DEFAULT_RATE_LIMIT_MAX,
  DEFAULT_RATE_LIMIT_WINDOW_MS,
  type ServerLimitsConfig,
} from './limits.js';

const port = Number(process.env['PORT'] ?? 8787);
const host = process.env['HOST'] ?? '0.0.0.0';

const options: BuildServerOptions = { logger: true };
const ledgerFile = process.env['VERITRAIL_LEDGER_FILE'];
if (ledgerFile) options.ledgerFile = ledgerFile;
const signerSecret = process.env['VERITRAIL_SIGNER_SECRET'];
if (signerSecret) options.signerSecret = signerSecret;
const apiKeys = parseApiKeyEntries(process.env['VERITRAIL_API_KEYS']);
if (apiKeys.length > 0) options.auth = { apiKeys };
options.limits = limitsFromEnv();

const app = await buildServer(options);

try {
  await app.listen({ port, host });
} catch (error) {
  app.log.error(error);
  process.exit(1);
}

function limitsFromEnv(): ServerLimitsConfig {
  const bodyLimitBytes = parsePositiveInt(process.env['VERITRAIL_BODY_LIMIT_BYTES']);
  const rateLimit = rateLimitFromEnv();
  const maxInFlightWrites = maxInFlightWritesFromEnv();
  return {
    ...(bodyLimitBytes !== undefined ? { bodyLimitBytes } : {}),
    ...(rateLimit !== undefined ? { rateLimit } : {}),
    ...(maxInFlightWrites !== undefined ? { maxInFlightWrites } : {}),
  };
}

function rateLimitFromEnv(): ServerLimitsConfig['rateLimit'] | undefined {
  const maxRaw = process.env['VERITRAIL_RATE_LIMIT_MAX'];
  if (maxRaw === '0') return false;
  const max = parsePositiveInt(maxRaw);
  const windowMs = parsePositiveInt(process.env['VERITRAIL_RATE_LIMIT_WINDOW_MS']);
  if (max === undefined && windowMs === undefined) return undefined;
  return {
    max: max ?? DEFAULT_RATE_LIMIT_MAX,
    windowMs: windowMs ?? DEFAULT_RATE_LIMIT_WINDOW_MS,
  };
}

function maxInFlightWritesFromEnv(): ServerLimitsConfig['maxInFlightWrites'] | undefined {
  const raw = process.env['VERITRAIL_MAX_IN_FLIGHT_WRITES'];
  if (raw === '0') return false;
  return parsePositiveInt(raw);
}

function parsePositiveInt(raw: string | undefined): number | undefined {
  if (!raw) return undefined;
  const value = Number(raw);
  return Number.isSafeInteger(value) && value > 0 ? value : undefined;
}
