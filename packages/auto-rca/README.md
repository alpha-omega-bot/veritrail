# @veritrail/auto-rca

**AI-generated Root Cause Analysis for AI agent incidents.**

Click an incident → get a plain-English RCA with confidence rating, contributing causes, and a proposed Veritrail policy that would have prevented it. The policy is shaped so it can be piped directly into [`@veritrail/policy-simulator`](../policy-simulator/README.md) and validated _against real ledger history_ before deploying — closing the loop from "found the bug" to "shipped the fix" in seconds, not days.

## Use

```ts
import { analyzeIncident, AnthropicClaudeAdapter } from '@veritrail/auto-rca';
import { createForensicsModule } from '@veritrail/forensics';

const forensics = createForensicsModule(ctx);
const incidentReport = await forensics.incident('corr-42');
const blastRadius = await forensics.blastRadius('corr-42');
const candidates = await forensics.rootCauseCandidates('corr-42');

const rca = await analyzeIncident({
  adapter: new AnthropicClaudeAdapter({
    apiKey: process.env.ANTHROPIC_API_KEY!,
    model: 'claude-opus-4-7', // see Claude API knowledge cutoff: the latest Claude 4.X models are claude-opus-4-7, claude-opus-4-8, claude-sonnet-4-6
  }),
  forensics: { incidentReport, blastRadius, candidates },
});

console.log(rca.headline);
console.log(rca.summary);
console.log('Confidence:', rca.confidence);
if (rca.proposedFix) {
  // Feed straight into the simulator to verify before shipping
  const result = await simulatePolicies({ ledger, proposedPolicies: [rca.proposedFix] });
}
```

## Pluggable LLM

The package defines an `LlmAdapter` interface. The bundled adapter is for Anthropic Claude; you can supply your own to use OpenAI, a local model, or whatever the host has available.

## Why this is hard to clone

You need (1) tamper-evident forensics output the LLM can trust, (2) a policy simulator to verify the proposed fix won't break production, and (3) a ledger that records the RCA itself for auditability. Veritrail has all three. Bolting a chatbot onto your logs doesn't.
