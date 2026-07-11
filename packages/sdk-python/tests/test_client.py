"""Unit tests for ``veritrail.VeritrailClient`` using respx to mock httpx."""

from __future__ import annotations

import json

import httpx
import pytest
import respx

from veritrail import VeritrailClient, VeritrailError


BASE_URL = "http://localhost:8787"


@pytest.fixture
def client() -> VeritrailClient:
    """A default client pointed at the mocked base URL, no api key."""
    c = VeritrailClient(base_url=BASE_URL)
    yield c
    c.close()


def test_client_constructs_with_defaults() -> None:
    """Defaults: ``localhost:8787``, no Authorization header, 30s timeout."""
    c = VeritrailClient()
    try:
        assert c._base_url == "http://localhost:8787"
        assert c._timeout == 30.0
        assert "authorization" not in c._client.headers
        assert c._client.headers["content-type"] == "application/json"
    finally:
        c.close()


def test_api_key_is_sent_as_bearer() -> None:
    """``api_key`` is forwarded as ``Authorization: Bearer <key>`` on requests."""
    c = VeritrailClient(base_url=BASE_URL, api_key="vt_test_123")
    try:
        with respx.mock(base_url=BASE_URL) as mock:
            route = mock.get("/api/health").respond(
                200, json={"status": "ok"}
            )
            c.health()
            assert route.called
            sent = route.calls.last.request
            assert sent.headers["authorization"] == "Bearer vt_test_123"
    finally:
        c.close()


def test_403_maps_to_policy_denied(client: VeritrailClient) -> None:
    """A 403 response surfaces as ``VeritrailError(code='POLICY_DENIED')``."""
    with respx.mock(base_url=BASE_URL) as mock:
        mock.get("/api/audit/summary").respond(
            403,
            json={"error": {"message": "scope mismatch"}},
        )
        with pytest.raises(VeritrailError) as exc_info:
            client.audit_summary()
        err = exc_info.value
        assert err.code == "POLICY_DENIED"
        assert err.message == "scope mismatch"
        assert err.details == {"error": {"message": "scope mismatch"}}


def test_success_returns_parsed_json_body(client: VeritrailClient) -> None:
    """A 2xx JSON body is returned verbatim from ``_request``."""
    payload = {"status": "ok", "name": "veritrail", "version": "1.2.3", "uptimeMs": 42}
    with respx.mock(base_url=BASE_URL) as mock:
        mock.get("/api/health").respond(200, json=payload)
        result = client.health()
    assert result == payload


def test_get_events_omits_none_params_but_keeps_values(client: VeritrailClient) -> None:
    """``None`` filters disappear from the query string; values pass through."""
    with respx.mock(base_url=BASE_URL) as mock:
        route = mock.get("/api/audit/events").respond(200, json=[])
        client.get_events(from_seq=10, limit=50, actor_id="agent-1")
        assert route.called
        sent_url = route.calls.last.request.url
        # The three provided params encode; None ones are absent.
        qp = dict(sent_url.params.multi_items())
        assert qp == {"fromSeq": "10", "limit": "50", "actorId": "agent-1"}


def test_append_event_posts_json_body(client: VeritrailClient) -> None:
    """``append_event`` POSTs the event as the JSON body."""
    event = {
        "type": "decision.recorded",
        "actorId": "agent-7",
        "payload": {"choice": "approve"},
    }
    with respx.mock(base_url=BASE_URL) as mock:
        route = mock.post("/api/events").respond(
            200, json={"record": {"seq": 1}}
        )
        result = client.append_event(event)
        assert route.called
        sent = route.calls.last.request
        assert sent.method == "POST"
        assert json.loads(sent.content.decode("utf-8")) == event
        assert sent.headers["content-type"].startswith("application/json")
        assert result == {"record": {"seq": 1}}


def test_authorize_spend_posts_actor_amount_and_scope(client: VeritrailClient) -> None:
    """``authorize_spend`` sends ``actorId``, ``amount``, and optional ``labels``."""
    with respx.mock(base_url=BASE_URL) as mock:
        route = mock.post("/api/spend/charge").respond(
            200, json={"ok": True}
        )
        client.authorize_spend(
            actor_id="agent-7",
            amount_usd_minor=250,
            scope={"team": "growth"},
        )
        body = json.loads(route.calls.last.request.content.decode("utf-8"))
        assert body == {
            "actorId": "agent-7",
            "amount": 250,
            "labels": {"team": "growth"},
        }


def test_non_2xx_without_json_body_still_raises_typed_error(client: VeritrailClient) -> None:
    """A non-JSON 500 still becomes ``VeritrailError(code='INTERNAL')``."""
    with respx.mock(base_url=BASE_URL) as mock:
        mock.get("/api/health").mock(
            return_value=httpx.Response(500, text="<html>boom</html>")
        )
        with pytest.raises(VeritrailError) as exc_info:
            client.health()
        assert exc_info.value.code == "INTERNAL"


def test_incident_passes_correlation_id_as_query(client: VeritrailClient) -> None:
    """``incident`` forwards the correlation id as ``correlationId`` query param."""
    with respx.mock(base_url=BASE_URL) as mock:
        route = mock.get("/api/forensics/incident").respond(
            200, json={"events": []}
        )
        client.incident("corr-123")
        qp = dict(route.calls.last.request.url.params.multi_items())
        assert qp == {"correlationId": "corr-123"}
