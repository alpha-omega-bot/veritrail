# @veritrail/compliance

One-click compliance reports generated directly from the Veritrail ledger.
Every control claim cites the specific ledger event ids that prove it, so
auditors can verify each row against the hash-chained receipts.

## What this package does

1. Declares compact, citation-only templates for four frameworks:
   - `soc2-cc7` — SOC 2 Common Criteria 7 (System Operations)
   - `eu-ai-act-annex-iv` — EU AI Act Annex IV technical documentation
   - `hipaa-security` — HIPAA Security Rule (45 CFR Part 164 Subpart C)
   - `iso-42001` — ISO/IEC 42001:2023 AI Management System
2. Queries the ledger for the event types each control requires.
3. Renders an auditor-ready Markdown report with per-control evidence and
   a gaps section.

PDF rendering is intentionally out of scope. Downstream code (the server
or CLI) is responsible for any PDF conversion, typically using `pdf-lib`
or `wkhtmltopdf`.

## Usage

```ts
import { createInMemoryLedger } from '@veritrail/core';
import {
  collectEvidence,
  renderMarkdown,
  requireFramework,
  windowEndingAt,
} from '@veritrail/compliance';

const ledger = createInMemoryLedger();
// ... append events through normal Veritrail flow ...

const framework = requireFramework('soc2-cc7');
const window = windowEndingAt(Date.now(), 30 * 24 * 60 * 60 * 1000);
const evidence = await collectEvidence(ledger, framework, window);
const markdown = renderMarkdown(framework, evidence, {
  window,
  entity: 'Acme Corp',
});
```

The `evidence` array contains, for every control, the ledger event ids
that satisfy it. The `markdown` string is the report.

## Frameworks

Each framework template lists between five and six controls that map
directly to ledger event types. The control ids follow the source
criteria (for example `SOC2.CC7.1`, `HIPAA.164.312.b`,
`EU-AI-ACT.AnnexIV.2c`, `ISO-42001.A.6.2.6`).

## Limitations

These templates are designed to demonstrate ledger-backed evidence for a
narrow but representative slice of each framework. They are not a
substitute for a full audit checklist. A real audit will require
additional organizational controls outside the ledger's scope.
