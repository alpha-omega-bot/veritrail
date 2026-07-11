package veritrail

import (
	"context"
	"encoding/json"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

// newTestServer wires a handler into an httptest server and returns a Client
// pointed at it, so each test reads as `arrange/act/assert` without boilerplate.
func newTestServer(t *testing.T, handler http.HandlerFunc, apiKey string) (*Client, *httptest.Server) {
	t.Helper()
	srv := httptest.NewServer(handler)
	t.Cleanup(srv.Close)
	client := NewClient(ClientOptions{BaseURL: srv.URL, APIKey: apiKey})
	return client, srv
}

func TestNewClientDefaults(t *testing.T) {
	c := NewClient(ClientOptions{})
	if c.BaseURL != DefaultBaseURL {
		t.Fatalf("BaseURL = %q, want %q", c.BaseURL, DefaultBaseURL)
	}
	if c.HTTP == nil {
		t.Fatal("HTTP client should not be nil")
	}
	if c.APIKey != "" {
		t.Fatalf("APIKey = %q, want empty", c.APIKey)
	}

	// Trailing slashes in BaseURL must be stripped so path joining stays
	// canonical regardless of how callers spelled the URL.
	c2 := NewClient(ClientOptions{BaseURL: "https://example.com/"})
	if c2.BaseURL != "https://example.com" {
		t.Fatalf("trailing slash not stripped: %q", c2.BaseURL)
	}
}

func TestHealth(t *testing.T) {
	client, _ := newTestServer(t, func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/health" {
			t.Errorf("path = %q, want /api/health", r.URL.Path)
		}
		if r.Method != http.MethodGet {
			t.Errorf("method = %q, want GET", r.Method)
		}
		_ = json.NewEncoder(w).Encode(Health{Status: "ok", Name: "veritrail", Version: "1.0.0", UptimeMs: 1234})
	}, "")

	got, err := client.Health(context.Background())
	if err != nil {
		t.Fatalf("Health: %v", err)
	}
	if got.Status != "ok" || got.Name != "veritrail" || got.Version != "1.0.0" || got.UptimeMs != 1234 {
		t.Fatalf("unexpected Health: %+v", got)
	}
}

func TestAppendEventPostsJSONWithAuthHeader(t *testing.T) {
	client, _ := newTestServer(t, func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			t.Errorf("method = %q, want POST", r.Method)
		}
		if r.URL.Path != "/api/events" {
			t.Errorf("path = %q, want /api/events", r.URL.Path)
		}
		if ct := r.Header.Get("content-type"); ct != "application/json" {
			t.Errorf("content-type = %q, want application/json", ct)
		}
		if auth := r.Header.Get("authorization"); auth != "Bearer test-key" {
			t.Errorf("authorization = %q, want Bearer test-key", auth)
		}
		body, _ := io.ReadAll(r.Body)
		var got map[string]any
		if err := json.Unmarshal(body, &got); err != nil {
			t.Fatalf("server got non-JSON body %q: %v", body, err)
		}
		if got["type"] != "test.event" {
			t.Errorf("body.type = %v, want test.event", got["type"])
		}
		w.WriteHeader(http.StatusCreated)
		_, _ = w.Write([]byte(`{"record":{"seq":42}}`))
	}, "test-key")

	resp, err := client.AppendEvent(context.Background(), map[string]any{
		"type":    "test.event",
		"actorId": "actor-1",
	})
	if err != nil {
		t.Fatalf("AppendEvent: %v", err)
	}
	if !strings.Contains(string(resp.Record), `"seq":42`) {
		t.Fatalf("Record = %s, want it to contain seq:42", resp.Record)
	}
}

func TestGetEventsEncodesQueryParams(t *testing.T) {
	var capturedQuery string
	client, _ := newTestServer(t, func(w http.ResponseWriter, r *http.Request) {
		capturedQuery = r.URL.RawQuery
		_, _ = w.Write([]byte(`[]`))
	}, "")

	cases := []struct {
		name  string
		query EventsQuery
		want  []string // substrings expected in the raw query
		empty bool
	}{
		{
			name:  "empty query produces no query string",
			query: EventsQuery{},
			empty: true,
		},
		{
			name:  "all fields encode",
			query: EventsQuery{FromSeq: 1, ToSeq: 10, Type: "spend.charged", ActorID: "actor-1", CorrelationID: "corr-9", Limit: 50},
			want:  []string{"fromSeq=1", "toSeq=10", "type=spend.charged", "actorId=actor-1", "correlationId=corr-9", "limit=50"},
		},
		{
			name:  "zero fromSeq omitted, type only",
			query: EventsQuery{Type: "audit.append"},
			want:  []string{"type=audit.append"},
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			capturedQuery = ""
			_, err := client.GetEvents(context.Background(), tc.query)
			if err != nil {
				t.Fatalf("GetEvents: %v", err)
			}
			if tc.empty {
				if capturedQuery != "" {
					t.Fatalf("expected no query string, got %q", capturedQuery)
				}
				return
			}
			for _, s := range tc.want {
				if !strings.Contains(capturedQuery, s) {
					t.Errorf("query %q missing %q", capturedQuery, s)
				}
			}
			// Zero-valued FromSeq must not be present when explicitly omitted.
			if tc.query.FromSeq == 0 && strings.Contains(capturedQuery, "fromSeq=") {
				t.Errorf("query %q should not include fromSeq when zero", capturedQuery)
			}
		})
	}
}

func TestGetEvents403ReturnsPolicyDenied(t *testing.T) {
	client, _ := newTestServer(t, func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("content-type", "application/json")
		w.WriteHeader(http.StatusForbidden)
		_, _ = w.Write([]byte(`{"error":{"code":"POLICY_DENIED","message":"label scope mismatch"}}`))
	}, "")

	_, err := client.GetEvents(context.Background(), EventsQuery{})
	if err == nil {
		t.Fatal("expected error from 403, got nil")
	}
	ve := AsError(err)
	if ve == nil {
		t.Fatalf("expected *Error, got %T: %v", err, err)
	}
	if ve.Code != "POLICY_DENIED" {
		t.Errorf("Code = %q, want POLICY_DENIED", ve.Code)
	}
	if ve.Status != http.StatusForbidden {
		t.Errorf("Status = %d, want 403", ve.Status)
	}
	if !strings.Contains(ve.Message, "label scope mismatch") {
		t.Errorf("Message = %q, want server message", ve.Message)
	}
	if ve.Details == nil {
		t.Error("expected Details to carry the decoded envelope")
	}
}

func TestStatusToCodeMappings(t *testing.T) {
	cases := map[int]string{
		400: "VALIDATION",
		402: "BUDGET_EXCEEDED",
		403: "POLICY_DENIED",
		404: "NOT_FOUND",
		409: "CONFLICT",
		422: "INTEGRITY",
		501: "UNSUPPORTED",
		500: "INTERNAL",
		418: "INTERNAL", // unmapped statuses fall through to INTERNAL
	}
	for status, want := range cases {
		if got := statusToCode(status); got != want {
			t.Errorf("statusToCode(%d) = %q, want %q", status, got, want)
		}
	}
}

func TestHealthOnConnectionRefusedReturnsNetworkError(t *testing.T) {
	// Bind to a port then immediately close so the address is guaranteed not
	// to be listening when the client dials. Using port 1 directly is racy
	// across OSes; this is portable.
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	addr := ln.Addr().String()
	_ = ln.Close()

	client := NewClient(ClientOptions{
		BaseURL: "http://" + addr,
		HTTP:    &http.Client{Timeout: 2 * time.Second},
	})

	_, err = client.Health(context.Background())
	if err == nil {
		t.Fatal("expected network error, got nil")
	}
	ve := AsError(err)
	if ve == nil {
		t.Fatalf("expected *Error, got %T: %v", err, err)
	}
	if ve.Code != "NETWORK" {
		t.Errorf("Code = %q, want NETWORK", ve.Code)
	}
	if ve.Status != 0 {
		t.Errorf("Status = %d, want 0 (transport never reached server)", ve.Status)
	}
}

func TestAuthorizeSpendPostsTypedBody(t *testing.T) {
	client, _ := newTestServer(t, func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/spend/charge" {
			t.Errorf("path = %q, want /api/spend/charge", r.URL.Path)
		}
		body, _ := io.ReadAll(r.Body)
		var got map[string]any
		if err := json.Unmarshal(body, &got); err != nil {
			t.Fatalf("non-JSON body: %v", err)
		}
		if got["actorId"] != "agent-7" {
			t.Errorf("actorId = %v, want agent-7", got["actorId"])
		}
		amt, ok := got["amount"].(map[string]any)
		if !ok {
			t.Fatalf("amount missing or wrong type: %v", got["amount"])
		}
		// Money JSON keys must match the server's MoneySchema (currency,
		// amountMinor) — the Go struct tags rename MinorUnits to amountMinor.
		if amt["currency"] != "USD" || amt["amountMinor"].(float64) != 1500 {
			t.Errorf("amount payload wrong: %v", amt)
		}
		_, _ = w.Write([]byte(`{"allowed":true,"budgetId":"b1","correlationId":"corr-1"}`))
	}, "")

	resp, err := client.AuthorizeSpend(context.Background(), AuthorizeRequest{
		ActorID: "agent-7",
		Amount:  Money{Currency: "USD", MinorUnits: 1500},
	})
	if err != nil {
		t.Fatalf("AuthorizeSpend: %v", err)
	}
	if !resp.Allowed {
		t.Error("Allowed should be true")
	}
	if resp.BudgetID != "b1" || resp.CorrelationID != "corr-1" {
		t.Errorf("unexpected response: %+v", resp)
	}
}

func TestIncidentRequiresCorrelationID(t *testing.T) {
	// Server should never be called when the client rejects the input.
	client, _ := newTestServer(t, func(w http.ResponseWriter, r *http.Request) {
		t.Fatalf("server should not have been called, got %s %s", r.Method, r.URL)
	}, "")

	_, err := client.Incident(context.Background(), "")
	ve := AsError(err)
	if ve == nil || ve.Code != "VALIDATION" {
		t.Fatalf("expected VALIDATION error, got %v", err)
	}
}

func TestNonJSONErrorBodyKeepsStatusText(t *testing.T) {
	client, _ := newTestServer(t, func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("content-type", "text/html")
		w.WriteHeader(http.StatusBadGateway)
		_, _ = w.Write([]byte("<html>bad gateway</html>"))
	}, "")

	_, err := client.Health(context.Background())
	ve := AsError(err)
	if ve == nil {
		t.Fatalf("expected *Error, got %T", err)
	}
	if ve.Code != "INTERNAL" {
		t.Errorf("Code = %q, want INTERNAL (502 maps to INTERNAL)", ve.Code)
	}
	if ve.Status != http.StatusBadGateway {
		t.Errorf("Status = %d, want 502", ve.Status)
	}
	// Details should hold the raw body string for callers that want to log it.
	if s, ok := ve.Details.(string); !ok || !strings.Contains(s, "bad gateway") {
		t.Errorf("Details = %v, want raw body string containing 'bad gateway'", ve.Details)
	}
}

func TestErrorErrorMethod(t *testing.T) {
	e := &Error{Code: "POLICY_DENIED", Message: "nope", Status: 403}
	got := e.Error()
	if !strings.Contains(got, "POLICY_DENIED") || !strings.Contains(got, "403") || !strings.Contains(got, "nope") {
		t.Errorf("Error() = %q, want it to mention code, status, and message", got)
	}

	// Network errors (Status==0) should still produce a readable string.
	netErr := &Error{Code: "NETWORK", Message: "connection refused"}
	if !strings.Contains(netErr.Error(), "NETWORK") {
		t.Errorf("network Error() = %q, want NETWORK in message", netErr.Error())
	}
}
