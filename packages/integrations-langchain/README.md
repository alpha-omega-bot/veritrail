# @veritrail/integrations-langchain

LangChain JS callback handler that streams agent lifecycle events into a Veritrail server. Install with `pnpm add @veritrail/integrations-langchain @veritrail/sdk`. The package has no LangChain peer dependency — it duck-types `BaseCallbackHandler` so you bring your own LangChain version and the handler stays stable across releases. Every LLM start, tool invocation, and chain boundary is recorded as a Veritrail event so the standard audit, permissions, and forensics surfaces work out of the box.

## Usage

```ts
import { VeritrailClient } from '@veritrail/sdk';
import { VeritrailCallbackHandler } from '@veritrail/integrations-langchain';

const client = new VeritrailClient({ baseUrl: 'http://localhost:8787' });
const tracer = new VeritrailCallbackHandler({
  client,
  agentId: 'agent-7',
  correlationId: 'run-42',
});
await runnable.invoke({ input: 'hello' }, { callbacks: [tracer] });
```
