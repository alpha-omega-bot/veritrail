"""HTTP client for the Veritrail server.

This module mirrors the TypeScript SDK in ``packages/sdk/src/client.ts``:
a thin wrapper over the HTTP API that returns parsed JSON on success and
raises :class:`VeritrailError` with a status-derived ``code`` on failure.
The error mapping is kept in sync with the TS SDK so that both clients
expose the same taxonomy to application code.
"""

from __future__ import annotations

import json as _json
from typing import Any, Mapping, Optional

import httpx

from .errors import VeritrailError


def _status_to_code(status: int) -> str:
    """Map an HTTP status code to a Veritrail error code.

    Mirrors ``statusToCode`` in the TypeScript SDK. Anything not in the
    table collapses to ``INTERNAL`` so that callers always see one of a
    small, finite set of codes.
    """
    if status == 400:
        return "VALIDATION"
    if status == 402:
        return "BUDGET_EXCEEDED"
    if status == 403:
        return "POLICY_DENIED"
    if status == 404:
        return "NOT_FOUND"
    if status == 409:
        return "CONFLICT"
    if status == 422:
        return "INTEGRITY"
    return "INTERNAL"


def _drop_none(params: Mapping[str, Any]) -> dict[str, Any]:
    """Return a copy of ``params`` with ``None`` values removed.

    httpx will happily serialize ``None`` as an empty string; the server
    treats absent and empty values differently, so we strip them here to
    match the TS SDK behavior (``URLSearchParams.set`` skipping ``undefined``).
    """
    return {k: v for k, v in params.items() if v is not None}


class VeritrailClient:
    """A thin, synchronous HTTP client for the Veritrail server.

    Parameters
    ----------
    base_url:
        Root URL of the Veritrail server. Trailing slash is normalized.
    api_key:
        Optional bearer token. When provided it is sent as
        ``Authorization: Bearer <api_key>`` on every request.
    timeout:
        Per-request timeout in seconds. Defaults to 30.
    """

    def __init__(
        self,
        base_url: str = "http://localhost:8787",
        api_key: Optional[str] = None,
        timeout: float = 30.0,
    ) -> None:
        self._base_url = base_url.rstrip("/")
        self._api_key = api_key
        self._timeout = timeout
        headers: dict[str, str] = {"content-type": "application/json"}
        if api_key:
            headers["authorization"] = f"Bearer {api_key}"
        self._client = httpx.Client(
            base_url=self._base_url,
            headers=headers,
            timeout=timeout,
        )

    # -- context manager / cleanup ---------------------------------------
    def close(self) -> None:
        """Close the underlying ``httpx.Client`` and release its sockets."""
        self._client.close()

    def __enter__(self) -> "VeritrailClient":
        return self

    def __exit__(self, *exc: Any) -> None:
        self.close()

    # -- core request helper ---------------------------------------------
    def _request(
        self,
        method: str,
        path: str,
        *,
        params: Optional[Mapping[str, Any]] = None,
        json: Any = None,
    ) -> Any:
        """Execute one request and normalize the response.

        Returns parsed JSON on 2xx; raises :class:`VeritrailError` with a
        status-derived code on anything else. Non-JSON error bodies are
        surfaced as ``VeritrailError`` carrying the HTTP reason phrase so
        callers never see a raw ``json.JSONDecodeError``.
        """
        request_kwargs: dict[str, Any] = {}
        if params is not None:
            request_kwargs["params"] = _drop_none(params)
        if json is not None:
            request_kwargs["json"] = json
        response = self._client.request(method, path, **request_kwargs)

        text = response.text
        parsed: Any = None
        if text:
            try:
                parsed = _json.loads(text)
            except ValueError:
                # Non-JSON body: surface as a typed error rather than
                # leaking a ValueError, matching the TS SDK contract.
                if response.is_error:
                    raise VeritrailError(
                        _status_to_code(response.status_code),
                        response.reason_phrase or "request failed",
                    )
                raise VeritrailError(
                    "INTERNAL", "expected JSON response body"
                )

        if response.is_error:
            message = response.reason_phrase or "request failed"
            details: Optional[dict[str, Any]] = None
            if isinstance(parsed, dict):
                details = parsed
                err = parsed.get("error")
                if isinstance(err, dict) and isinstance(err.get("message"), str):
                    message = err["message"]
            raise VeritrailError(
                _status_to_code(response.status_code), message, details
            )

        return parsed

    # -- public API ------------------------------------------------------
    def health(self) -> Any:
        """GET ``/api/health`` — server liveness + version probe."""
        return self._request("GET", "/api/health")

    def audit_summary(self) -> Any:
        """GET ``/api/audit/summary`` — audit log head + counts."""
        return self._request("GET", "/api/audit/summary")

    def get_events(
        self,
        *,
        from_seq: Optional[int] = None,
        to_seq: Optional[int] = None,
        type: Optional[str] = None,
        actor_id: Optional[str] = None,
        correlation_id: Optional[str] = None,
        limit: Optional[int] = None,
    ) -> Any:
        """GET ``/api/audit/events`` with optional filters.

        Query parameter names are camelCased to match the server contract.
        ``None`` filters are omitted from the query string entirely (rather
        than sent as empty strings), mirroring the TS SDK.
        """
        params = {
            "fromSeq": from_seq,
            "toSeq": to_seq,
            "type": type,
            "actorId": actor_id,
            "correlationId": correlation_id,
            "limit": limit,
        }
        return self._request("GET", "/api/audit/events", params=params)

    def append_event(self, event: dict[str, Any]) -> Any:
        """POST ``/api/events`` — append a single event to the audit log."""
        return self._request("POST", "/api/events", json=event)

    def spend_status(self) -> Any:
        """GET ``/api/spend/status`` — current budget utilization."""
        return self._request("GET", "/api/spend/status")

    def verify_integrity(self) -> Any:
        """GET ``/api/audit/verify`` — recompute and verify the audit chain."""
        return self._request("GET", "/api/audit/verify")

    def incident(self, correlation_id: str) -> Any:
        """GET ``/api/forensics/incident`` — full incident view for a correlation id."""
        return self._request(
            "GET",
            "/api/forensics/incident",
            params={"correlationId": correlation_id},
        )

    def authorize_spend(
        self,
        actor_id: str,
        amount_usd_minor: int,
        scope: Optional[dict[str, Any]] = None,
    ) -> Any:
        """POST ``/api/spend/charge`` — authorize a spend against an actor's budget.

        ``amount_usd_minor`` is the charge amount in USD minor units
        (i.e. cents). ``scope`` is forwarded as the optional ``labels``
        field on the server's authorize input.
        """
        body: dict[str, Any] = {
            "actorId": actor_id,
            "amount": amount_usd_minor,
        }
        if scope is not None:
            body["labels"] = scope
        return self._request("POST", "/api/spend/charge", json=body)
