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

/** Labels written onto vendor facts (e.g. tenant/project) for scoped ingest. */
interface VendorRiskRecordOptions {
  readonly labels?: Readonly<Record<string, string>>;
}

/** Exact-label filter applied to vendor reads for tenant-scoped projections. */
interface VendorRiskProjectionOptions {
  readonly labels?: Readonly<Record<string, string>>;
}

/** Construction-time options. */
interface VendorRiskConfig {
  /** Emit a `note` alert when a signal raises a vendor up across this band. */
  readonly alertBand?: RiskBand;
}

class VendorRiskModule implements VeritrailModule {
  constructor(ctx: ModuleContext, config?: VendorRiskConfig);
  register(
    input: unknown,
    opts?: VendorRiskRecordOptions,
  ): Promise<Result<LedgerRecord, VeritrailError>>;
  recordSignal(
    input: unknown,
    opts?: VendorRiskRecordOptions,
  ): Promise<Result<LedgerRecord, VeritrailError>>;
  listVendors(opts?: VendorRiskProjectionOptions): Promise<Vendor[]>;
  signalsFor(vendorId: string, opts?: VendorRiskProjectionOptions): Promise<VendorSignal[]>;
  score(
    vendorId: string,
    opts?: VendorRiskProjectionOptions,
  ): Promise<Result<VendorRiskScore, VeritrailError>>;
  assess(opts?: VendorRiskProjectionOptions): Promise<VendorRiskScore[]>;
  ingest(source: MonitorSource): Promise<number>;
}

function createVendorRiskModule(ctx: ModuleContext, config?: VendorRiskConfig): VendorRiskModule;
```

`register`/`recordSignal` validate input with the core's `VendorSchema` /
`VendorSignalSchema`, assigning an id (`ven…` / `sig…`) when absent. Expected
failures are returned as `Result` errors (`VALIDATION`, `NOT_FOUND`) — never
thrown.

Passing `labels` on a write stamps them onto the `vendor.registered` /
`vendor.signal` event envelope; passing `labels` on a read restricts the
projection to vendor facts carrying exactly those labels. The server uses these
options to enforce per-tenant API-key label scopes; a vendor registered without
labels is not visible to a label-scoped reader.

### Alert thresholds

When constructed with `{ alertBand }`, `recordSignal` appends a `note` alert fact
whenever a signal raises a vendor's time-decayed score **up across** that band —
i.e. the vendor was below `alertBand` before the signal and at/above it after,
both computed at the same instant. This is **edge-triggered**: a vendor already
in-band does not re-alert on every subsequent signal. The alert `note` carries
`data: { kind: 'vendor-risk.alert', vendorId, signalId, fromBand, toBand,
alertBand, score }` and inherits the signal's labels. Alerting is best-effort:
the `vendor.signal` append is always the returned record, and a failed alert is
logged rather than failing the signal. It is computed as a pure projection over
signal history — no state is held outside the ledger.

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
- **SLA tracking** — track availability/uptime signals against contractual SLAs
  and surface breaches.
