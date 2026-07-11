"""Official Python SDK for the Veritrail audit and policy server."""

from .client import VeritrailClient
from .errors import VeritrailError

__all__ = ["VeritrailClient", "VeritrailError"]
__version__ = "0.1.0"
