"""Shared import/export history: when each kind of file was last exported / imported.

Feeds the KRC Portal's Import and Export page (IMPORT_EXPORT_PAGE_GAMEPLAN.md §3). The routes
that build an export or apply an import record here **after success only**, so a failed
import leaves the old date. An export is recorded when the server has built the file; it
can't know whether the browser saved it, so "exported" means "downloaded".

Node-neutral, like Collections: krc.db's ``transfer_history`` table, one row per key
(``transfer_history.json`` under the KRC nodes root before KRC_SQLITE_GAMEPLAN.md stage 3).
Recording is best-effort — it must never fail the export/import that called it.

Entry per key::

    {
      "lastExportMs": 0, "lastExportDetail": "",
      "lastImportMs": 0, "lastImportMode": "", "lastImportDetail": ""
    }

``kind`` matches ``web/js/shared/transfer/kinds.js``. ``detail`` names the single item for
the per-item kinds (a Prompt Vault category, a Word Bank bank), else "". A **keyed** kind
(Loadout Kit presets) keeps one entry per item instead, stored as ``"<kind>/<detail>"``
(``"loadout_kit.presets/refmod_loadout"``), so each kit has its own dates. ``mode`` is the
import mode the route received ("merge", "overwrite", "replace", "presets_only", "new"),
or "" for kinds that have none.

Logging: every import/export also leaves one ``[KRC Transfer]`` console line. Success lines
come from ``record_export`` / ``record_import`` (with the route's counts as ``summary``);
failures come from ``transfer_route``, which wraps each import/export route and logs any
error answer (HTTP >= 400, or a JSON body with ``ok``/``success`` false) or exception.
"""

import functools
import json
import re
import threading
import time

from ..db import library as library_db
from ..krc_paths import get_krc_nodes_dir

HISTORY_FILENAME = "transfer_history.json"
SCHEMA_VERSION = 1

# The KRC bundle's sections (UNIFIED_BUNDLE_GAMEPLAN.md; utils/bundle/sections.py) and the
# one file kind outside it, a Word Bank .txt.
KINDS = (
    "lora_library",
    "lora_presets",
    "model_library",
    "collections",
    "prompt_vault",
    "config_switcher_presets",
    "word_bank",
    "kit_presets",
    "pack",
    "word_bank.bank",
)

# Keyed kinds, like their bundle section ids: every Loadout Kit's presets
# ("kit_presets/<kit id>") and every KRC pack's sections ("pack/<pack id>__<name>").
KIT_PRESETS_KIND = "kit_presets"
PACK_SECTION_KIND = "pack"
KEYED_KINDS = (KIT_PRESETS_KIND, PACK_SECTION_KIND)
_KEY_RE = re.compile(r"^[a-z][a-z0-9_]{1,47}$")

_DETAIL_MAX = 200
_MODE_MAX = 40
_LOCK = threading.Lock()


def current_millis():
    return int(time.time() * 1000)


def get_transfer_history_path():
    """The pre-database history file, read once by the stage-3 import."""
    return get_krc_nodes_dir() / HISTORY_FILENAME


def _clip(value, limit):
    return str(value or "").strip()[:limit]


def normalize_entry(entry):
    entry = entry if isinstance(entry, dict) else {}

    def millis(key):
        try:
            return max(0, int(entry.get(key) or 0))
        except (TypeError, ValueError):
            return 0

    return {
        "lastExportMs": millis("lastExportMs"),
        "lastExportDetail": _clip(entry.get("lastExportDetail"), _DETAIL_MAX),
        "lastImportMs": millis("lastImportMs"),
        "lastImportMode": _clip(entry.get("lastImportMode"), _MODE_MAX),
        "lastImportDetail": _clip(entry.get("lastImportDetail"), _DETAIL_MAX),
    }


def history_key(kind, detail=""):
    """The store key for a record: the kind, or ``kind/detail`` for a keyed kind. None
    when it can't be recorded (an unknown kind, or a keyed kind without a valid item)."""
    if kind not in KINDS:
        return None
    if kind in KEYED_KINDS:
        item = str(detail or "").strip()
        return f"{kind}/{item}" if _KEY_RE.match(item) else None
    return kind


def _known_key(key):
    kind, _, item = str(key).partition("/")
    return history_key(kind, item) == key if item else (key in KINDS and key not in KEYED_KINDS)


def clean_history(kinds):
    """{key: entry} for known keys, each entry normalized (a legacy file's "kinds")."""
    if not isinstance(kinds, dict):
        return {}
    return {key: normalize_entry(entry) for key, entry in kinds.items() if _known_key(key)}


def load_history():
    """→ {kind: entry} for known kinds that have a record."""
    return clean_history(library_db.history_load())


def _update(kind, detail, fields, now=None):
    key = history_key(kind, detail)
    if key is None:
        return None
    with _LOCK:
        kinds = load_history()
        entry = kinds.get(key) or normalize_entry({})
        entry.update(fields)
        stamp = current_millis() if now is None else int(now)
        for field in ("lastExportMs", "lastImportMs"):
            if entry.get(field) == "now":
                entry[field] = stamp
        kinds[key] = normalize_entry(entry)
        library_db.history_put(key, kinds[key])
        return kinds[key]


def stamp_transfer(action, kind, mode="", detail="", now=None):
    """Stamp an export / import date without a log line (the KRC bundle logs one line for
    all its sections). Never raises. -> the entry, or None."""
    fields = ({"lastExportMs": "now", "lastExportDetail": detail} if action == "export"
              else {"lastImportMs": "now", "lastImportMode": mode, "lastImportDetail": detail})
    try:
        return _update(kind, detail, fields, now)
    except Exception:  # noqa: BLE001 — history must never break a transfer
        return None


def record_export(kind, detail="", now=None, summary=None):
    """Stamp a successful export and log it. Best-effort: never raises. → the entry, or None."""
    log_transfer("export", kind, True, detail=detail, summary=summary)
    try:
        return _update(kind, detail, {"lastExportMs": "now", "lastExportDetail": detail}, now)
    except Exception:  # noqa: BLE001 — history must never break the export
        return None


def record_import(kind, mode="", detail="", now=None, summary=None):
    """Stamp a successful import and log it. Best-effort: never raises. → the entry, or None."""
    log_transfer("import", kind, True, mode=mode, detail=detail, summary=summary)
    try:
        return _update(kind, detail, {"lastImportMs": "now", "lastImportMode": mode, "lastImportDetail": detail}, now)
    except Exception:  # noqa: BLE001 — history must never break the import
        return None


# ---- logging -------------------------------------------------------------------------------

def _ascii(value):
    return str(value).encode("ascii", "backslashreplace").decode("ascii")


def size_text(size):
    """Byte count for a log line: "812 B", "4.2 KB", "31.0 MB"."""
    size = float(size or 0)
    for unit in ("B", "KB", "MB"):
        if size < 1024 or unit == "MB":
            return f"{int(size)} {unit}" if unit == "B" else f"{size:.1f} {unit}"
        size /= 1024
    return ""


def summary_text(summary):
    """A route's counts as "prompts=18, thumbnails=5": ints as-is, lists by length,
    everything else left out. A string passes through."""
    if isinstance(summary, str):
        return summary
    if not isinstance(summary, dict):
        return ""
    parts = []
    for key, value in summary.items():
        if isinstance(value, bool):
            continue
        if isinstance(value, int):
            parts.append(f"{key}={value}")
        elif isinstance(value, (list, tuple, dict)):
            parts.append(f"{key}={len(value)}")
    return ", ".join(parts)


def log_transfer(action, kind, ok, mode="", detail="", summary=None):
    """One ASCII console line per import/export. Never raises."""
    try:
        line = f"[KRC Transfer] {action} {kind}"
        if detail:
            line += f' "{detail}"'
        if mode:
            line += f" ({mode})"
        line += " ok" if ok else " FAILED"
        text = summary_text(summary)
        if text:
            line += f": {text}"
        print(_ascii(line))
    except Exception:  # noqa: BLE001 — logging must never break a transfer
        pass


def _response_error(response):
    """The error an import/export route answered with, or None when it succeeded."""
    status = getattr(response, "status", 200) or 200
    body = None
    if getattr(response, "content_type", "") == "application/json":
        try:
            body = json.loads(response.text or "null")
        except (TypeError, ValueError):
            body = None
    if isinstance(body, dict) and (body.get("ok") is False or body.get("success") is False or "error" in body):
        return f"HTTP {status} {body.get('error') or 'failed'}"
    if status >= 400:
        return f"HTTP {status}"
    return None


def transfer_route(action, kind):
    """Wrap an import/export route handler so a failure is logged. Put it under the
    route decorator. The request's ?mode= and ?category= (or the {kit} path part) land in
    the line."""
    def wrap(handler):
        @functools.wraps(handler)
        async def run(request):
            query = getattr(request, "query", {}) or {}
            mode = query.get("mode", "")
            detail = query.get("category", "") or (getattr(request, "match_info", {}) or {}).get("kit", "")
            try:
                response = await handler(request)
            except Exception as err:
                log_transfer(action, kind, False, mode=mode, detail=detail, summary=f"{type(err).__name__}: {err}")
                raise
            error = _response_error(response)
            if error:
                log_transfer(action, kind, False, mode=mode, detail=detail, summary=error)
            return response
        return run
    return wrap


# ---- route ---------------------------------------------------------------------------------

_ROUTES_REGISTERED = False


def register_transfer_history_routes():
    """GET /krc/transfer/history → {ok, kinds: {kind: entry}}. Idempotent; called from both
    library node files (either may load first / alone), like the Collections routes."""
    global _ROUTES_REGISTERED
    try:
        from server import PromptServer
        from aiohttp import web
    except Exception:  # pragma: no cover - server missing off-runtime
        return
    if _ROUTES_REGISTERED:
        return
    _ROUTES_REGISTERED = True

    @PromptServer.instance.routes.get("/krc/transfer/history")
    async def transfer_history(_request):
        return web.json_response({"ok": True, "kinds": load_history()}, headers={"Cache-Control": "no-store"})
