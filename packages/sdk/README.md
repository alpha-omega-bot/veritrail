# @veritrail/sdk

Typed integration helpers for agent runtimes.

## Exports

- `Governor` / `createGovernor` — in-process instrumentation for the
  propose -> permissions -> spend guard -> execute -> record lifecycle over one
  Veritrail ledger.
- `VeritrailClient` — thin HTTP client for `@veritrail/server`.
- `createModuleContext` — shared module context factory for embedding modules.

`VeritrailClient` surfaces remote failures as `VeritrailError` values. This
includes non-JSON proxy/server responses, which are wrapped instead of leaking
raw `SyntaxError` exceptions.
