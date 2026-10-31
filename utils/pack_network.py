"""Internet access for KRC packs (public API 1.12, PUBLIC_API_PACKS_GAMEPLAN.md stage 3).

``await krc_fetch(pack_id, url, ...)`` is how a KRC pack's server code reaches the internet,
under the same rules as NodePack's own lookups:

  - the master switch (KRC Portal > Options > Network > Allow internet access): off, nothing
    connects and the answer is {"ok": False, "error": "network-disabled"};
  - only the hosts the pack declared in its krc_pack.json ("network": {"hosts", "why"}), and
    only while the pack is allowlisted and loaded (utils/krc_packs.pack_hosts); https only,
    every redirect hop checked (utils/library/egress.py);
  - a capped answer (max_bytes), a timeout, never raises.

The Portal's Network section lists every pack's hosts and why. A pack never connects from
the browser: its page calls its own route, which calls this.
"""
import json as jsonlib
import math

try:
    import aiohttp
except ImportError:  # aiohttp ships with ComfyUI, but never assume
    aiohttp = None

from .krc_network import network_enabled
from .krc_packs import pack_hosts
from .library import egress

METHODS = ("GET", "POST", "PUT", "PATCH", "DELETE")
DEFAULT_MAX_BYTES = 8 * 1024 * 1024
MAX_BYTES_CAP = 64 * 1024 * 1024
_CHUNK = 64 * 1024
# Headers a pack can't set (the connection's own, or ones that would let it pose as the browser).
_BLOCKED_HEADERS = {"host", "cookie", "connection", "content-length", "transfer-encoding", "proxy-authorization"}

__all__ = ["krc_fetch", "network_enabled"]


def _fail(error, status=0):
    return {"ok": False, "status": status, "error": error}


async def krc_fetch(pack_id, url, *, method="GET", json=None, data=None, headers=None, timeout=10,
                    max_bytes=DEFAULT_MAX_BYTES):
    """One request on behalf of KRC pack ``pack_id``. -> {"ok", "status", "error"} plus, on
    an answer, "json" (a JSON content type), "text" (other text) or "bytes" (anything else),
    and "headers" (the response's, as a dict). ``ok`` = the request went out and the status
    is 2xx."""
    if not network_enabled():
        return _fail("network-disabled")
    hosts = pack_hosts(pack_id)
    if hosts is None:
        return _fail("not-a-loaded-pack")
    if not hosts:
        return _fail("no-hosts-declared")
    if egress.refusal(url, tuple(hosts)) is not None:
        try:
            egress.check(url, tuple(hosts))  # logs once per host
        except egress.EgressRefused as err:
            return _fail(f"refused: {err}")
    method = str(method or "GET").upper()
    if method not in METHODS:
        return _fail(f"unsupported method {method}")
    if aiohttp is None:
        return _fail("aiohttp-unavailable")
    try:
        max_bytes = max(1, min(int(max_bytes or DEFAULT_MAX_BYTES), MAX_BYTES_CAP))
        clean_headers = {str(key): str(value) for key, value in (headers or {}).items()
                         if str(key).lower() not in _BLOCKED_HEADERS}
        kwargs = {"headers": clean_headers}
        if json is not None:
            kwargs["json"] = json
        elif data is not None:
            kwargs["data"] = data
        seconds = float(timeout or 10)
        if not math.isfinite(seconds):
            raise ValueError("timeout must be finite")
        client_timeout = aiohttp.ClientTimeout(total=max(1.0, min(seconds, 120.0)))
    except (TypeError, ValueError, OverflowError, AttributeError) as err:
        return _fail(f"invalid request options: {err}")
    try:
        async with aiohttp.ClientSession(timeout=client_timeout) as session:
            response = await egress.request(session, method, url, tuple(hosts), **kwargs)
            async with response:
                body = bytearray()
                async for chunk in response.content.iter_chunked(_CHUNK):
                    body += chunk
                    if len(body) > max_bytes:
                        return _fail(f"answer over {max_bytes} bytes", response.status)
                result = {"ok": 200 <= response.status < 300, "status": response.status, "error": "",
                          "headers": dict(response.headers)}
                content_type = response.headers.get("Content-Type", "").lower()
                if "json" in content_type:
                    try:
                        result["json"] = jsonlib.loads(bytes(body).decode(response.charset or "utf-8"))
                    except (ValueError, UnicodeDecodeError):
                        result.update(ok=False, error="the answer isn't valid JSON", text=bytes(body).decode("utf-8", "replace"))
                elif content_type.startswith("text/") or "xml" in content_type:
                    result["text"] = bytes(body).decode(response.charset or "utf-8", "replace")
                else:
                    result["bytes"] = bytes(body)
                if not result["ok"] and not result["error"]:
                    result["error"] = f"HTTP {response.status}"
                return result
    except egress.EgressRefused as err:
        return _fail(f"refused: {err}")
    except Exception as err:  # noqa: BLE001 - offline, DNS, TLS, timeout: a failed fetch, never a crash
        return _fail(f"{type(err).__name__}: {err}")
