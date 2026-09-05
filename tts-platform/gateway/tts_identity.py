"""Signed entry identity; direct/local and global-key use stays administrative."""
from __future__ import annotations

import base64
import hashlib
import hmac
import json
import time
from contextvars import ContextVar
from pathlib import Path

from tts_config import cfg

identity: ContextVar[dict] = ContextVar("tts_identity", default={})


def owner() -> str | None:
    return identity.get().get("owner") or None


def can_access(record_owner: str | None, *, write: bool = False, shared: bool = False) -> bool:
    current = owner()
    return current is None or current == record_owner or (shared and not write and not record_owner)


def verify_identity(request) -> dict:
    encoded = request.headers.get("x-tts-context", "")
    signature = request.headers.get("x-tts-context-signature", "")
    if not encoded and not signature:
        return {}
    if not request.client or request.client.host not in {"127.0.0.1", "::1", "::ffff:127.0.0.1", "testclient"}:
        raise ValueError("Invalid gateway identity")
    try:
        trust_file = Path(cfg("TTS_GATEWAY_TRUST_FILE") or Path(__file__).resolve().parents[2] / ".gateway-trust.json")
        token = json.loads(trust_file.read_text(encoding="utf-8"))["token"]
        expected = base64.urlsafe_b64encode(hmac.new(token.encode(), encoded.encode(), hashlib.sha256).digest()).decode().rstrip("=")
        if not hmac.compare_digest(signature, expected):
            raise ValueError("Invalid signature")
        context = json.loads(base64.urlsafe_b64decode(encoded + "=" * (-len(encoded) % 4)))
        if abs(time.time() * 1000 - context["timestamp"]) > 300_000:
            raise ValueError("Expired signature")
        if context.get("method") != request.method or context.get("path") != request.url.path:
            raise ValueError("Wrong signature target")
        return context
    except (OSError, KeyError, TypeError, ValueError) as exc:
        raise ValueError("Invalid gateway identity") from exc
