import type { ControlEvidence, EvidenceWindow } from './collect-evidence.js';
import { compliancePercent } from './collect-evidence.js';
import type { Framework } from './frameworks.js';

/** Options accepted by {@link renderMarkdown}. */
export interface RenderMarkdownOptions {
  /** The report window the evidence was collected for. */
  readonly window: EvidenceWindow;
  /** Wall-clock time the report was generated. Defaults to `Date.now()`. */
  readonly generatedAtMs?: number;
  /** Human-readable identifier of the entity under audit (org, tenant). */
  readonly entity?: string;
  /** Maximum number of sample event ids to print per control. Defaults to 5. */
  readonly sampleSize?: number;
}

const DEFAULT_SAMPLE_SIZE = 5;

function fmtTs(ms: number): string {
  return new Date(ms).toISOString();
}

function statusBadge(item: ControlEvidence): string {
  if (item.satisfied) return 'PASS';
  return item.control.severity === 'must' ? 'GAP (must)' : 'GAP (should)';
}

/**
 * Render an auditor-ready Markdown report for a framework and its
 * collected evidence. The output is deterministic for a fixed input and
 * intentionally PDF-free: downstream code (server/CLI) is responsible for
 * any PDF conversion.
 *
 * Sections:
 *
 * 1. Header — framework, period, generated-at, summary score.
 * 2. Per-control table — id, name, severity, status, evidence count, samples.
 * 3. Gaps — every control whose `satisfied` is false, with the specific
 *    required event types that were not observed.
 */
export function renderMarkdown(
  framework: Framework,
  evidence: readonly ControlEvidence[],
  opts: RenderMarkdownOptions,
): string {
  const generatedAt = opts.generatedAtMs ?? Date.now();
  const sampleSize = Math.max(0, opts.sampleSize ?? DEFAULT_SAMPLE_SIZE);
  const score = compliancePercent(evidence);

  const lines: string[] = [];
  lines.push(`# Compliance report — ${framework.name}`);
  lines.push('');
  lines.push(`- **Framework**: ${framework.name} (\`${framework.id}\`)`);
  lines.push(`- **Framework version**: ${framework.version}`);
  if (opts.entity !== undefined) lines.push(`- **Entity**: ${opts.entity}`);
  lines.push(`- **Period start**: ${fmtTs(opts.window.fromMs)}`);
  lines.push(`- **Period end**: ${fmtTs(opts.window.toMs)}`);
  lines.push(`- **Generated at**: ${fmtTs(generatedAt)}`);
  lines.push(`- **Compliance score**: ${score} / 100`);
  lines.push('');

  lines.push('## Controls');
  lines.push('');
  lines.push('| Control | Name | Severity | Status | Evidence | Sample event ids |');
  lines.push('| --- | --- | --- | --- | ---: | --- |');
  for (const item of evidence) {
    const samples = item.evidenceEventIds.slice(0, sampleSize);
    const sampleCell =
      samples.length === 0 ? '_(none)_' : samples.map((id) => `\`${id}\``).join(', ');
    lines.push(
      `| \`${item.control.id}\` | ${item.control.name} | ${item.control.severity} | ${statusBadge(item)} | ${item.evidenceCount} | ${sampleCell} |`,
    );
  }
  lines.push('');

  lines.push('## Gaps');
  lines.push('');
  const gaps = evidence.filter((item) => !item.satisfied);
  if (gaps.length === 0) {
    lines.push(
      '_No gaps detected — every control above has at least one ledger-backed evidence event in the window._',
    );
  } else {
    for (const item of gaps) {
      const missing = item.missingEventTypes.map((type) => `\`${type}\``).join(', ');
      lines.push(
        `- **${item.control.id}** (${item.control.severity}) — ${item.control.name}. Missing event types: ${missing}.`,
      );
    }
  }
  lines.push('');

  lines.push('## Methodology');
  lines.push('');
  lines.push(
    'Each control above declares the ledger event types whose presence demonstrates the control was exercised. ' +
      'Veritrail queries the append-only ledger for those event types within the report period and lists matching event ids. ' +
      'Every event id can be independently re-fetched from the ledger and verified against its hash-chained predecessor and (when present) detached signature.',
  );
  lines.push('');

  return lines.join('\n');
}
