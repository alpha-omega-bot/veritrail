"""Typed error surface for the Veritrail Python SDK."""

from __future__ import annotations

from typing import Any, Optional


class VeritrailError(Exception):
    """A normalized error raised by :class:`VeritrailClient`.

    The ``code`` field mirrors the TypeScript SDK's ``VeritrailErrorCode``
    enum and is derived from the HTTP status of the failing response.
    Callers can branch on ``code`` instead of inspecting status numbers
    or exception subclasses.

    Attributes
    ----------
    code:
        One of ``"VALIDATION"``, ``"BUDGET_EXCEEDED"``, ``"POLICY_DENIED"``,
        ``"NOT_FOUND"``, ``"CONFLICT"``, ``"INTEGRITY"``, ``"INTERNAL"``.
    message:
        Human-readable summary, sourced from the server's
        ``error.message`` field when present.
    details:
        The decoded JSON error body, if any, for callers that need
        structured context. ``None`` when the body was empty or
        unparseable.
    """

    code: str
    message: str
    details: Optional[dict[str, Any]]

    def __init__(
        self,
        code: str,
        message: str,
        details: Optional[dict[str, Any]] = None,
    ) -> None:
        super().__init__(f"{code}: {message}")
        self.code = code
        self.message = message
        self.details = details

    def __repr__(self) -> str:  # pragma: no cover - debugging aid
        return f"VeritrailError(code={self.code!r}, message={self.message!r})"
