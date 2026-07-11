package veritrail

import "encoding/json"

// Money represents a monetary amount as an integer count of the currency's
// minor unit (e.g. cents), matching the server's MoneySchema. JSON encoding
// uses the server's field name `amountMinor`.
type Money struct {
	Currency   string `json:"currency"`
	MinorUnits int64  `json:"amountMinor"`
}

// Health is the response shape of GET /api/health.
type Health struct {
	Status   string `json:"status"`
	Name     string `json:"name"`
	Version  string `json:"version"`
	UptimeMs int64  `json:"uptimeMs"`
}

// AuditSummary is the (opaque) response of GET /api/audit/summary. The server
// returns a JSON object whose fields are versioned independently of the SDK,
// so it is exposed as a generic map plus a Raw view for forward-compatibility.
type AuditSummary struct {
	Raw json.RawMessage `json:"-"`
}

// UnmarshalJSON keeps the raw bytes so callers can decode fields the SDK has
// not yet learned about, while still satisfying the (response, error) contract.
func (a *AuditSummary) UnmarshalJSON(data []byte) error {
	a.Raw = append(a.Raw[:0], data...)
	return nil
}

// LedgerEvent is the projection of an audit-ledger event. Fields the SDK does
// not statically model are preserved in Extra to keep the client forward-
// compatible with new event shapes.
type LedgerEvent struct {
	Seq           int64                  `json:"seq"`
	Type          string                 `json:"type"`
	ActorID       string                 `json:"actorId,omitempty"`
	CorrelationID string                 `json:"correlationId,omitempty"`
	Timestamp     string                 `json:"timestamp,omitempty"`
	Payload       map[string]any         `json:"payload,omitempty"`
	Extra         map[string]any         `json:"-"`
}

// EventsQuery is the optional filter for GET /api/audit/events. Zero values
// are omitted from the query string so a default EventsQuery{} matches all.
type EventsQuery struct {
	FromSeq       int64
	ToSeq         int64
	Type          string
	ActorID       string
	CorrelationID string
	Limit         int
}

// SpendBudgetStatus is one row of GET /api/spend/status.
type SpendBudgetStatus struct {
	BudgetID  string         `json:"budgetId"`
	Labels    map[string]string `json:"labels,omitempty"`
	Limit     Money          `json:"limit"`
	Spent     Money          `json:"spent"`
	Remaining Money          `json:"remaining"`
}

// SpendStatus is the response of GET /api/spend/status — a list of budgets.
type SpendStatus struct {
	Budgets []SpendBudgetStatus `json:"-"`
}

// UnmarshalJSON accepts both a bare array (current server shape) and a
// `{ budgets: [...] }` envelope, so the SDK survives the server adopting an
// envelope without a breaking change.
func (s *SpendStatus) UnmarshalJSON(data []byte) error {
	var arr []SpendBudgetStatus
	if err := json.Unmarshal(data, &arr); err == nil {
		s.Budgets = arr
		return nil
	}
	var env struct {
		Budgets []SpendBudgetStatus `json:"budgets"`
	}
	if err := json.Unmarshal(data, &env); err != nil {
		return err
	}
	s.Budgets = env.Budgets
	return nil
}

// VerifyIntegrity is the response of GET /api/audit/verify.
type VerifyIntegrity struct {
	OK      bool    `json:"ok"`
	Checked int64   `json:"checked"`
	Head    *string `json:"head"`
}

// Incident is the response of GET /api/forensics/incident.
type Incident struct {
	CorrelationID string          `json:"correlationId"`
	Events        []LedgerEvent   `json:"events,omitempty"`
	Raw           json.RawMessage `json:"-"`
}

// UnmarshalJSON preserves the full payload alongside the typed projection so
// forensic callers can read fields beyond the SDK's static model.
func (i *Incident) UnmarshalJSON(data []byte) error {
	type alias Incident
	var a alias
	if err := json.Unmarshal(data, &a); err != nil {
		return err
	}
	*i = Incident(a)
	i.Raw = append(i.Raw[:0], data...)
	return nil
}

// AuthorizeRequest is the body posted to POST /api/spend/charge. ActionID and
// Labels are optional and omitted when empty.
type AuthorizeRequest struct {
	ActorID  string            `json:"actorId"`
	Amount   Money             `json:"amount"`
	Labels   map[string]string `json:"labels,omitempty"`
	ActionID string            `json:"actionId,omitempty"`
}

// AuthorizeResponse is the response of POST /api/spend/charge. The server
// returns either an authorization receipt or a typed error envelope; the
// receipt fields are preserved both typed and raw.
type AuthorizeResponse struct {
	Allowed       bool            `json:"allowed"`
	BudgetID      string          `json:"budgetId,omitempty"`
	Charged       *Money          `json:"charged,omitempty"`
	Remaining     *Money          `json:"remaining,omitempty"`
	CorrelationID string          `json:"correlationId,omitempty"`
	Raw           json.RawMessage `json:"-"`
}

// UnmarshalJSON keeps the raw response so callers can extract fields not
// statically modeled by the SDK without losing the typed projection.
func (a *AuthorizeResponse) UnmarshalJSON(data []byte) error {
	type alias AuthorizeResponse
	var x alias
	if err := json.Unmarshal(data, &x); err != nil {
		return err
	}
	*a = AuthorizeResponse(x)
	a.Raw = append(a.Raw[:0], data...)
	return nil
}

// AppendEventResponse is the response of POST /api/events. The wrapped record
// is opaque so the SDK does not need to track every event shape the server
// accepts.
type AppendEventResponse struct {
	Record json.RawMessage `json:"record"`
}
