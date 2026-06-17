// Local sample data shaped to match the API responses in types.ts.
// The API client falls back to these so the SPA renders standalone with no server.

import type {
  AuditSummary,
  HealthStatus,
  IncidentReport,
  LedgerEvent,
  LedgerEventsResponse,
  SpendStatusResponse,
  VendorRiskResponse,
} from './types.ts';

export const mockHealth: HealthStatus = {
  ok: true,
  version: '0.1.0-sample',
  uptimeSeconds: 48213,
};

export const mockAuditSummary: AuditSummary = {
  totalEvents: 1287,
  integrityOk: true,
  lastHash: 'a3f9c1d28b4e7016f5c2a9018d3e6b7c4f01a2d3e4b5c6071829304a5b6c7d8e',
  firstEventAt: '2026-06-09T08:12:04.000Z',
  lastEventAt: '2026-06-16T17:41:55.000Z',
  distinctAgents: 7,
};

export const mockLedgerEvents: LedgerEvent[] = [
  {
    seq: 1287,
    timestamp: '2026-06-16T17:41:55.000Z',
    type: 'agent.tool.invoke',
    agentId: 'agent-orchestrator',
    correlationId: 'corr-9f2a',
    severity: 'info',
    hash: 'a3f9c1d28b4e7016f5c2a9018d3e6b7c4f01a2d3e4b5c6071829304a5b6c7d8e',
    prevHash: 'b1c2d3e4f5a60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90',
    detail: 'Invoked tool "search.web" with sanitized query.',
  },
  {
    seq: 1286,
    timestamp: '2026-06-16T17:40:12.000Z',
    type: 'spend.budget.warning',
    agentId: 'agent-researcher',
    correlationId: 'corr-7c1b',
    severity: 'warn',
    hash: 'b1c2d3e4f5a60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90',
    prevHash: 'c2d3e4f5a6b70819203a4b5c6d7e8f901a2b3c4d5e6f7081920a3b4c5d6e7f80',
    detail: 'Project budget crossed 80% threshold ($1,640 / $2,000).',
  },
  {
    seq: 1285,
    timestamp: '2026-06-16T16:58:33.000Z',
    type: 'policy.violation',
    agentId: 'agent-support',
    correlationId: 'corr-4d8e',
    severity: 'error',
    hash: 'c2d3e4f5a6b70819203a4b5c6d7e8f901a2b3c4d5e6f7081920a3b4c5d6e7f80',
    prevHash: 'd3e4f5a6b7c80910213a4b5c6d7e8f901a2b3c4d5e6f70819203a4b5c6d7e8f9',
    detail: 'Blocked egress to non-allowlisted host api.unknown-vendor.io.',
  },
  {
    seq: 1284,
    timestamp: '2026-06-16T16:55:07.000Z',
    type: 'agent.prompt.received',
    agentId: 'agent-support',
    correlationId: 'corr-4d8e',
    severity: 'info',
    hash: 'd3e4f5a6b7c80910213a4b5c6d7e8f901a2b3c4d5e6f70819203a4b5c6d7e8f9',
    prevHash: 'e4f5a6b7c8d90112233a4b5c6d7e8f901a2b3c4d5e6f708192a3b4c5d6e7f801',
    detail: 'Received user prompt; PII redaction applied to 2 fields.',
  },
  {
    seq: 1283,
    timestamp: '2026-06-16T15:22:48.000Z',
    type: 'vendor.risk.reassessed',
    agentId: 'system',
    correlationId: 'corr-1a0f',
    severity: 'warn',
    hash: 'e4f5a6b7c8d90112233a4b5c6d7e8f901a2b3c4d5e6f708192a3b4c5d6e7f801',
    prevHash: 'f5a6b7c8d9e01223344a5b6c7d8e9f012a3b4c5d6e7f8091a2b3c4d5e6f70819',
    detail: 'Vendor "ModelHaus" risk band raised low → moderate.',
  },
  {
    seq: 1282,
    timestamp: '2026-06-16T14:03:19.000Z',
    type: 'agent.tool.invoke',
    agentId: 'agent-coder',
    correlationId: 'corr-2b3c',
    severity: 'info',
    hash: 'f5a6b7c8d9e01223344a5b6c7d8e9f012a3b4c5d6e7f8091a2b3c4d5e6f70819',
    prevHash: '06b7c8d9e0f1233445566a7b8c9d0e1f2a3b4c5d6e7f8091a2b3c4d5e6f70819',
    detail: 'Executed sandboxed code (exit 0, 412ms).',
  },
  {
    seq: 1281,
    timestamp: '2026-06-16T11:47:02.000Z',
    type: 'incident.opened',
    agentId: 'system',
    correlationId: 'corr-4d8e',
    severity: 'critical',
    hash: '06b7c8d9e0f1233445566a7b8c9d0e1f2a3b4c5d6e7f8091a2b3c4d5e6f70819',
    prevHash: null,
    detail: 'Incident opened after repeated egress policy violations.',
  },
];

export const mockLedgerEventsResponse: LedgerEventsResponse = {
  events: mockLedgerEvents,
  limit: 50,
  total: mockAuditSummary.totalEvents,
};

export const mockSpendStatus: SpendStatusResponse = {
  totalLimitUsd: 8000,
  totalSpentUsd: 4193.42,
  budgets: [
    {
      scope: 'proj-research',
      label: 'Research project',
      limitUsd: 2000,
      spentUsd: 1640.18,
      remainingUsd: 359.82,
      periodStart: '2026-06-01T00:00:00.000Z',
      periodEnd: '2026-06-30T23:59:59.000Z',
      state: 'warning',
    },
    {
      scope: 'agent-support',
      label: 'Support agent',
      limitUsd: 1000,
      spentUsd: 1142.6,
      remainingUsd: -142.6,
      periodStart: '2026-06-01T00:00:00.000Z',
      periodEnd: '2026-06-30T23:59:59.000Z',
      state: 'exceeded',
    },
    {
      scope: 'proj-platform',
      label: 'Platform',
      limitUsd: 5000,
      spentUsd: 1410.64,
      remainingUsd: 3589.36,
      periodStart: '2026-06-01T00:00:00.000Z',
      periodEnd: '2026-06-30T23:59:59.000Z',
      state: 'ok',
    },
  ],
};

export const mockVendorRisk: VendorRiskResponse = {
  vendors: [
    {
      vendorId: 'vendor-unknown-io',
      name: 'unknown-vendor.io',
      score: 82,
      band: 'high',
      factors: ['Not on allowlist', 'No data-processing agreement', 'Recent egress attempts'],
      assessedAt: '2026-06-16T16:58:33.000Z',
    },
    {
      vendorId: 'vendor-modelhaus',
      name: 'ModelHaus',
      score: 54,
      band: 'elevated',
      factors: ['SOC2 expired', 'Region: outside primary'],
      assessedAt: '2026-06-16T15:22:48.000Z',
    },
    {
      vendorId: 'vendor-openmodel',
      name: 'OpenModel Cloud',
      score: 31,
      band: 'moderate',
      factors: ['Subprocessor list incomplete'],
      assessedAt: '2026-06-15T09:10:00.000Z',
    },
    {
      vendorId: 'vendor-acme-ai',
      name: 'Acme AI',
      score: 12,
      band: 'low',
      factors: ['Fully compliant', 'On allowlist'],
      assessedAt: '2026-06-14T22:05:00.000Z',
    },
  ],
};

export const mockIncidentReports: Record<string, IncidentReport> = {
  'corr-4d8e': {
    correlationId: 'corr-4d8e',
    title: 'Repeated egress policy violations (support agent)',
    openedAt: '2026-06-16T11:47:02.000Z',
    closedAt: null,
    agents: ['agent-support'],
    peakSeverity: 'critical',
    timeline: [
      {
        timestamp: '2026-06-16T11:47:02.000Z',
        type: 'incident.opened',
        severity: 'critical',
        summary: 'Incident opened after repeated egress policy violations.',
      },
      {
        timestamp: '2026-06-16T16:55:07.000Z',
        type: 'agent.prompt.received',
        severity: 'info',
        summary: 'Received user prompt; PII redaction applied to 2 fields.',
      },
      {
        timestamp: '2026-06-16T16:58:33.000Z',
        type: 'policy.violation',
        severity: 'error',
        summary: 'Blocked egress to non-allowlisted host api.unknown-vendor.io.',
      },
    ],
  },
  'corr-9f2a': {
    correlationId: 'corr-9f2a',
    title: 'Routine tool invocation trace (orchestrator)',
    openedAt: '2026-06-16T17:41:55.000Z',
    closedAt: '2026-06-16T17:42:10.000Z',
    agents: ['agent-orchestrator'],
    peakSeverity: 'info',
    timeline: [
      {
        timestamp: '2026-06-16T17:41:55.000Z',
        type: 'agent.tool.invoke',
        severity: 'info',
        summary: 'Invoked tool "search.web" with sanitized query.',
      },
      {
        timestamp: '2026-06-16T17:42:10.000Z',
        type: 'agent.tool.result',
        severity: 'info',
        summary: 'Tool returned 5 results; cached for 60s.',
      },
    ],
  },
};

/** Correlation ids that have a reconstructable incident report. */
export const mockCorrelationIds: string[] = Object.keys(mockIncidentReports);
