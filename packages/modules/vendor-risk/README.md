# @veritrail/vendor-risk

Vendor Risk engine for Veritrail — a **scaffold** capability that maintains an
inventory of third parties (model providers, APIs, data sources, infra) and
computes a **time-decayed risk score** from observed signals.

Like every Veritrail capability, it is a projection over the single
tamper-evident ledger. Vendors and signals are stored only as
`vendor.registered` and `vendor.signal` events; there is no separate store.

## What it does

- **Inventory** — register third parties (`register`) and list them (`listVendors`).
- **Signals** — record discrete risk observations (`recordSignal`) and query them
  per vendor (`signalsFor`).
- **Scoring** — `score` combines a criticality baseline with each signal's
  severity weight, decayed by age (half-life of 30 days). `assess` scores every
  vendor and sorts riskiest-first.
- **Monitoring** — `ingest` polls a pluggable `MonitorSource` and records its
  signals.

### Scoring model

```
score = criticalityBase + Σ severityWeight(signal) · 0.5 ^ (ageDays / 30)
```

| Criticality | Base |     | Severity | Weight |
| ----------- | ---- | --- | -------- | ------ |
| low         | 5    |     | info     | 1      |
| medium      | 10   |     | low      | 2      |
| high        | 20   |     | medium   | 5      |
| critical    | 35   |     | high     | 10     |
|             |      |     | critical | 20     |

`ageDays = max(0, (now − signalTimestamp) / 86_400_000)` using the signal's
authoritative ledger timestamp and the injected clock. The score is rounded.

Bands: `< 20` → `low`, `< 50` → `medium`, `< 100` → `high`, else `critical`.

## Public API

```ts
type RiskBand = 'low' | 'medium' | 'high' | 'critical';

interface VendorRiskScore {
  vendorId: string;
  name: string;
  score: number;
  band: RiskBand;
  signalCount: number;
  topSignals: VendorSignal[]; // up to 3 highest-severity
}

interface MonitorSource {
  readonly name: string;
  poll(): Promise<VendorSignal[]>;
}

class VendorRiskModule implements VeritrailModule {
  constructor(ctx: ModuleContext);
  register(input: unknown): Promise<Result<LedgerRecord, VeritrailError>>;
  recordSignal(input: unknown): Promise<Result<LedgerRecord, VeritrailError>>;
  listVendors(): Promise<Vendor[]>;
  signalsFor(vendorId: string): Promise<VendorSignal[]>;
  score(vendorId: string): Promise<Result<VendorRiskScore, VeritrailError>>;
  assess(): Promise<VendorRiskScore[]>;
  ingest(source: MonitorSource): Promise<number>;
}

function createVendorRiskModule(ctx: ModuleContext): VendorRiskModule;
```

`register`/`recordSignal` validate input with the core's `VendorSchema` /
`VendorSignalSchema`, assigning an id (`ven…` / `sig…`) when absent. Expected
failures are returned as `Result` errors (`VALIDATION`, `NOT_FOUND`) — never
thrown.

## Example

```ts
import {
  FixedClock,
  SequentialIdGenerator,
  createInMemoryLedger,
  noopLogger,
} from '@veritrail/core';
import { createVendorRiskModule } from '@veritrail/vendor-risk';

const clock = new FixedClock(Date.now());
const ledger = createInMemoryLedger({ clock, ids: new SequentialIdGenerator() });
const vr = createVendorRiskModule({
  ledger,
  clock,
  ids: new SequentialIdGenerator(),
  logger: noopLogger,
});

await vr.register({ id: 'ven_openai', name: 'OpenAI', category: 'llm', criticality: 'high' });
await vr.recordSignal({
  vendorId: 'ven_openai',
  kind: 'incident',
  severity: 'high',
  summary: 'Elevated error rates',
});

const ranked = await vr.assess(); // [{ vendorId: 'ven_openai', score, band, ... }]
```

## Phase 1 TODO

- **Real feeds** — `MonitorSource` adapters for status pages, CVE/advisory
  feeds, and SOC 2 / certification expiry.
- **Alert thresholds** — emit alerts (e.g. a `note` event) when a vendor crosses
  a configurable band or score delta.
- **SLA tracking** — track availability/uptime signals against contractual SLAs
  and surface breaches.
