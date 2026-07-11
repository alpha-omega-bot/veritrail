/**
 * Hand-curated OpenAPI 3.1 specification for the Veritrail server REST API.
 *
 * Auto-derivation from Zod is intentionally avoided: the resulting spec is
 * brittle under `exactOptionalPropertyTypes` and our discriminated-union
 * envelopes (e.g. `EventInput.type`). A small, owned surface here is easier
 * to keep correct than a fragile derivation pipeline.
 */

/** Generic JSON-shaped value used wherever the OpenAPI spec carries
 * heterogeneous structured data. The spec object is plain JSON. */
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | { readonly [key: string]: JsonValue }
  | readonly JsonValue[];

/** Top-level OpenAPI 3.1 document shape returned by {@link buildOpenApiSpec}. */
export interface OpenApiSpec {
  readonly openapi: '3.1.0';
  readonly info: {
    readonly title: string;
    readonly version: string;
    readonly description: string;
  };
  readonly servers: ReadonlyArray<{ readonly url: string; readonly description?: string }>;
  readonly paths: { readonly [path: string]: PathItem };
  readonly tags: ReadonlyArray<{ readonly name: string; readonly description?: string }>;
  readonly components: {
    readonly schemas: { readonly [name: string]: JsonValue };
    readonly securitySchemes: { readonly [name: string]: JsonValue };
  };
}

/** A single path item: a map of HTTP method to operation. Public paths omit
 * the `security` field; secured paths include both API-key and bearer options. */
export interface PathItem {
  readonly get?: Operation;
  readonly post?: Operation;
  readonly put?: Operation;
  readonly delete?: Operation;
  readonly patch?: Operation;
}

/** A single OpenAPI operation. `security: []` means the route is documented
 * as explicitly public; an absent `security` field means "inherit nothing"
 * — we use absence to mark public routes and presence for protected ones. */
export interface Operation {
  readonly summary: string;
  readonly description?: string;
  readonly tags?: readonly string[];
  readonly parameters?: readonly JsonValue[];
  readonly requestBody?: JsonValue;
  readonly responses: { readonly [status: string]: JsonValue };
  readonly security?: ReadonlyArray<{ readonly [scheme: string]: readonly string[] }>;
}

/** Options accepted by {@link buildOpenApiSpec}. */
export interface BuildOpenApiSpecOptions {
  /** Semver version string emitted in `info.version`. Defaults to `0.1.0`. */
  readonly version?: string;
  /** Server URL emitted in `servers[0].url`. Defaults to `https://api.veritrail.dev`. */
  readonly baseUrl?: string;
}

const SECURITY_BOTH: ReadonlyArray<{ readonly [scheme: string]: readonly string[] }> = [
  { ApiKeyAuth: [] },
  { BearerAuth: [] },
];

const JSON_RESPONSE = (schemaRef: string, description: string): JsonValue => ({
  description,
  content: {
    'application/json': {
      schema: { $ref: `#/components/schemas/${schemaRef}` },
    },
  },
});

const JSON_INLINE = (schema: JsonValue, description: string): JsonValue => ({
  description,
  content: {
    'application/json': { schema },
  },
});

const TEXT_RESPONSE = (description: string): JsonValue => ({
  description,
  content: {
    'text/plain': {
      schema: { type: 'string' },
    },
  },
});

const ERROR_RESPONSE = (description: string): JsonValue => ({
  description,
  content: {
    'application/json': {
      schema: { $ref: '#/components/schemas/Error' },
    },
  },
});

const QUERY_PARAM = (
  name: string,
  schema: JsonValue,
  description: string,
  required = false,
): JsonValue => ({
  name,
  in: 'query',
  required,
  description,
  schema,
});

/**
 * Build the OpenAPI 3.1 spec for the Veritrail server.
 *
 * @param options Optional overrides for the `info.version` and `servers[0].url`
 *                fields. Both fall back to sensible defaults.
 * @returns A plain JSON-serializable object suitable for `JSON.stringify` and
 *          for direct delivery from `/api/openapi.json`.
 */
export function buildOpenApiSpec(options?: BuildOpenApiSpecOptions): OpenApiSpec {
  const version = options?.version ?? '0.1.0';
  const baseUrl = options?.baseUrl ?? 'https://api.veritrail.dev';

  return {
    openapi: '3.1.0',
    info: {
      title: 'Veritrail API',
      version,
      description:
        'Tamper-evident audit ledger, policy enforcement, and governance primitives for AI agent operations. The API exposes append-only event ingestion, audit query and integrity verification, spend governance, permission evaluation, vendor risk scoring, and incident forensics.',
    },
    servers: [{ url: baseUrl, description: 'Veritrail server' }],
    paths: {
      '/api': {
        get: {
          summary: 'API service descriptor',
          description: 'Returns service metadata: name, version, and documented endpoints.',
          tags: ['meta'],
          responses: {
            '200': JSON_INLINE(
              {
                type: 'object',
                required: ['name', 'version'],
                properties: {
                  name: { type: 'string' },
                  version: { type: 'string' },
                  endpoints: { type: 'array', items: { type: 'string' } },
                },
              },
              'Service descriptor',
            ),
          },
        },
      },
      '/api/health': {
        get: {
          summary: 'Aggregate health check',
          description: 'Returns combined liveness and readiness status for the server.',
          tags: ['health'],
          responses: {
            '200': JSON_RESPONSE('HealthStatus', 'Server is healthy'),
            '503': JSON_RESPONSE('HealthStatus', 'Server is unhealthy'),
          },
        },
      },
      '/api/health/live': {
        get: {
          summary: 'Liveness probe',
          description: 'Returns 200 if the process is running. Used by Kubernetes liveness probes.',
          tags: ['health'],
          responses: {
            '200': JSON_RESPONSE('HealthStatus', 'Process is alive'),
          },
        },
      },
      '/api/health/ready': {
        get: {
          summary: 'Readiness probe',
          description:
            'Returns 200 if the server is ready to accept traffic (storage reachable, ledger initialized). Used by Kubernetes readiness probes.',
          tags: ['health'],
          responses: {
            '200': JSON_RESPONSE('HealthStatus', 'Server is ready'),
            '503': JSON_RESPONSE('HealthStatus', 'Server is not ready'),
          },
        },
      },
      '/api/metrics': {
        get: {
          summary: 'JSON metrics snapshot',
          description: 'Returns the in-process metrics registry as a JSON document.',
          tags: ['metrics'],
          responses: {
            '200': JSON_INLINE(
              {
                type: 'object',
                additionalProperties: true,
              },
              'Metrics snapshot',
            ),
          },
        },
      },
      '/api/metrics/prometheus': {
        get: {
          summary: 'Prometheus metrics',
          description: 'Returns metrics in the Prometheus text exposition format.',
          tags: ['metrics'],
          responses: {
            '200': TEXT_RESPONSE('Prometheus exposition'),
          },
        },
      },
      '/api/events': {
        post: {
          summary: 'Append an event to the ledger',
          description:
            'Append a validated event to the tamper-evident hash-chained ledger. Returns the resulting LedgerRecord.',
          tags: ['events'],
          security: SECURITY_BOTH,
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/EventInput' },
              },
            },
          },
          responses: {
            '201': JSON_RESPONSE('LedgerRecord', 'Event appended'),
            '400': ERROR_RESPONSE('Invalid event payload'),
            '401': ERROR_RESPONSE('Missing or invalid credentials'),
          },
        },
      },
      '/api/audit/events': {
        get: {
          summary: 'Query audit events',
          description:
            'Page through ledger records filtered by sequence range, event type, actor, or correlation id.',
          tags: ['audit'],
          security: SECURITY_BOTH,
          parameters: [
            QUERY_PARAM(
              'fromSeq',
              { type: 'integer', minimum: 0 },
              'Inclusive lower sequence bound',
            ),
            QUERY_PARAM('toSeq', { type: 'integer', minimum: 0 }, 'Inclusive upper sequence bound'),
            QUERY_PARAM('type', { type: 'string' }, 'Filter by event type discriminator'),
            QUERY_PARAM('actorId', { type: 'string' }, 'Filter by actor id'),
            QUERY_PARAM('correlationId', { type: 'string' }, 'Filter by correlation id'),
            QUERY_PARAM(
              'limit',
              { type: 'integer', minimum: 1, maximum: 1000 },
              'Maximum records to return (default 100)',
            ),
          ],
          responses: {
            '200': JSON_INLINE(
              {
                type: 'object',
                required: ['records'],
                properties: {
                  records: {
                    type: 'array',
                    items: { $ref: '#/components/schemas/LedgerRecord' },
                  },
                  nextSeq: { type: 'integer', nullable: true },
                },
              },
              'Page of ledger records',
            ),
            '401': ERROR_RESPONSE('Missing or invalid credentials'),
          },
        },
      },
      '/api/audit/summary': {
        get: {
          summary: 'Audit summary',
          description:
            'Return aggregate statistics for the ledger: total record count, head sequence, and the head hash.',
          tags: ['audit'],
          security: SECURITY_BOTH,
          responses: {
            '200': JSON_RESPONSE('AuditSummary', 'Audit summary'),
            '401': ERROR_RESPONSE('Missing or invalid credentials'),
          },
        },
      },
      '/api/audit/verify': {
        get: {
          summary: 'Verify ledger integrity',
          description:
            'Recompute the hash chain end-to-end and report whether the ledger is intact. A non-ok response identifies the first divergent record.',
          tags: ['audit'],
          security: SECURITY_BOTH,
          responses: {
            '200': JSON_INLINE(
              {
                type: 'object',
                required: ['ok'],
                properties: {
                  ok: { type: 'boolean' },
                  firstBadSeq: { type: 'integer', nullable: true },
                  message: { type: 'string' },
                },
              },
              'Verification result',
            ),
            '401': ERROR_RESPONSE('Missing or invalid credentials'),
          },
        },
      },
      '/api/spend/status': {
        get: {
          summary: 'Spend status',
          description:
            'Return the current spend window: cap, consumed amount, and remaining headroom.',
          tags: ['spend'],
          security: SECURITY_BOTH,
          responses: {
            '200': JSON_RESPONSE('SpendStatus', 'Spend status'),
            '401': ERROR_RESPONSE('Missing or invalid credentials'),
          },
        },
      },
      '/api/spend/authorize': {
        post: {
          summary: 'Authorize a prospective spend',
          description:
            'Check whether a prospective action with a quoted price is within the spend cap. Does not reserve funds.',
          tags: ['spend'],
          security: SECURITY_BOTH,
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['action', 'price'],
                  properties: {
                    action: { $ref: '#/components/schemas/Action' },
                    price: { $ref: '#/components/schemas/Money' },
                  },
                },
              },
            },
          },
          responses: {
            '200': JSON_INLINE(
              {
                type: 'object',
                required: ['authorized'],
                properties: {
                  authorized: { type: 'boolean' },
                  remaining: { $ref: '#/components/schemas/Money' },
                  reason: { type: 'string' },
                },
              },
              'Authorization decision',
            ),
            '400': ERROR_RESPONSE('Invalid request payload'),
            '401': ERROR_RESPONSE('Missing or invalid credentials'),
          },
        },
      },
      '/api/permissions/evaluate': {
        post: {
          summary: 'Evaluate a policy against an action',
          description:
            'Return the policy decision (allow, deny, or require-approval) for a candidate action and the matched rule.',
          tags: ['permissions'],
          security: SECURITY_BOTH,
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['policy', 'action'],
                  properties: {
                    policy: { $ref: '#/components/schemas/Policy' },
                    action: { $ref: '#/components/schemas/Action' },
                  },
                },
              },
            },
          },
          responses: {
            '200': JSON_INLINE(
              {
                type: 'object',
                required: ['decision'],
                properties: {
                  decision: { type: 'string', enum: ['allow', 'deny', 'require-approval'] },
                  matchedRuleId: { type: 'string' },
                  reason: { type: 'string' },
                },
              },
              'Policy decision',
            ),
            '400': ERROR_RESPONSE('Invalid request payload'),
            '401': ERROR_RESPONSE('Missing or invalid credentials'),
          },
        },
      },
      '/api/vendor-risk/assess': {
        get: {
          summary: 'Vendor risk assessment',
          description:
            'Return the most recent vendor risk score for a given vendor id, drawn from cached provider monitor signals.',
          tags: ['vendor-risk'],
          security: SECURITY_BOTH,
          parameters: [QUERY_PARAM('vendorId', { type: 'string' }, 'Vendor identifier', true)],
          responses: {
            '200': JSON_RESPONSE('VendorRiskScore', 'Vendor risk score'),
            '401': ERROR_RESPONSE('Missing or invalid credentials'),
            '404': ERROR_RESPONSE('Vendor not found'),
          },
        },
      },
      '/api/forensics/incident': {
        get: {
          summary: 'Forensic incident report',
          description:
            'Return the reconstructed incident report for a given correlation id, including the causal event chain.',
          tags: ['forensics'],
          security: SECURITY_BOTH,
          parameters: [
            QUERY_PARAM(
              'correlationId',
              { type: 'string' },
              'Correlation id of the incident',
              true,
            ),
          ],
          responses: {
            '200': JSON_RESPONSE('IncidentReport', 'Incident report'),
            '401': ERROR_RESPONSE('Missing or invalid credentials'),
            '404': ERROR_RESPONSE('Incident not found'),
          },
        },
      },
      '/api/v1/control/magic-link/request': {
        post: {
          summary: 'Request a magic-link login token',
          description:
            'Send a single-use magic-link login token to the given email address. Always returns 202 to avoid leaking account existence.',
          tags: ['control-plane'],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['email'],
                  properties: {
                    email: { type: 'string', format: 'email', example: 'user@example.com' },
                  },
                },
              },
            },
          },
          responses: {
            '202': JSON_INLINE(
              { type: 'object', properties: { ok: { type: 'boolean', const: true } } },
              'Magic-link dispatched if the account exists',
            ),
            '400': ERROR_RESPONSE('Invalid email'),
          },
        },
      },
      '/api/v1/control/magic-link/consume': {
        post: {
          summary: 'Consume a magic-link login token',
          description:
            'Exchange a magic-link token for an authenticated session. The token is single-use and expires shortly after issuance.',
          tags: ['control-plane'],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['token'],
                  properties: { token: { type: 'string', example: 'ml_abc123…' } },
                },
              },
            },
          },
          responses: {
            '200': JSON_INLINE(
              {
                type: 'object',
                required: ['sessionToken', 'userId'],
                properties: {
                  sessionToken: { type: 'string' },
                  userId: { type: 'string' },
                  expiresAt: { type: 'string', format: 'date-time' },
                },
              },
              'Authenticated session',
            ),
            '400': ERROR_RESPONSE('Invalid or expired token'),
          },
        },
      },
      '/api/v1/control/api-keys/list': {
        post: {
          summary: 'List API keys for the current tenant',
          description:
            'Return all non-revoked API keys for the authenticated tenant. Secret material is never returned; only key prefixes and metadata.',
          tags: ['control-plane'],
          security: SECURITY_BOTH,
          requestBody: {
            required: false,
            content: {
              'application/json': {
                schema: { type: 'object', properties: {} },
              },
            },
          },
          responses: {
            '200': JSON_INLINE(
              {
                type: 'object',
                required: ['keys'],
                properties: {
                  keys: {
                    type: 'array',
                    items: {
                      type: 'object',
                      required: ['id', 'prefix', 'createdAt'],
                      properties: {
                        id: { type: 'string' },
                        prefix: { type: 'string' },
                        label: { type: 'string' },
                        createdAt: { type: 'string', format: 'date-time' },
                        lastUsedAt: { type: 'string', format: 'date-time' },
                      },
                    },
                  },
                },
              },
              'List of API keys',
            ),
            '401': ERROR_RESPONSE('Missing or invalid credentials'),
          },
        },
      },
      '/api/v1/control/api-keys/create': {
        post: {
          summary: 'Create a new API key',
          description:
            'Mint a new API key for the authenticated tenant. The full secret is returned exactly once; subsequent reads expose only the prefix.',
          tags: ['control-plane'],
          security: SECURITY_BOTH,
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: { label: { type: 'string', example: 'ci-runner' } },
                },
              },
            },
          },
          responses: {
            '201': JSON_INLINE(
              {
                type: 'object',
                required: ['id', 'secret', 'prefix'],
                properties: {
                  id: { type: 'string' },
                  secret: { type: 'string', description: 'Returned only at creation time' },
                  prefix: { type: 'string' },
                  label: { type: 'string' },
                  createdAt: { type: 'string', format: 'date-time' },
                },
              },
              'New API key',
            ),
            '401': ERROR_RESPONSE('Missing or invalid credentials'),
          },
        },
      },
      '/api/v1/control/api-keys/revoke': {
        post: {
          summary: 'Revoke an API key',
          description:
            'Mark the API key as revoked. Future requests authenticating with the key are rejected.',
          tags: ['control-plane'],
          security: SECURITY_BOTH,
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['id'],
                  properties: { id: { type: 'string' } },
                },
              },
            },
          },
          responses: {
            '200': JSON_INLINE(
              { type: 'object', properties: { ok: { type: 'boolean', const: true } } },
              'API key revoked',
            ),
            '401': ERROR_RESPONSE('Missing or invalid credentials'),
            '404': ERROR_RESPONSE('Key not found'),
          },
        },
      },
      '/api/v1/control/usage': {
        post: {
          summary: 'Report tenant usage for a billing period',
          description:
            'Return per-meter usage counters for the authenticated tenant over the requested window. Used by the console billing panel and by invoicing pipelines.',
          tags: ['control-plane'],
          security: SECURITY_BOTH,
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    from: { type: 'string', format: 'date-time' },
                    to: { type: 'string', format: 'date-time' },
                  },
                },
              },
            },
          },
          responses: {
            '200': JSON_INLINE(
              {
                type: 'object',
                required: ['meters'],
                properties: {
                  windowStart: { type: 'string', format: 'date-time' },
                  windowEnd: { type: 'string', format: 'date-time' },
                  meters: {
                    type: 'object',
                    additionalProperties: { type: 'integer', minimum: 0 },
                  },
                },
              },
              'Usage counters keyed by meter id',
            ),
            '401': ERROR_RESPONSE('Missing or invalid credentials'),
          },
        },
      },
      '/api/v1/control/billing/checkout': {
        post: {
          summary: 'Create a billing checkout session',
          description:
            'Start a hosted checkout session for the requested plan. Returns a redirect URL the client opens in a new tab.',
          tags: ['control-plane'],
          security: SECURITY_BOTH,
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['planId'],
                  properties: {
                    planId: { type: 'string', example: 'pro_monthly' },
                    returnUrl: { type: 'string', format: 'uri' },
                  },
                },
              },
            },
          },
          responses: {
            '200': JSON_INLINE(
              {
                type: 'object',
                required: ['url'],
                properties: {
                  url: { type: 'string', format: 'uri' },
                  sessionId: { type: 'string' },
                },
              },
              'Hosted checkout URL',
            ),
            '401': ERROR_RESPONSE('Missing or invalid credentials'),
          },
        },
      },
      '/api/v1/control/billing/webhook': {
        post: {
          summary: 'Billing provider webhook receiver',
          description:
            'Receive billing provider webhooks (subscription updates, invoice events). Signed by the provider; the body is verified before processing.',
          tags: ['control-plane'],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: { type: 'object', additionalProperties: true },
              },
            },
          },
          responses: {
            '200': JSON_INLINE(
              { type: 'object', properties: { received: { type: 'boolean', const: true } } },
              'Webhook accepted',
            ),
            '400': ERROR_RESPONSE('Invalid signature or payload'),
          },
        },
      },
      '/api/v1/control/webhooks/create': {
        post: {
          summary: 'Create an outbound webhook subscription',
          description:
            'Register a URL to receive event notifications. Returns a signing secret used to verify deliveries.',
          tags: ['control-plane'],
          security: SECURITY_BOTH,
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['url', 'events'],
                  properties: {
                    url: { type: 'string', format: 'uri' },
                    events: { type: 'array', items: { type: 'string' } },
                    label: { type: 'string' },
                  },
                },
              },
            },
          },
          responses: {
            '201': JSON_INLINE(
              {
                type: 'object',
                required: ['id', 'signingSecret'],
                properties: {
                  id: { type: 'string' },
                  url: { type: 'string', format: 'uri' },
                  signingSecret: { type: 'string' },
                  status: { type: 'string', enum: ['active', 'paused'] },
                },
              },
              'Created webhook',
            ),
            '400': ERROR_RESPONSE('Invalid payload'),
            '401': ERROR_RESPONSE('Missing or invalid credentials'),
          },
        },
      },
      '/api/v1/control/webhooks/list': {
        post: {
          summary: 'List webhook subscriptions',
          description: 'Return all webhook subscriptions belonging to the authenticated tenant.',
          tags: ['control-plane'],
          security: SECURITY_BOTH,
          requestBody: {
            required: false,
            content: {
              'application/json': {
                schema: { type: 'object', properties: {} },
              },
            },
          },
          responses: {
            '200': JSON_INLINE(
              {
                type: 'object',
                required: ['webhooks'],
                properties: {
                  webhooks: {
                    type: 'array',
                    items: {
                      type: 'object',
                      required: ['id', 'url', 'status'],
                      properties: {
                        id: { type: 'string' },
                        url: { type: 'string', format: 'uri' },
                        status: { type: 'string', enum: ['active', 'paused'] },
                        events: { type: 'array', items: { type: 'string' } },
                      },
                    },
                  },
                },
              },
              'List of webhook subscriptions',
            ),
            '401': ERROR_RESPONSE('Missing or invalid credentials'),
          },
        },
      },
      '/api/v1/control/webhooks/pause': {
        post: {
          summary: 'Pause a webhook subscription',
          description: 'Stop dispatching events to the subscription until it is resumed.',
          tags: ['control-plane'],
          security: SECURITY_BOTH,
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['id'],
                  properties: { id: { type: 'string' } },
                },
              },
            },
          },
          responses: {
            '200': JSON_INLINE(
              { type: 'object', properties: { ok: { type: 'boolean', const: true } } },
              'Webhook paused',
            ),
            '401': ERROR_RESPONSE('Missing or invalid credentials'),
            '404': ERROR_RESPONSE('Webhook not found'),
          },
        },
      },
      '/api/v1/control/webhooks/resume': {
        post: {
          summary: 'Resume a paused webhook subscription',
          description: 'Re-enable event dispatch for a previously paused subscription.',
          tags: ['control-plane'],
          security: SECURITY_BOTH,
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['id'],
                  properties: { id: { type: 'string' } },
                },
              },
            },
          },
          responses: {
            '200': JSON_INLINE(
              { type: 'object', properties: { ok: { type: 'boolean', const: true } } },
              'Webhook resumed',
            ),
            '401': ERROR_RESPONSE('Missing or invalid credentials'),
            '404': ERROR_RESPONSE('Webhook not found'),
          },
        },
      },
      '/api/v1/control/webhooks/delete': {
        post: {
          summary: 'Delete a webhook subscription',
          description:
            'Permanently remove the subscription. Deliveries already in-flight may still fire.',
          tags: ['control-plane'],
          security: SECURITY_BOTH,
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['id'],
                  properties: { id: { type: 'string' } },
                },
              },
            },
          },
          responses: {
            '200': JSON_INLINE(
              { type: 'object', properties: { ok: { type: 'boolean', const: true } } },
              'Webhook deleted',
            ),
            '401': ERROR_RESPONSE('Missing or invalid credentials'),
            '404': ERROR_RESPONSE('Webhook not found'),
          },
        },
      },
      '/api/v1/compliance/frameworks': {
        get: {
          summary: 'List supported compliance frameworks',
          description:
            'Return the catalog of frameworks (SOC2, ISO27001, HIPAA, GDPR, …) that the compliance reporter can produce.',
          tags: ['compliance'],
          security: SECURITY_BOTH,
          responses: {
            '200': JSON_INLINE(
              {
                type: 'object',
                required: ['frameworks'],
                properties: {
                  frameworks: {
                    type: 'array',
                    items: {
                      type: 'object',
                      required: ['id', 'name'],
                      properties: {
                        id: { type: 'string', example: 'soc2-type2' },
                        name: { type: 'string', example: 'SOC 2 Type II' },
                        controls: { type: 'integer', minimum: 0 },
                      },
                    },
                  },
                },
              },
              'List of frameworks',
            ),
            '401': ERROR_RESPONSE('Missing or invalid credentials'),
          },
        },
      },
      '/api/v1/compliance/report': {
        post: {
          summary: 'Generate a compliance report',
          description:
            'Build a one-click compliance report for the requested framework over the given evidence window. Returns the report payload and a download URL.',
          tags: ['compliance'],
          security: SECURITY_BOTH,
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['frameworkId'],
                  properties: {
                    frameworkId: { type: 'string', example: 'soc2-type2' },
                    from: { type: 'string', format: 'date-time' },
                    to: { type: 'string', format: 'date-time' },
                  },
                },
              },
            },
          },
          responses: {
            '200': JSON_INLINE(
              {
                type: 'object',
                required: ['reportId', 'frameworkId', 'controls'],
                properties: {
                  reportId: { type: 'string' },
                  frameworkId: { type: 'string' },
                  generatedAt: { type: 'string', format: 'date-time' },
                  downloadUrl: { type: 'string', format: 'uri' },
                  controls: {
                    type: 'array',
                    items: {
                      type: 'object',
                      required: ['id', 'status'],
                      properties: {
                        id: { type: 'string' },
                        status: {
                          type: 'string',
                          enum: ['pass', 'fail', 'not-applicable', 'manual-review'],
                        },
                        evidenceCount: { type: 'integer', minimum: 0 },
                      },
                    },
                  },
                },
              },
              'Generated report',
            ),
            '400': ERROR_RESPONSE('Invalid request'),
            '401': ERROR_RESPONSE('Missing or invalid credentials'),
          },
        },
      },
      '/api/v1/receipt/anchor': {
        post: {
          summary: 'Anchor the ledger head to an external chain',
          description:
            'Submit the current ledger head hash to the configured external anchoring target (e.g. public blockchain or transparency log). Returns the anchor receipt.',
          tags: ['receipt'],
          security: SECURITY_BOTH,
          requestBody: {
            required: false,
            content: {
              'application/json': {
                schema: { type: 'object', properties: {} },
              },
            },
          },
          responses: {
            '200': JSON_INLINE(
              {
                type: 'object',
                required: ['anchorId', 'headHash', 'anchoredAt'],
                properties: {
                  anchorId: { type: 'string' },
                  headHash: { type: 'string' },
                  headSeq: { type: 'integer', minimum: 0 },
                  anchoredAt: { type: 'string', format: 'date-time' },
                  externalRef: { type: 'string' },
                },
              },
              'Anchor receipt',
            ),
            '401': ERROR_RESPONSE('Missing or invalid credentials'),
          },
        },
      },
      '/api/v1/receipt/generate': {
        post: {
          summary: 'Generate a cryptographic receipt for one or more events',
          description:
            'Return a Merkle inclusion proof linking the requested event sequences to the latest anchored head, suitable for offline verification.',
          tags: ['receipt'],
          security: SECURITY_BOTH,
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['seqs'],
                  properties: {
                    seqs: {
                      type: 'array',
                      items: { type: 'integer', minimum: 0 },
                      minItems: 1,
                    },
                  },
                },
              },
            },
          },
          responses: {
            '200': JSON_INLINE(
              {
                type: 'object',
                required: ['receipt'],
                properties: {
                  receipt: {
                    type: 'object',
                    required: ['headHash', 'proofs'],
                    properties: {
                      headHash: { type: 'string' },
                      proofs: {
                        type: 'array',
                        items: {
                          type: 'object',
                          required: ['seq', 'leafHash', 'path'],
                          properties: {
                            seq: { type: 'integer', minimum: 0 },
                            leafHash: { type: 'string' },
                            path: { type: 'array', items: { type: 'string' } },
                          },
                        },
                      },
                    },
                  },
                },
              },
              'Inclusion proof receipt',
            ),
            '400': ERROR_RESPONSE('Invalid request'),
            '401': ERROR_RESPONSE('Missing or invalid credentials'),
          },
        },
      },
      '/api/v1/receipt/verify': {
        post: {
          summary: 'Verify a cryptographic receipt',
          description:
            'Re-run a Merkle inclusion proof against the current ledger and report whether the events are still attested.',
          tags: ['receipt'],
          security: SECURITY_BOTH,
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['receipt'],
                  properties: {
                    receipt: { type: 'object', additionalProperties: true },
                  },
                },
              },
            },
          },
          responses: {
            '200': JSON_INLINE(
              {
                type: 'object',
                required: ['valid'],
                properties: {
                  valid: { type: 'boolean' },
                  headHash: { type: 'string' },
                  reason: { type: 'string' },
                },
              },
              'Verification result',
            ),
            '400': ERROR_RESPONSE('Malformed receipt'),
            '401': ERROR_RESPONSE('Missing or invalid credentials'),
          },
        },
      },
      '/api/v1/simulator/run': {
        post: {
          summary: 'Run a pre-crime policy simulation',
          description:
            'Replay a candidate policy against a window of historical events and report which decisions would have changed. Does not mutate state.',
          tags: ['simulator'],
          security: SECURITY_BOTH,
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['policy'],
                  properties: {
                    policy: { $ref: '#/components/schemas/Policy' },
                    from: { type: 'string', format: 'date-time' },
                    to: { type: 'string', format: 'date-time' },
                    sampleLimit: { type: 'integer', minimum: 1, maximum: 100000 },
                  },
                },
              },
            },
          },
          responses: {
            '200': JSON_INLINE(
              {
                type: 'object',
                required: ['evaluated', 'changes'],
                properties: {
                  evaluated: { type: 'integer', minimum: 0 },
                  changes: {
                    type: 'array',
                    items: {
                      type: 'object',
                      required: ['seq', 'before', 'after'],
                      properties: {
                        seq: { type: 'integer', minimum: 0 },
                        before: { type: 'string', enum: ['allow', 'deny', 'require-approval'] },
                        after: { type: 'string', enum: ['allow', 'deny', 'require-approval'] },
                        matchedRuleId: { type: 'string' },
                      },
                    },
                  },
                  summary: {
                    type: 'object',
                    properties: {
                      newlyDenied: { type: 'integer', minimum: 0 },
                      newlyAllowed: { type: 'integer', minimum: 0 },
                      requireApproval: { type: 'integer', minimum: 0 },
                    },
                  },
                },
              },
              'Simulation result',
            ),
            '400': ERROR_RESPONSE('Invalid policy or window'),
            '401': ERROR_RESPONSE('Missing or invalid credentials'),
          },
        },
      },
      '/api/v1/rca/analyze': {
        post: {
          summary: 'Auto-generate a root-cause analysis',
          description:
            'Run automated root-cause analysis on an incident, returning a ranked list of suspected causes with supporting evidence drawn from the ledger.',
          tags: ['rca'],
          security: SECURITY_BOTH,
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['correlationId'],
                  properties: {
                    correlationId: { type: 'string' },
                    lookbackMinutes: { type: 'integer', minimum: 1, maximum: 10080 },
                  },
                },
              },
            },
          },
          responses: {
            '200': JSON_INLINE(
              {
                type: 'object',
                required: ['correlationId', 'hypotheses'],
                properties: {
                  correlationId: { type: 'string' },
                  generatedAt: { type: 'string', format: 'date-time' },
                  hypotheses: {
                    type: 'array',
                    items: {
                      type: 'object',
                      required: ['summary', 'confidence'],
                      properties: {
                        summary: { type: 'string' },
                        confidence: { type: 'number', minimum: 0, maximum: 1 },
                        evidenceSeqs: {
                          type: 'array',
                          items: { type: 'integer', minimum: 0 },
                        },
                      },
                    },
                  },
                },
              },
              'RCA result',
            ),
            '400': ERROR_RESPONSE('Invalid request'),
            '401': ERROR_RESPONSE('Missing or invalid credentials'),
            '404': ERROR_RESPONSE('Correlation id not found'),
          },
        },
      },
      '/api/v1/cost-optimizer/forecast': {
        post: {
          summary: 'Forecast spend and surface optimization opportunities',
          description:
            'Project spend over the requested horizon and return a ranked list of self-healing cost-saving recommendations.',
          tags: ['cost-optimizer'],
          security: SECURITY_BOTH,
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    horizonDays: { type: 'integer', minimum: 1, maximum: 365 },
                    granularity: { type: 'string', enum: ['daily', 'weekly', 'monthly'] },
                  },
                },
              },
            },
          },
          responses: {
            '200': JSON_INLINE(
              {
                type: 'object',
                required: ['projection', 'recommendations'],
                properties: {
                  projection: {
                    type: 'array',
                    items: {
                      type: 'object',
                      required: ['bucket', 'projected'],
                      properties: {
                        bucket: { type: 'string', format: 'date-time' },
                        projected: { $ref: '#/components/schemas/Money' },
                        lowerBound: { $ref: '#/components/schemas/Money' },
                        upperBound: { $ref: '#/components/schemas/Money' },
                      },
                    },
                  },
                  recommendations: {
                    type: 'array',
                    items: {
                      type: 'object',
                      required: ['id', 'summary', 'estimatedSavings'],
                      properties: {
                        id: { type: 'string' },
                        summary: { type: 'string' },
                        estimatedSavings: { $ref: '#/components/schemas/Money' },
                        confidence: { type: 'number', minimum: 0, maximum: 1 },
                      },
                    },
                  },
                },
              },
              'Cost forecast and recommendations',
            ),
            '400': ERROR_RESPONSE('Invalid request'),
            '401': ERROR_RESPONSE('Missing or invalid credentials'),
          },
        },
      },
      '/api/audit/events/stream': {
        get: {
          summary: 'Stream audit events over Server-Sent Events',
          description:
            'Long-lived SSE connection that emits one `event: ledger-record` per appended record in real time. Clients should reconnect using the `Last-Event-ID` header to resume from a sequence.',
          tags: ['audit'],
          security: SECURITY_BOTH,
          parameters: [
            QUERY_PARAM(
              'fromSeq',
              { type: 'integer', minimum: 0 },
              'Resume from this sequence (inclusive). Overrides Last-Event-ID when present.',
            ),
            QUERY_PARAM('type', { type: 'string' }, 'Filter to events of this discriminator'),
          ],
          responses: {
            '200': {
              description: 'SSE stream of ledger records',
              content: {
                'text/event-stream': {
                  schema: {
                    type: 'string',
                    description:
                      'A continuous SSE stream. Each message has `event: ledger-record`, `id: <seq>`, and `data: <LedgerRecord JSON>`.',
                  },
                },
              },
            },
            '401': ERROR_RESPONSE('Missing or invalid credentials'),
          },
        },
      },
    },
    tags: [
      { name: 'meta', description: 'Service descriptor and metadata' },
      { name: 'health', description: 'Liveness and readiness probes' },
      { name: 'metrics', description: 'Operational metrics in JSON and Prometheus formats' },
      { name: 'events', description: 'Append events to the tamper-evident ledger' },
      { name: 'audit', description: 'Query, verify, and stream audit events' },
      { name: 'spend', description: 'Spend cap status and prospective authorization' },
      { name: 'permissions', description: 'Policy evaluation for candidate actions' },
      { name: 'vendor-risk', description: 'Vendor risk scoring from provider monitor signals' },
      { name: 'forensics', description: 'Reconstructed incident reports' },
      { name: 'control-plane', description: 'Tenant onboarding, API keys, billing, webhooks' },
      { name: 'compliance', description: 'Compliance framework catalog and one-click reports' },
      { name: 'receipt', description: 'Cryptographic anchoring and inclusion-proof receipts' },
      { name: 'simulator', description: 'Pre-crime policy simulation against historical events' },
      { name: 'rca', description: 'Automated root-cause analysis for incidents' },
      { name: 'cost-optimizer', description: 'Spend forecasting and self-healing recommendations' },
    ],
    components: {
      schemas: {
        Money: {
          type: 'object',
          required: ['amount', 'currency'],
          description: 'Monetary value in minor units (e.g. cents) with an ISO 4217 currency code.',
          properties: {
            amount: { type: 'integer', description: 'Amount in minor units' },
            currency: { type: 'string', minLength: 3, maxLength: 3 },
          },
        },
        Action: {
          type: 'object',
          required: ['kind', 'target'],
          description: 'A candidate agent action subject to policy and spend evaluation.',
          properties: {
            kind: { type: 'string', description: 'Action kind (e.g. http.request, db.write)' },
            target: { type: 'string', description: 'Action target identifier' },
            metadata: { type: 'object', additionalProperties: true },
          },
        },
        Policy: {
          type: 'object',
          required: ['id', 'rules'],
          description: 'A named ordered list of rules evaluated against an Action.',
          properties: {
            id: { type: 'string' },
            rules: {
              type: 'array',
              items: {
                type: 'object',
                required: ['id', 'effect', 'match'],
                properties: {
                  id: { type: 'string' },
                  effect: { type: 'string', enum: ['allow', 'deny', 'require-approval'] },
                  match: { type: 'object', additionalProperties: true },
                },
              },
            },
          },
        },
        EventInput: {
          type: 'object',
          required: ['type', 'actorId', 'payload'],
          description:
            'A new event to append to the ledger. The full event union is discriminated by `type`; the `note` variant is documented inline as a representative example.',
          properties: {
            type: { type: 'string', const: 'note', description: 'Event type discriminator' },
            actorId: { type: 'string' },
            correlationId: { type: 'string' },
            payload: {
              type: 'object',
              required: ['text'],
              properties: {
                text: { type: 'string' },
              },
            },
          },
        },
        LedgerRecord: {
          type: 'object',
          required: ['seq', 'eventId', 'event', 'prevHash', 'hash', 'timestamp'],
          description:
            'A persisted, hash-chained ledger record. `hash` is the SHA-256 of the canonicalized record body plus `prevHash`.',
          properties: {
            seq: { type: 'integer', minimum: 0 },
            eventId: { type: 'string' },
            event: { type: 'object', additionalProperties: true },
            prevHash: { type: 'string', description: 'Hex SHA-256 of the predecessor record' },
            hash: { type: 'string', description: 'Hex SHA-256 of this record' },
            timestamp: { type: 'string', format: 'date-time' },
          },
        },
        AuditSummary: {
          type: 'object',
          required: ['totalRecords', 'headSeq', 'headHash'],
          description: 'Aggregate ledger statistics returned by /api/audit/summary.',
          properties: {
            totalRecords: { type: 'integer', minimum: 0 },
            headSeq: { type: 'integer', minimum: 0, nullable: true },
            headHash: { type: 'string', nullable: true },
            firstTimestamp: { type: 'string', format: 'date-time', nullable: true },
            lastTimestamp: { type: 'string', format: 'date-time', nullable: true },
          },
        },
        SpendStatus: {
          type: 'object',
          required: ['cap', 'consumed', 'remaining'],
          description: 'Snapshot of the active spend window.',
          properties: {
            cap: { $ref: '#/components/schemas/Money' },
            consumed: { $ref: '#/components/schemas/Money' },
            remaining: { $ref: '#/components/schemas/Money' },
            windowStart: { type: 'string', format: 'date-time' },
            windowEnd: { type: 'string', format: 'date-time' },
          },
        },
        VendorRiskScore: {
          type: 'object',
          required: ['vendorId', 'score', 'level', 'assessedAt'],
          description: 'Vendor risk score derived from provider monitor signals.',
          properties: {
            vendorId: { type: 'string' },
            score: { type: 'number', minimum: 0, maximum: 100 },
            level: { type: 'string', enum: ['low', 'medium', 'high', 'critical'] },
            assessedAt: { type: 'string', format: 'date-time' },
            signals: { type: 'array', items: { type: 'string' } },
          },
        },
        IncidentReport: {
          type: 'object',
          required: ['correlationId', 'summary', 'events'],
          description: 'Reconstructed forensic narrative for an incident.',
          properties: {
            correlationId: { type: 'string' },
            summary: { type: 'string' },
            severity: { type: 'string', enum: ['info', 'low', 'medium', 'high', 'critical'] },
            startedAt: { type: 'string', format: 'date-time' },
            endedAt: { type: 'string', format: 'date-time' },
            events: {
              type: 'array',
              items: { $ref: '#/components/schemas/LedgerRecord' },
            },
          },
        },
        HealthStatus: {
          type: 'object',
          required: ['status'],
          description: 'Health check response. `ok` means the probe succeeded.',
          properties: {
            status: { type: 'string', enum: ['ok', 'degraded', 'down'] },
            uptimeSeconds: { type: 'number', minimum: 0 },
            checks: {
              type: 'object',
              additionalProperties: {
                type: 'object',
                properties: {
                  status: { type: 'string' },
                  message: { type: 'string' },
                },
              },
            },
          },
        },
        Error: {
          type: 'object',
          required: ['code', 'message'],
          description:
            'Veritrail error envelope. `code` matches the `VeritrailErrorCode` discriminator from `@veritrail/core`.',
          properties: {
            code: { type: 'string' },
            message: { type: 'string' },
            details: { type: 'object', additionalProperties: true },
          },
        },
      },
      securitySchemes: {
        ApiKeyAuth: {
          type: 'apiKey',
          in: 'header',
          name: 'X-Veritrail-Api-Key',
        },
        BearerAuth: {
          type: 'http',
          scheme: 'bearer',
        },
      },
    },
  };
}
