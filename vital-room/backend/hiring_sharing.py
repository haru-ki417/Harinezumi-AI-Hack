"""Discover a server-managed public origin and verify it reaches this backend.

Only deployment configuration and the local tunnel launcher can supply URLs.
The public identity is deliberately harmless; it is not an authentication token.
"""
from __future__ import annotations

from collections import OrderedDict
from http.client import HTTPException
import ipaddress
import json
import os
from pathlib import Path
import re
import secrets
import threading
import time
from urllib.error import HTTPError, URLError
from urllib.parse import urlsplit
from urllib.request import HTTPRedirectHandler, Request, build_opener

MAX_URL_BYTES = 2048
MAX_IDENTITY_BYTES = 1024
PROBE_TIMEOUT_SECONDS = 3
IDENTITY_PATH = "/api/hiring/sharing/identity"
_INSTANCE_ID = secrets.token_urlsafe(24)
_cache_lock = threading.Lock()
_cache: OrderedDict[tuple, tuple[float, bool]] = OrderedDict()


class _NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def identity() -> dict:
    return {"instance_id": _INSTANCE_ID}


def _public_origin(value: str, *, tunnel_file: bool) -> str | None:
    """Accept an HTTPS origin, never credentials, a path, or a local address."""
    if not value or len(value.encode("utf-8")) > MAX_URL_BYTES:
        return None
    if re.search(r"[\s\x00-\x1f\x7f\\%?#]", value):
        return None
    try:
        parsed = urlsplit(value)
        host = parsed.hostname
        port = parsed.port
        if (parsed.scheme != "https" or not host or parsed.username is not None
                or parsed.password is not None or parsed.path not in ("", "/")):
            return None
        host = host.encode("idna").decode("ascii").lower()
        if host.endswith(".") or host.split(".")[-1] in {
            "localhost", "local", "localdomain", "internal", "lan", "home", "test", "invalid",
        }:
            return None
        try:
            address = ipaddress.ip_address(host)
        except ValueError:
            labels = host.split(".")
            if len(labels) < 2 or len(host) > 253 or any(
                not re.fullmatch(r"[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?", label)
                for label in labels
            ):
                return None
            # Reject noncanonical IP spellings accepted by some network stacks.
            if all(re.fullmatch(r"(?:[0-9]+|0x[0-9a-f]+)", label) for label in labels):
                return None
            rendered_host = host
        else:
            if not address.is_global or address.is_multicast or address.is_reserved:
                return None
            rendered_host = f"[{host}]" if address.version == 6 else host
        if tunnel_file and not re.fullmatch(r"[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.trycloudflare\.com", host):
            return None
        if port == 0:
            return None
        suffix = f":{port}" if port and port != 443 else ""
        return f"https://{rendered_host}{suffix}"
    except (ValueError, UnicodeError):
        return None


def _configuration() -> tuple[str | None, str | None, tuple]:
    configured = os.environ.get("HIRING_PUBLIC_URL", "").strip()
    if configured:
        origin = _public_origin(configured, tunnel_file=False)
        return origin, None if origin else "invalid", ("environment", configured)
    configured_path = os.environ.get("HIRING_SHARING_URL_FILE")
    # An explicitly empty path disables auto-discovery, including in tests.
    if configured_path is not None and not configured_path.strip():
        return None, "not_configured", ("disabled",)
    path = Path(configured_path) if configured_path else Path(__file__).parent.parent / ".sharing" / "url.txt"
    try:
        with path.open("rb") as source:
            stat = os.fstat(source.fileno())
            if stat.st_size > MAX_URL_BYTES:
                return None, "invalid", ("oversize",)
            raw = source.read(MAX_URL_BYTES + 1)
        if len(raw) > MAX_URL_BYTES:
            return None, "invalid", ("oversize",)
        value = raw.decode("utf-8-sig").strip()
    except FileNotFoundError:
        return None, "not_configured", ("missing",)
    except (OSError, UnicodeError):
        return None, "invalid", ("unreadable",)
    origin = _public_origin(value, tunnel_file=True)
    return origin, None if origin else "invalid", ("file", str(path), stat.st_mtime_ns, raw)


def _probe(origin: str) -> bool:
    request = Request(origin + IDENTITY_PATH, headers={"Accept": "application/json", "Cache-Control": "no-cache"})
    try:
        with build_opener(_NoRedirect()).open(request, timeout=PROBE_TIMEOUT_SECONDS) as response:
            if response.status != 200:
                return False
            raw = response.read(MAX_IDENTITY_BYTES + 1)
            if len(raw) > MAX_IDENTITY_BYTES:
                return False
            payload = json.loads(raw)
            return isinstance(payload, dict) and payload.get("instance_id") == _INSTANCE_ID
    except HTTPError as error:
        error.close()
        return False
    except (URLError, HTTPException, OSError, ValueError, UnicodeError):
        return False


def _reachable(origin: str, configuration: tuple) -> bool:
    key = (origin, configuration)
    # Serialize the short probe so polling clients share one outbound request.
    with _cache_lock:
        cached = _cache.get(key)
        if cached and cached[0] > time.monotonic():
            _cache.move_to_end(key)
            return cached[1]
        result = _probe(origin)
        _cache[key] = (time.monotonic() + (10 if result else 2), result)
        _cache.move_to_end(key)
        while len(_cache) > 8:
            _cache.popitem(last=False)
        return result


def sharing_status() -> dict:
    origin, reason, configuration = _configuration()
    temporary = bool(origin and urlsplit(origin).hostname.endswith(".trycloudflare.com"))
    reachable = bool(origin and _reachable(origin, configuration))
    return {
        "public_origin": origin if reachable else None,
        "reachable": reachable,
        "temporary": temporary,
        "reason": reason or (None if reachable else "unreachable"),
    }
