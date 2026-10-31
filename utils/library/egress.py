"""Where KRC may connect (KRC_EXTERNAL_API_GAMEPLAN.md stage 16).

Every outbound request goes through ``get()``: ``https`` only, to a host in ALLOWED_DOMAINS
or a subdomain of one, with redirects followed by hand and every hop checked. The internet
switch (``krc_network.network_enabled``) is still checked first by the callers; this is
what KRC may reach once it's on. Preview URLs come from Civitai's answers, so without this a
bad answer could make KRC download from any address, the local network included.

A refused URL raises EgressRefused (an aiohttp.ClientError when aiohttp is there, so the
clients' existing error handling turns it into a failed fetch) and is logged once per host.

KRC packs (public API 1.12, utils/pack_network.py) pass their own declared hosts as
``domains``; NodePack's own clients use ALLOWED_DOMAINS.
"""
import threading
from urllib.parse import urljoin, urlsplit

try:
    import aiohttp
except ImportError:  # aiohttp ships with ComfyUI, but never assume
    aiohttp = None

ALLOWED_DOMAINS = ("civitai.com", "huggingface.co", "hf.co")
MAX_REDIRECTS = 5
_REDIRECTS = (301, 302, 303, 307, 308)

_logged = set()
_log_lock = threading.Lock()

_Base = getattr(aiohttp, "ClientError", None) or Exception


class EgressRefused(_Base):
    """A URL KRC isn't allowed to connect to."""


def refusal(url, domains=ALLOWED_DOMAINS):
    """Why KRC may not connect to ``url`` (a sentence), or None when it may. ``domains``:
    the hosts allowed (each with its subdomains)."""
    try:
        parts = urlsplit(str(url or ""))
        host = (parts.hostname or "").lower().rstrip(".")
    except ValueError:
        return "not a valid URL"
    if parts.scheme != "https":
        return "only https is allowed"
    if not host:
        return "no host"
    if parts.username or parts.password:
        return "credentials in the URL"
    if not any(host == domain or host.endswith("." + domain) for domain in domains):
        return f"not an allowed host ({', '.join(domains) or 'none'})"
    return None


def check(url, domains=ALLOWED_DOMAINS):
    """Raise EgressRefused (logged once per host) unless KRC may connect to ``url``."""
    reason = refusal(url, domains)
    if reason is None:
        return
    try:
        host = urlsplit(str(url or "")).hostname or str(url or "")[:80]
    except ValueError:
        host = str(url or "")[:80]
    with _log_lock:
        first = host not in _logged
        _logged.add(host)
    if first:
        print(f"[KRC Network] refused {host}: {reason}")
    raise EgressRefused(f"refused {host}: {reason}")


def _origin(url):
    parts = urlsplit(str(url))
    return parts.scheme.lower(), (parts.hostname or "").lower(), parts.port if parts.port is not None else 443


async def get(session, url, domains=ALLOWED_DOMAINS):
    """``session.get(url)`` with every hop checked. -> the final response, which the
    caller uses as ``async with`` (or releases). Raises EgressRefused."""
    return await request(session, "GET", url, domains)


async def request(session, method, url, domains=ALLOWED_DOMAINS, **kwargs):
    """``session.request(method, url, **kwargs)`` with every redirect hop checked against
    ``domains``. 301 / 302 / 303 continue as a GET without a body (as browsers do); 307 / 308
    keep the method and body. -> the final response. Raises EgressRefused."""
    for _hop in range(MAX_REDIRECTS + 1):
        check(url, domains)
        if method == "GET":
            response = await session.get(url, allow_redirects=False, **kwargs)
        else:
            response = await session.request(method, url, allow_redirects=False, **kwargs)
        location = response.headers.get("Location") if response.status in _REDIRECTS else None
        if not location:
            return response
        response.release()
        next_url = urljoin(str(response.url), location)
        # An allowlisted destination is not the same credential scope. Manual
        # redirect following must retain the protections aiohttp normally supplies.
        if _origin(response.url) != _origin(next_url):
            kwargs = {key: value for key, value in kwargs.items() if key not in ("auth", "cookies")}
            if "headers" in kwargs:
                kwargs["headers"] = {key: value for key, value in kwargs["headers"].items()
                                     if str(key).lower() not in ("authorization", "proxy-authorization", "cookie")}
        if response.status in (301, 302, 303) and method != "GET":
            method = "GET"
            kwargs = {key: value for key, value in kwargs.items() if key not in ("json", "data")}
        url = next_url
    raise EgressRefused(f"more than {MAX_REDIRECTS} redirects")
