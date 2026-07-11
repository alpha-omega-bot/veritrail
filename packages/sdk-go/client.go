// Package veritrail is a thin, typed HTTP client for the Veritrail server.
//
// The client exposes the same surface as the TypeScript @veritrail/sdk
// client: typed methods per endpoint, and error normalization that maps HTTP
// status codes onto the VeritrailErrorCode string set so multi-language
// callers branch on the same Code values.
package veritrail

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"
)

// DefaultBaseURL matches the TS SDK default so a no-arg client talks to a
// locally-running server.
const DefaultBaseURL = "http://localhost:8787"

// ClientOptions configures a Client. All fields are optional; zero values
// fall back to documented defaults.
type ClientOptions struct {
	// BaseURL of the Veritrail server, with no trailing slash required
	// (it is stripped). Defaults to DefaultBaseURL.
	BaseURL string
	// APIKey is sent as `Authorization: Bearer <key>` on every request when
	// non-empty.
	APIKey string
	// HTTP overrides the underlying http.Client. Defaults to a client with a
	// 30s timeout so callers cannot accidentally hang forever.
	HTTP *http.Client
	// Headers are merged onto every request after the SDK-managed
	// content-type and authorization headers (so callers can override them).
	Headers map[string]string
}

// Client is the Veritrail HTTP client.
type Client struct {
	// BaseURL is the resolved server URL (trailing slash stripped). Exposed
	// for callers that want to construct URLs the SDK does not cover.
	BaseURL string
	// APIKey is the bearer token sent on every request, or "" for none.
	APIKey string
	// HTTP is the underlying transport. Exposed so callers can swap it at
	// runtime (e.g. to install retry/tracing middleware).
	HTTP *http.Client

	headers map[string]string
}

// NewClient constructs a Client from the given options, filling in defaults
// for any zero-valued field.
func NewClient(opts ClientOptions) *Client {
	base := opts.BaseURL
	if base == "" {
		base = DefaultBaseURL
	}
	base = strings.TrimRight(base, "/")

	httpClient := opts.HTTP
	if httpClient == nil {
		httpClient = &http.Client{Timeout: 30 * time.Second}
	}

	headers := make(map[string]string, len(opts.Headers))
	for k, v := range opts.Headers {
		headers[k] = v
	}

	return &Client{
		BaseURL: base,
		APIKey:  opts.APIKey,
		HTTP:    httpClient,
		headers: headers,
	}
}

// do executes a single request and decodes the JSON body into out. Errors are
// normalized to *Error so callers branch on Code uniformly.
func (c *Client) do(ctx context.Context, method, path string, body any, out any) error {
	full := c.BaseURL + path

	var reader io.Reader
	if body != nil {
		buf, err := json.Marshal(body)
		if err != nil {
			return &Error{Code: "INTERNAL", Message: "failed to encode request body: " + err.Error()}
		}
		reader = bytes.NewReader(buf)
	}

	req, err := http.NewRequestWithContext(ctx, method, full, reader)
	if err != nil {
		return &Error{Code: "INTERNAL", Message: "failed to build request: " + err.Error()}
	}

	req.Header.Set("content-type", "application/json")
	req.Header.Set("accept", "application/json")
	if c.APIKey != "" {
		req.Header.Set("authorization", "Bearer "+c.APIKey)
	}
	for k, v := range c.headers {
		req.Header.Set(k, v)
	}

	resp, err := c.HTTP.Do(req)
	if err != nil {
		// Surface transport failures (DNS, connection refused, TLS, context
		// cancel) with a dedicated Code so callers can distinguish them from
		// server-returned errors without checking Status==0.
		return &Error{Code: "NETWORK", Message: err.Error()}
	}
	defer resp.Body.Close()

	raw, err := io.ReadAll(resp.Body)
	if err != nil {
		return &Error{Code: "NETWORK", Message: "failed to read response body: " + err.Error(), Status: resp.StatusCode}
	}

	if resp.StatusCode >= 400 {
		return decodeError(resp, raw)
	}

	if out == nil || len(raw) == 0 {
		return nil
	}
	if err := json.Unmarshal(raw, out); err != nil {
		return &Error{Code: "INTERNAL", Message: "failed to decode response body: " + err.Error(), Status: resp.StatusCode}
	}
	return nil
}

// decodeError builds a typed *Error from a non-2xx response, preferring the
// server's `{ error: { message } }` envelope and falling back to the HTTP
// status text when the body is empty or non-JSON.
func decodeError(resp *http.Response, raw []byte) error {
	code := statusToCode(resp.StatusCode)
	msg := resp.Status
	if msg == "" {
		msg = strconv.Itoa(resp.StatusCode)
	}

	var details any
	if len(raw) > 0 {
		var envelope struct {
			Error struct {
				Message string `json:"message"`
				Code    string `json:"code"`
			} `json:"error"`
		}
		if err := json.Unmarshal(raw, &envelope); err == nil {
			if envelope.Error.Message != "" {
				msg = envelope.Error.Message
			}
			// Preserve the full body as Details for callers that need
			// additional fields beyond message/code.
			var generic any
			if jerr := json.Unmarshal(raw, &generic); jerr == nil {
				details = generic
			}
		} else {
			// Non-JSON body (e.g. proxy error page): keep the HTTP status
			// text as the message and expose the raw bytes via Details so
			// callers can log them if needed.
			details = string(raw)
		}
	}

	return &Error{Code: code, Message: msg, Status: resp.StatusCode, Details: details}
}

// ---- API methods ------------------------------------------------------

// Health calls GET /api/health.
func (c *Client) Health(ctx context.Context) (Health, error) {
	var out Health
	err := c.do(ctx, http.MethodGet, "/api/health", nil, &out)
	return out, err
}

// AuditSummary calls GET /api/audit/summary. The response is preserved as raw
// JSON so callers can decode fields the SDK has not yet modeled.
func (c *Client) AuditSummary(ctx context.Context) (AuditSummary, error) {
	var out AuditSummary
	err := c.do(ctx, http.MethodGet, "/api/audit/summary", nil, &out)
	return out, err
}

// GetEvents calls GET /api/audit/events. Zero-valued query fields are omitted
// so an EventsQuery{} returns the unfiltered tail.
func (c *Client) GetEvents(ctx context.Context, q EventsQuery) ([]LedgerEvent, error) {
	var out []LedgerEvent
	path := "/api/audit/events" + encodeEventsQuery(q)
	err := c.do(ctx, http.MethodGet, path, nil, &out)
	return out, err
}

// AppendEvent calls POST /api/events. The event body is encoded as-is so the
// SDK does not need to track every event shape the server accepts.
func (c *Client) AppendEvent(ctx context.Context, event any) (AppendEventResponse, error) {
	var out AppendEventResponse
	err := c.do(ctx, http.MethodPost, "/api/events", event, &out)
	return out, err
}

// SpendStatus calls GET /api/spend/status.
func (c *Client) SpendStatus(ctx context.Context) (SpendStatus, error) {
	var out SpendStatus
	err := c.do(ctx, http.MethodGet, "/api/spend/status", nil, &out)
	return out, err
}

// VerifyIntegrity calls GET /api/audit/verify.
func (c *Client) VerifyIntegrity(ctx context.Context) (VerifyIntegrity, error) {
	var out VerifyIntegrity
	err := c.do(ctx, http.MethodGet, "/api/audit/verify", nil, &out)
	return out, err
}

// Incident calls GET /api/forensics/incident?correlationId=... A blank
// correlationId is rejected client-side so the server doesn't have to.
func (c *Client) Incident(ctx context.Context, correlationID string) (Incident, error) {
	var out Incident
	if correlationID == "" {
		return out, &Error{Code: "VALIDATION", Message: "correlationId is required"}
	}
	params := url.Values{}
	params.Set("correlationId", correlationID)
	err := c.do(ctx, http.MethodGet, "/api/forensics/incident?"+params.Encode(), nil, &out)
	return out, err
}

// AuthorizeSpend calls POST /api/spend/charge.
func (c *Client) AuthorizeSpend(ctx context.Context, req AuthorizeRequest) (AuthorizeResponse, error) {
	var out AuthorizeResponse
	err := c.do(ctx, http.MethodPost, "/api/spend/charge", req, &out)
	return out, err
}

// ---- helpers ----------------------------------------------------------

// encodeEventsQuery turns an EventsQuery into a query string (including the
// leading "?"), omitting zero-valued fields so callers can pass EventsQuery{}.
func encodeEventsQuery(q EventsQuery) string {
	v := url.Values{}
	if q.FromSeq > 0 {
		v.Set("fromSeq", strconv.FormatInt(q.FromSeq, 10))
	}
	if q.ToSeq > 0 {
		v.Set("toSeq", strconv.FormatInt(q.ToSeq, 10))
	}
	if q.Type != "" {
		v.Set("type", q.Type)
	}
	if q.ActorID != "" {
		v.Set("actorId", q.ActorID)
	}
	if q.CorrelationID != "" {
		v.Set("correlationId", q.CorrelationID)
	}
	if q.Limit > 0 {
		v.Set("limit", strconv.Itoa(q.Limit))
	}
	enc := v.Encode()
	if enc == "" {
		return ""
	}
	return "?" + enc
}

// AsError extracts a *Error from err if present, or nil otherwise. This is a
// convenience over errors.As for the common case of a single error type.
func AsError(err error) *Error {
	var e *Error
	if errors.As(err, &e) {
		return e
	}
	return nil
}
