/**
 * `@veritrail/openapi` — OpenAPI 3.1 specification for the Veritrail server.
 *
 * The spec is hand-curated rather than auto-derived from Zod schemas because
 * the Zod-to-OpenAPI conversion path is brittle under our
 * `exactOptionalPropertyTypes` and discriminated-union patterns. The shape
 * exposed here is intentionally narrow: it covers the public REST surface that
 * the server exposes at `/api/openapi.json` and that the SDK generators
 * consume to produce typed clients.
 */
export { buildOpenApiSpec, type OpenApiSpec, type BuildOpenApiSpecOptions } from './spec.js';
