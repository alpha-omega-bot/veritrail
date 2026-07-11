# veritrail

Official Python client for the [Veritrail](https://veritrail.dev) audit and
policy server. Thin, typed wrapper around the HTTP API with a uniform error
model that matches the TypeScript SDK.

## Install

```bash
pip install veritrail
```

Requires Python 3.10+. The only runtime dependency is
[`httpx`](https://www.python-httpx.org/).

## Quickstart

```python
from veritrail import VeritrailClient, VeritrailError

client = VeritrailClient(
    base_url="http://localhost:8787",
    api_key="vt_live_...",      # forwarded as `Authorization: Bearer ...`
    timeout=30.0,
)

print(client.health())          # {"status": "ok", "name": "...", ...}

try:
    client.append_event({
        "type": "decision.recorded",
        "actor_id": "agent-7",
        "payload": {"choice": "approve"},
    })
except VeritrailError as err:
    # err.code is one of:
    #   VALIDATION, BUDGET_EXCEEDED, POLICY_DENIED, NOT_FOUND,
    #   CONFLICT, INTEGRITY, INTERNAL
    print(err.code, err.message, err.details)
```

## Auth

Pass an API key when constructing the client; it is sent as
`Authorization: Bearer <api_key>` on every request. Without a key, the client
talks to the server unauthenticated (useful for local development against
`http://localhost:8787`).

## Methods

| Method                                                                                           | Endpoint                      |
| ------------------------------------------------------------------------------------------------ | ----------------------------- |
| `health()`                                                                                       | `GET /api/health`             |
| `audit_summary()`                                                                                | `GET /api/audit/summary`      |
| `get_events(*, from_seq=..., to_seq=..., type=..., actor_id=..., correlation_id=..., limit=...)` | `GET /api/audit/events`       |
| `append_event(event)`                                                                            | `POST /api/events`            |
| `spend_status()`                                                                                 | `GET /api/spend/status`       |
| `verify_integrity()`                                                                             | `GET /api/audit/verify`       |
| `incident(correlation_id)`                                                                       | `GET /api/forensics/incident` |
| `authorize_spend(actor_id, amount_usd_minor, scope=None)`                                        | `POST /api/spend/charge`      |

All methods return the parsed JSON body on success and raise
`VeritrailError` on any non-2xx response. The error's `code` is mapped
from the HTTP status: `400→VALIDATION`, `402→BUDGET_EXCEEDED`,
`403→POLICY_DENIED`, `404→NOT_FOUND`, `409→CONFLICT`, `422→INTEGRITY`,
anything else → `INTERNAL`.

## License

Apache-2.0
