# veritrail-go

Go client SDK for the [Veritrail](https://veritrail.dev) HTTP server.

This module is published as `github.com/veritrail/sdk-go` and tracks the same
endpoint surface as the TypeScript `@veritrail/sdk` client.

## Install

```sh
go get github.com/veritrail/sdk-go
```

## Usage

```go
package main

import (
	"context"
	"fmt"
	"log"
	"time"

	veritrail "github.com/veritrail/sdk-go"
)

func main() {
	client := veritrail.NewClient(veritrail.ClientOptions{
		BaseURL: "https://api.veritrail.dev",
		APIKey:  "vt_live_...",
	})

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	health, err := client.Health(ctx)
	if err != nil {
		log.Fatalf("health: %v", err)
	}
	fmt.Printf("server %s up for %dms\n", health.Version, health.UptimeMs)

	// Append an audit event. The event body is encoded as-is so the SDK
	// does not need to track every event shape the server accepts.
	if _, err := client.AppendEvent(ctx, map[string]any{
		"type":          "agent.action",
		"actorId":       "agent-7",
		"correlationId": "trace-abc",
		"payload":       map[string]any{"tool": "search"},
	}); err != nil {
		log.Fatalf("append: %v", err)
	}

	// Authorize a spend. Money is the integer minor-unit form used by the
	// server (1500 = $15.00) so accumulation stays exact.
	resp, err := client.AuthorizeSpend(ctx, veritrail.AuthorizeRequest{
		ActorID: "agent-7",
		Amount:  veritrail.Money{Currency: "USD", MinorUnits: 1500},
	})
	if err != nil {
		// Branch on Code, not on HTTP status, so error handling is the
		// same as the TS and Python SDKs.
		if ve := veritrail.AsError(err); ve != nil {
			switch ve.Code {
			case "BUDGET_EXCEEDED":
				log.Printf("over budget: %s", ve.Message)
			case "POLICY_DENIED":
				log.Printf("policy blocked: %s", ve.Message)
			default:
				log.Printf("authorize failed: %s", ve.Error())
			}
		}
		return
	}
	fmt.Printf("authorized: %v budget=%s\n", resp.Allowed, resp.BudgetID)
}
```

## Endpoints covered

| Method                                  | HTTP                          |
| --------------------------------------- | ----------------------------- |
| `Health(ctx)`                           | `GET /api/health`             |
| `AuditSummary(ctx)`                     | `GET /api/audit/summary`      |
| `GetEvents(ctx, EventsQuery)`           | `GET /api/audit/events`       |
| `AppendEvent(ctx, event)`               | `POST /api/events`            |
| `VerifyIntegrity(ctx)`                  | `GET /api/audit/verify`       |
| `SpendStatus(ctx)`                      | `GET /api/spend/status`       |
| `AuthorizeSpend(ctx, AuthorizeRequest)` | `POST /api/spend/charge`      |
| `Incident(ctx, correlationId)`          | `GET /api/forensics/incident` |

## Errors

All methods return `(value, error)`. On failure the error is `*veritrail.Error`
with a `Code` drawn from the same string set as the TypeScript SDK:

- `VALIDATION` (400), `BUDGET_EXCEEDED` (402), `POLICY_DENIED` (403),
  `NOT_FOUND` (404), `CONFLICT` (409), `INTEGRITY` (422), `UNSUPPORTED` (501),
  `INTERNAL` (any other 4xx/5xx).
- `NETWORK` for transport failures that never reached the server
  (DNS, refused connection, context cancellation, body read).

Use `veritrail.AsError(err)` to extract the typed error in one call.

## Requirements

- Go 1.22 or newer.

## License

Same license as the parent Veritrail monorepo.
