# @veritrail/policy-simulator

**Replay a proposed policy set against your actual ledger history and see what would have happened — before you ship the change.**

Security teams change governance policy in fear: too tight and you break the agents in production; too loose and you ship the next incident. Veritrail's ledger records every `action.proposed`, `action.authorized`, and `action.denied` event. The simulator replays a proposed policy set against that history using the exact same `evaluate()` function that runs in production, and returns:

- **Per-event diff**: which decisions flipped and why.
- **Blast radius**: how many actors and action types are affected.
- **Newly-denied samples**: the most likely breaking changes to spot-check.

## Use

```ts
import { createInMemoryLedger } from '@veritrail/core';
import { simulatePolicies } from '@veritrail/policy-simulator';

const result = await simulatePolicies({
  ledger,
  proposedPolicies: [
    {
      id: 'pol-no-external-egress',
      name: 'Block all external egress',
      effect: 'deny',
      match: { actionTypes: ['network.egress'] },
      enabled: true,
      priority: 100,
      description: '',
    },
  ],
  window: { fromSeq: 1, toSeq: 100_000 },
});

console.log(
  `Blast radius: ${result.blastRadius.eventsChanged}/${result.blastRadius.eventsReplayed} ` +
    `events flipped (${result.blastRadius.affectedActors.length} actors affected)`,
);

for (const sample of result.newlyDeniedSamples) {
  console.log(`Would now deny:`, sample.action);
}
```

## Why this is hard to clone

The simulator works because Veritrail has a **tamper-evident, hash-chained ledger of every agent action** — competitors logging to a mutable database can't promise the replay is over real history. Receipts (`@veritrail/receipt`) prove the underlying records, and the simulator inherits that proof.
