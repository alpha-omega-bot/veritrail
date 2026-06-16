# Veritrail examples

Runnable, self-contained examples.

## quickstart

A governed agent loop end to end: deny-by-default permissions, a hard-stop
budget, every action recorded on the tamper-evident ledger, an audit summary +
integrity check, and a live tamper-detection demo.

```bash
pnpm install
pnpm --filter @veritrail/examples quickstart
```

Source: [`quickstart.ts`](./quickstart.ts).
