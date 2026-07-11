/**
 * HTTP routes that expose `@veritrail/agent-reputation` over the ledger.
 *
 * Provides a JSON projection endpoint for programmatic consumers and a small
 * SVG badge endpoint for embedding in READMEs, docs, and dashboards. Both
 * routes are pure read-only projections: they replay ledger events for the
 * named agent and never write back.
 */

import { computeReputation, type AgentReputationProfile } from '@veritrail/agent-reputation';
import type { LedgerReader } from '@veritrail/core';
import type { FastifyInstance } from 'fastify';

/** Configuration for {@link registerAgentReputationRoutes}. */
export interface AgentReputationRoutesConfig {
  /** Ledger to project the agent's reputation from. Only the read interface is used. */
  readonly ledger: LedgerReader;
}

interface AgentParams {
  readonly agentId: string;
}

/**
 * Register agent-reputation HTTP routes on a Fastify instance. Mounts:
 *
 * - `GET /api/v1/agent/:agentId/reputation`       — JSON projection profile.
 * - `GET /api/v1/agent/:agentId/reputation/badge` — embeddable SVG badge.
 */
export function registerAgentReputationRoutes(
  app: FastifyInstance,
  opts: AgentReputationRoutesConfig,
): void {
  const { ledger } = opts;

  app.get<{ Params: AgentParams }>('/api/v1/agent/:agentId/reputation', async (request, reply) => {
    const { agentId } = request.params;
    const profile = await computeReputation(ledger, { agentId });
    return reply.send(profile);
  });

  app.get<{ Params: AgentParams }>(
    '/api/v1/agent/:agentId/reputation/badge',
    async (request, reply) => {
      const { agentId } = request.params;
      const profile = await computeReputation(ledger, { agentId });
      const svg = renderBadgeSvg(profile);
      return reply.header('content-type', 'image/svg+xml').send(svg);
    },
  );
}

const BADGE_WIDTH = 180;
const BADGE_HEIGHT = 28;

const BADGE_COLORS: Record<AgentReputationProfile['badge'], string> = {
  verified: '#22c55e',
  caution: '#ef4444',
  unverified: '#9ca3af',
};

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * Render a small SVG badge summarising the profile. The output has no
 * external dependencies, is safe to inline in HTML/Markdown, and works in
 * any modern browser.
 */
function renderBadgeSvg(profile: AgentReputationProfile): string {
  const color = BADGE_COLORS[profile.badge];
  const label = escapeXml(profile.badge);
  const score = Math.round(profile.score).toString();
  const width = BADGE_WIDTH;
  const height = BADGE_HEIGHT;
  const circleCx = 14;
  const circleCy = height / 2;
  const circleR = 7;
  const labelX = circleCx + circleR + 8;
  const scoreX = width - 10;
  const textY = height / 2 + 4;

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="Veritrail reputation: ${label} ${score}">`,
    `<rect width="${width}" height="${height}" rx="4" fill="#1f2937"/>`,
    `<circle cx="${circleCx}" cy="${circleCy}" r="${circleR}" fill="${color}"/>`,
    `<text x="${labelX}" y="${textY}" font-family="-apple-system, Segoe UI, sans-serif" font-size="12" fill="#f9fafb">${label}</text>`,
    `<text x="${scoreX}" y="${textY}" font-family="-apple-system, Segoe UI, sans-serif" font-size="12" fill="#f9fafb" text-anchor="end">${score}</text>`,
    `</svg>`,
  ].join('');
}
