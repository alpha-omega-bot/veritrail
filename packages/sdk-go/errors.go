package veritrail

import "fmt"

// Error is the typed error surface for SDK callers. The Code field mirrors the
// VeritrailErrorCode union used by the TypeScript SDK so multi-language callers
// can branch on the same set of strings without parsing HTTP status codes.
type Error struct {
	// Code is one of: VALIDATION, BUDGET_EXCEEDED, POLICY_DENIED, NOT_FOUND,
	// CONFLICT, INTEGRITY, UNSUPPORTED, INTERNAL, NETWORK.
	Code string
	// Message is the human-readable message. When the server returned an
	// error envelope, this is `error.message`; otherwise it falls back to
	// the HTTP status text or the underlying transport error string.
	Message string
	// Status is the HTTP status code, or 0 when the request never reached
	// the server (network failures, body-read failures, JSON decode failures).
	Status int
	// Details holds the decoded JSON body for non-2xx responses (typically the
	// server's `{ error: { ... } }` envelope), or nil when no body was decoded.
	Details any
}

// Error implements the error interface.
func (e *Error) Error() string {
	if e == nil {
		return ""
	}
	if e.Status != 0 {
		return fmt.Sprintf("veritrail: %s (%d): %s", e.Code, e.Status, e.Message)
	}
	return fmt.Sprintf("veritrail: %s: %s", e.Code, e.Message)
}

// statusToCode mirrors the TS SDK's statusToCode mapping. Any unmapped status
// (including 5xx) falls through to "INTERNAL" so callers handle remote and
// in-process failures with a single branch.
func statusToCode(status int) string {
	switch status {
	case 400:
		return "VALIDATION"
	case 402:
		return "BUDGET_EXCEEDED"
	case 403:
		return "POLICY_DENIED"
	case 404:
		return "NOT_FOUND"
	case 409:
		return "CONFLICT"
	case 422:
		return "INTEGRITY"
	case 501:
		return "UNSUPPORTED"
	default:
		return "INTERNAL"
	}
}
