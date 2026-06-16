/**
 * `@veritrail/server` — a Fastify REST API that mounts all eight governance
 * engines over one ledger. Use {@link buildServer} to construct an instance (for
 * embedding or tests) or run `veritrail-server` to start it.
 */
export { buildServer, type BuildServerOptions } from './app.js';
export {
  createPlatform,
  developmentLogger,
  type Platform,
  type PlatformOptions,
} from './platform.js';
