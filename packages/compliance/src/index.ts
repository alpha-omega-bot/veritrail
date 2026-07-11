/**
 * `@veritrail/compliance` — one-click compliance reports backed by the
 * tamper-evident Veritrail ledger.
 *
 * Compliance reports usually claim that controls exist; this package goes
 * one step further and cites the specific ledger event ids that prove each
 * control was exercised. Because the ledger is hash-chained and optionally
 * signed, auditors can verify every claim line-by-line against immutable
 * receipts.
 *
 * Supported framework templates ({@link FrameworkId}):
 *
 * - `soc2-cc7` — SOC 2 Common Criteria 7 (System Operations).
 * - `eu-ai-act-annex-iv` — EU AI Act Annex IV technical documentation.
 * - `hipaa-security` — HIPAA Security Rule (45 CFR Part 164 Subpart C).
 * - `iso-42001` — ISO/IEC 42001:2023 AI Management System.
 *
 * The output of {@link renderMarkdown} is Markdown only. PDF rendering is
 * left to downstream code (the server or CLI) where a binary toolchain
 * such as `pdf-lib` or `wkhtmltopdf` lives.
 */

export {
  FRAMEWORK_TEMPLATES,
  FRAMEWORK_IDS,
  getFramework,
  requireFramework,
  type Control,
  type ControlSeverity,
  type Framework,
  type FrameworkId,
} from './frameworks.js';
export {
  collectEvidence,
  compliancePercent,
  windowEndingAt,
  type ControlEvidence,
  type CollectEvidenceOptions,
  type EvidenceWindow,
} from './collect-evidence.js';
export { renderMarkdown, type RenderMarkdownOptions } from './render-markdown.js';
