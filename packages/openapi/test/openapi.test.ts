import { describe, expect, it } from 'vitest';
import { buildOpenApiSpec } from '../src/index.js';

const PUBLIC_PATHS = new Set([
  '/api',
  '/api/health',
  '/api/health/live',
  '/api/health/ready',
  '/api/metrics',
  '/api/metrics/prometheus',
  '/api/v1/control/magic-link/request',
  '/api/v1/control/magic-link/consume',
  '/api/v1/control/billing/webhook',
]);

const HTTP_METHODS = ['get', 'post', 'put', 'delete', 'patch'] as const;
type HttpMethod = (typeof HTTP_METHODS)[number];

/** Minimal structural typing for assertion helpers. */
interface OpEnvelope {
  readonly responses: Record<string, ResponseEnvelope>;
  readonly security?: ReadonlyArray<Record<string, readonly string[]>>;
}
interface ResponseEnvelope {
  readonly content?: Record<string, unknown>;
}

function methodsOf(pathItem: Record<string, unknown>): HttpMethod[] {
  return HTTP_METHODS.filter((m) => m in pathItem);
}

describe('buildOpenApiSpec', () => {
  it('declares OpenAPI 3.1.0', () => {
    expect(buildOpenApiSpec().openapi).toBe('3.1.0');
  });

  it('every documented path declares at least one HTTP method', () => {
    const spec = buildOpenApiSpec();
    for (const [path, item] of Object.entries(spec.paths)) {
      const ms = methodsOf(item as unknown as Record<string, unknown>);
      expect(ms.length, `path ${path} must have at least one method`).toBeGreaterThan(0);
    }
  });

  it('every method response declares application/json, text/plain, or text/event-stream content', () => {
    const spec = buildOpenApiSpec();
    for (const [path, item] of Object.entries(spec.paths)) {
      for (const method of methodsOf(item as unknown as Record<string, unknown>)) {
        const op = (item as unknown as Record<HttpMethod, OpEnvelope>)[method];
        for (const [status, raw] of Object.entries(op.responses)) {
          const resp = raw as ResponseEnvelope;
          const content = resp.content ?? {};
          const keys = Object.keys(content);
          const hasJson = keys.includes('application/json');
          const hasText = keys.includes('text/plain');
          const hasSse = keys.includes('text/event-stream');
          expect(
            hasJson || hasText || hasSse,
            `${method.toUpperCase()} ${path} ${status} must declare application/json, text/plain, or text/event-stream content`,
          ).toBe(true);
        }
      }
    }
  });

  it('exposes core schemas: EventInput, LedgerRecord, AuditSummary', () => {
    const spec = buildOpenApiSpec();
    expect(spec.components.schemas['EventInput']).toBeDefined();
    expect(spec.components.schemas['LedgerRecord']).toBeDefined();
    expect(spec.components.schemas['AuditSummary']).toBeDefined();
  });

  it('public endpoints omit the security field', () => {
    const spec = buildOpenApiSpec();
    for (const path of PUBLIC_PATHS) {
      const item = spec.paths[path];
      expect(item, `public path ${path} must be documented`).toBeDefined();
      for (const method of methodsOf(item as unknown as Record<string, unknown>)) {
        const op = (item as unknown as Record<HttpMethod, OpEnvelope>)[method];
        expect(
          op.security,
          `${method.toUpperCase()} ${path} must be unauthenticated`,
        ).toBeUndefined();
      }
    }
  });

  it('secured endpoints declare both ApiKeyAuth and BearerAuth', () => {
    const spec = buildOpenApiSpec();
    for (const [path, item] of Object.entries(spec.paths)) {
      if (PUBLIC_PATHS.has(path)) continue;
      for (const method of methodsOf(item as unknown as Record<string, unknown>)) {
        const op = (item as unknown as Record<HttpMethod, OpEnvelope>)[method];
        expect(op.security, `${method.toUpperCase()} ${path} must declare security`).toBeDefined();
        const schemes = (op.security ?? []).flatMap((s) => Object.keys(s));
        expect(schemes).toContain('ApiKeyAuth');
        expect(schemes).toContain('BearerAuth');
      }
    }
  });

  it('servers[0].url honors the baseUrl override', () => {
    const spec = buildOpenApiSpec({ baseUrl: 'https://example.test' });
    expect(spec.servers[0]?.url).toBe('https://example.test');
  });

  it('info.version honors the version override', () => {
    const spec = buildOpenApiSpec({ version: '2.5.0' });
    expect(spec.info.version).toBe('2.5.0');
  });

  it('documents all required paths', () => {
    const spec = buildOpenApiSpec();
    const required = [
      '/api',
      '/api/health',
      '/api/health/live',
      '/api/health/ready',
      '/api/metrics',
      '/api/metrics/prometheus',
      '/api/events',
      '/api/audit/events',
      '/api/audit/summary',
      '/api/audit/verify',
      '/api/spend/status',
      '/api/spend/authorize',
      '/api/permissions/evaluate',
      '/api/vendor-risk/assess',
      '/api/forensics/incident',
    ];
    for (const path of required) {
      expect(spec.paths[path], `missing path ${path}`).toBeDefined();
    }
  });

  it('documents all extension paths added by phases 5-7', () => {
    const spec = buildOpenApiSpec();
    const required = [
      '/api/v1/control/magic-link/request',
      '/api/v1/control/magic-link/consume',
      '/api/v1/control/api-keys/list',
      '/api/v1/control/api-keys/create',
      '/api/v1/control/api-keys/revoke',
      '/api/v1/control/usage',
      '/api/v1/control/billing/checkout',
      '/api/v1/control/billing/webhook',
      '/api/v1/control/webhooks/create',
      '/api/v1/control/webhooks/list',
      '/api/v1/control/webhooks/pause',
      '/api/v1/control/webhooks/resume',
      '/api/v1/control/webhooks/delete',
      '/api/v1/compliance/frameworks',
      '/api/v1/compliance/report',
      '/api/v1/receipt/anchor',
      '/api/v1/receipt/generate',
      '/api/v1/receipt/verify',
      '/api/v1/simulator/run',
      '/api/v1/rca/analyze',
      '/api/v1/cost-optimizer/forecast',
      '/api/audit/events/stream',
    ];
    for (const path of required) {
      expect(spec.paths[path], `missing path ${path}`).toBeDefined();
    }
  });

  it('extension paths declare the expected HTTP method', () => {
    const spec = buildOpenApiSpec();
    const postPaths = [
      '/api/v1/control/magic-link/request',
      '/api/v1/control/magic-link/consume',
      '/api/v1/control/api-keys/list',
      '/api/v1/control/api-keys/create',
      '/api/v1/control/api-keys/revoke',
      '/api/v1/control/usage',
      '/api/v1/control/billing/checkout',
      '/api/v1/control/billing/webhook',
      '/api/v1/control/webhooks/create',
      '/api/v1/control/webhooks/list',
      '/api/v1/control/webhooks/pause',
      '/api/v1/control/webhooks/resume',
      '/api/v1/control/webhooks/delete',
      '/api/v1/compliance/report',
      '/api/v1/receipt/anchor',
      '/api/v1/receipt/generate',
      '/api/v1/receipt/verify',
      '/api/v1/simulator/run',
      '/api/v1/rca/analyze',
      '/api/v1/cost-optimizer/forecast',
    ];
    for (const path of postPaths) {
      const item = spec.paths[path];
      expect(item, `path ${path} missing`).toBeDefined();
      const methods = methodsOf(item as unknown as Record<string, unknown>);
      expect(methods, `${path} must declare POST`).toEqual(['post']);
    }
    const getPaths = ['/api/v1/compliance/frameworks', '/api/audit/events/stream'];
    for (const path of getPaths) {
      const item = spec.paths[path];
      expect(item, `path ${path} missing`).toBeDefined();
      const methods = methodsOf(item as unknown as Record<string, unknown>);
      expect(methods, `${path} must declare GET`).toEqual(['get']);
    }
  });

  it('SSE stream endpoint uses text/event-stream content type', () => {
    const spec = buildOpenApiSpec();
    const item = spec.paths['/api/audit/events/stream'];
    expect(item).toBeDefined();
    const op = (item as unknown as Record<HttpMethod, OpEnvelope>).get;
    expect(op).toBeDefined();
    const ok = op.responses['200'] as ResponseEnvelope;
    expect(ok.content).toBeDefined();
    expect(Object.keys(ok.content ?? {})).toContain('text/event-stream');
  });

  it('top-level tags list includes every new tag with a description', () => {
    const spec = buildOpenApiSpec();
    expect(Array.isArray(spec.tags)).toBe(true);
    const tagNames = spec.tags.map((t) => t.name);
    const required = [
      'control-plane',
      'compliance',
      'receipt',
      'simulator',
      'rca',
      'cost-optimizer',
      'audit',
    ];
    for (const name of required) {
      expect(tagNames, `tags must include ${name}`).toContain(name);
      const tag = spec.tags.find((t) => t.name === name);
      expect(tag?.description, `tag ${name} must have description`).toBeTruthy();
    }
  });

  it('every operation tag is declared in the top-level tags list', () => {
    const spec = buildOpenApiSpec();
    const declared = new Set(spec.tags.map((t) => t.name));
    for (const [path, item] of Object.entries(spec.paths)) {
      for (const method of methodsOf(item as unknown as Record<string, unknown>)) {
        const op = (
          item as unknown as Record<HttpMethod, OpEnvelope & { tags?: readonly string[] }>
        )[method];
        for (const tag of op.tags ?? []) {
          expect(declared, `${method.toUpperCase()} ${path} uses undeclared tag ${tag}`).toContain(
            tag,
          );
        }
      }
    }
  });
});
