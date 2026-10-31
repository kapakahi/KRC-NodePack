"""Same-site check for KRC's write routes (KRC_EXTERNAL_API_GAMEPLAN.md stages 16 and 13).

Stage 16 put it on the switch routes; stage 13 (``install_same_site_middleware``) puts it on
every KRC route that changes something: any method but GET / HEAD / OPTIONS under KRC's
prefixes (WRITE_PREFIXES), whether called at ``/…`` or ComfyUI's ``/api/…`` alias. The
external API (``/krc/ext/v1/``) is left out: it's read-only and keyed, and its apps aren't
ComfyUI's page.

A browser says where a request comes from: ``Sec-Fetch-Site`` (every current browser),
else ``Origin`` (compared with the request's Host, or X-Forwarded-Host behind a proxy). A
request from another site (or an app on another port of the same machine) is refused, so a
web page open in your browser can't change things behind your back. A script sends neither
header and isn't stopped by this; ComfyUI has no login, so that is the network's job ("keep
ComfyUI on a network you trust").

The same middleware marks every KRC response ``X-Content-Type-Options: nosniff``, so a
browser never second-guesses a thumbnail's type (an imported file is shown as the image
it claims to be, or not at all, never run as a page).
"""
import threading
from urllib.parse import urlsplit

# Every KRC route lives under one of these (Word Bank keeps its older prefix). Checked
# against the path without ComfyUI's "/api" alias.
WRITE_PREFIXES = ("/krc/", "/wordbank/")
EXEMPT_PREFIXES = ("/krc/ext/v1/",)
SAFE_METHODS = ("GET", "HEAD", "OPTIONS")
CROSS_ORIGIN_MESSAGE = "This can only be changed from ComfyUI's own page."
_ALLOWED_FETCH_SITES = ("same-origin", "none")

_logged = set()
_log_lock = threading.Lock()


def cross_site(headers, host):
    """Whether a browser marked this request as coming from another site. ``host`` is the
    request's Host (host[:port]); X-Forwarded-Host counts too (a reverse proxy)."""
    fetch_site = str(headers.get("Sec-Fetch-Site", "") or "").strip().lower()
    if fetch_site:
        return fetch_site not in _ALLOWED_FETCH_SITES
    origin = str(headers.get("Origin", "") or "").strip()
    if not origin:
        return False  # not a browser (or a same-origin GET): nothing to tell
    if origin == "null":
        return True
    try:
        origin_host = urlsplit(origin).netloc.lower()
    except ValueError:
        return True
    hosts = {str(host or "").strip().lower()}
    forwarded = str(headers.get("X-Forwarded-Host", "") or "").split(",")[0].strip().lower()
    if forwarded:
        hosts.add(forwarded)
    return origin_host not in hosts


def refuse_cross_site(request, area):
    """-> (status, body) when ``request`` comes from another site (logged once per route),
    else None. ``area`` is the log prefix's area, e.g. "External API"."""
    if not cross_site(request.headers, request.host):
        return None
    path = request.path
    with _log_lock:
        first = path not in _logged
        _logged.add(path)
    if first:
        print(f"[KRC {area}] refused a request to {path} from another site")
    return 403, {"error": "cross_origin", "message": CROSS_ORIGIN_MESSAGE}


def krc_path(path):
    """Whether a path (with or without ComfyUI's "/api" alias) is one of KRC's routes."""
    path = str(path or "")
    if path.startswith("/api/"):
        path = path[len("/api"):]
    return path.startswith(WRITE_PREFIXES)


def mark_nosniff(response):
    """Add nosniff to a response that hasn't been sent yet (a streamed one is left)."""
    if getattr(response, "prepared", False):
        return
    try:
        response.headers.setdefault("X-Content-Type-Options", "nosniff")
    except (AttributeError, TypeError, RuntimeError):
        pass


def guarded_path(method, path):
    """Whether the middleware checks this request: a write to a KRC route."""
    if str(method or "").upper() in SAFE_METHODS:
        return False
    path = str(path or "")
    if path.startswith("/api/"):
        path = path[len("/api"):]
    return path.startswith(WRITE_PREFIXES) and not path.startswith(EXEMPT_PREFIXES)


_INSTALLED = False


def install_same_site_middleware():
    """Add the stage-13 check to ComfyUI's server, once. Runs while ComfyUI loads custom
    nodes, before the server starts (its middleware list freezes on start). -> bool."""
    global _INSTALLED
    if _INSTALLED:
        return True
    try:
        from aiohttp import web
        from server import PromptServer
    except Exception:  # noqa: BLE001 - outside ComfyUI
        return False

    @web.middleware
    async def krc_same_site(request, handler):
        if guarded_path(request.method, request.path):
            refused = refuse_cross_site(request, "Security")
            if refused:
                status, body = refused
                return web.json_response(body, status=status)
        response = await handler(request)
        if krc_path(request.path):
            mark_nosniff(response)
        return response

    try:
        PromptServer.instance.app.middlewares.append(krc_same_site)
    except Exception as exc:  # noqa: BLE001 - a frozen list (server already started)
        print(f"[KRC Security] couldn't add the same-site check for KRC's write routes: {exc}")
        return False
    _INSTALLED = True
    return True
