"""KRC sibling packs: which of the KRC packs (KRC NodePack Extras, future KRC packs) are
installed, and whether each one loaded. Private to KRC packs — not part of the public API.

A KRC pack ships ``krc_pack.json`` at its root:

    {"id": "krc_extras", "name": "KRC NodePack Extras", "version": "0.1.0",
     "requires_api": [1, 4], "nodes": ["KRC RefMod Loadout", ...]}

NodePack finds those files in the custom_nodes folders (so load order never matters and
a pack that failed to import is still seen), keeps only ids on its allowlist, and works
out each pack's status from ComfyUI's registered nodes:

    ok            API requirement met and every listed node registered
    incompatible  requires_api not met by this NodePack's KRC_API_VERSION
    partial       some listed nodes didn't register
    failed        none registered
    invalid       the manifest is malformed

Computed once, on first use (a route or a run), after ComfyUI has loaded every pack.
See KRC_PACKS_GAMEPLAN.md in the dev repo.
"""

import json
import logging
import os
import re
import threading

logger = logging.getLogger(__name__)

MANIFEST_NAME = "krc_pack.json"

# The KRC packs NodePack recognises (id -> display name). A new KRC pack is added here
# in a NodePack release; any other krc_pack.json is ignored.
KRC_PACK_ALLOWLIST = {
    "krc_extras": "KRC NodePack Extras",
    # The dev repo's sample pack (never shipped): proves the public API for packs.
    "krc_dev": "KRC Dev Pack",
}

STATUS_OK = "ok"
STATUS_INCOMPATIBLE = "incompatible"
STATUS_PARTIAL = "partial"
STATUS_FAILED = "failed"
STATUS_INVALID = "invalid"

_LOCK = threading.Lock()
_PACKS = None


# ---- discovery -------------------------------------------------------------------------

def custom_nodes_dirs():
    """ComfyUI's custom_nodes folders; outside ComfyUI, the folder NodePack sits in."""
    try:
        import folder_paths
        dirs = list(folder_paths.get_folder_paths("custom_nodes"))
    except Exception:  # noqa: BLE001
        dirs = []
    return dirs or [os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))]


def find_manifests(dirs):
    """[(folder path, raw manifest or None when unreadable)] for every allowlisted pack
    folder (one level deep). Folders ComfyUI skips (``*.disabled``) are skipped too."""
    found = []
    for root in dirs:
        try:
            names = sorted(os.listdir(root))
        except OSError:
            continue
        for name in names:
            folder = os.path.join(root, name)
            path = os.path.join(folder, MANIFEST_NAME)
            if name.endswith(".disabled") or not os.path.isfile(path):
                continue
            try:
                with open(path, encoding="utf-8") as handle:
                    raw = json.load(handle)
            except (OSError, ValueError):
                raw = None
            pack_id = raw.get("id") if isinstance(raw, dict) else None
            if pack_id in KRC_PACK_ALLOWLIST:
                found.append((folder, raw))
            elif raw is None:
                logger.debug("[KRC Packs] unreadable %s in %s; ignored.", MANIFEST_NAME, name)
    return found


# ---- status (pure) ---------------------------------------------------------------------

def _version_pair(value):
    if isinstance(value, (list, tuple)) and len(value) >= 2:
        try:
            return int(value[0]), int(value[1])
        except (TypeError, ValueError):
            return None
    return None


# A host a pack may declare (public API 1.12): a public DNS name, lowercase, no scheme, port,
# path or IP literal ("localhost" and bare names have no dot). Its subdomains come with it.
_HOST_RE = re.compile(r"^(?=.{4,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$")
MAX_PACK_HOSTS = 10
MAX_NETWORK_WHY = 200


def _validate_network(raw):
    """(network, problem): a manifest's optional "network" block -> {"hosts", "why"}."""
    if raw is None:
        return {"hosts": [], "why": ""}, ""
    if not isinstance(raw, dict):
        return None, f"{MANIFEST_NAME}: network must be {{\"hosts\": [...], \"why\": \"...\"}}"
    hosts = raw.get("hosts", [])
    if not isinstance(hosts, list) or len(hosts) > MAX_PACK_HOSTS \
            or not all(isinstance(host, str) and _HOST_RE.match(host) for host in hosts):
        return None, (f"{MANIFEST_NAME}: network.hosts must be up to {MAX_PACK_HOSTS} host names "
                      "(like api.example.com: no https://, port, path or IP)")
    why = raw.get("why", "")
    if not isinstance(why, str) or (hosts and not why.strip()) or len(why) > MAX_NETWORK_WHY:
        return None, f"{MANIFEST_NAME}: network.why must say what the hosts are for (up to {MAX_NETWORK_WHY} characters)"
    return {"hosts": list(dict.fromkeys(hosts)), "why": why.strip()}, ""


def _validate(raw):
    """(manifest, problem): a cleaned manifest, or a problem string."""
    if not isinstance(raw, dict):
        return None, f"{MANIFEST_NAME} is not valid JSON"
    requires = _version_pair(raw.get("requires_api"))
    if requires is None:
        return None, f"{MANIFEST_NAME}: requires_api must be [major, minor]"
    nodes = raw.get("nodes")
    if not isinstance(nodes, list) or not nodes or not all(isinstance(node, str) and node for node in nodes):
        return None, f"{MANIFEST_NAME}: nodes must be a list of node type names"
    network, problem = _validate_network(raw.get("network"))
    if network is None:
        return None, problem
    return {
        "id": raw["id"],
        "name": str(raw.get("name") or KRC_PACK_ALLOWLIST[raw["id"]]),
        "version": str(raw.get("version") or ""),
        "requires_api": requires,
        "nodes": list(dict.fromkeys(nodes)),
        "network": network,
    }, ""


def api_problem(name, requires, api_version):
    """One user-facing line when ``requires`` (major, minor) isn't met by ``api_version``,
    naming the pack that needs updating; "" when it is met."""
    have_major, have_minor = api_version
    need_major, need_minor = requires
    if need_major == have_major and need_minor <= have_minor:
        return ""
    need = f"{need_major}.{need_minor}" if need_major == have_major else f"{need_major}.x"
    older = "KRC NodePack" if (need_major, need_minor) > (have_major, have_minor) else name
    return f"{name} needs KRC NodePack API {need}; this KRC NodePack has {have_major}.{have_minor}. Update {older}."


def pack_status(folder, raw, api_version, registered):
    """The status record for one pack folder. ``registered``: the node type names ComfyUI
    has (``nodes.NODE_CLASS_MAPPINGS``)."""
    pack_id = raw.get("id") if isinstance(raw, dict) else ""
    manifest, problem = _validate(raw)
    record = {
        "id": pack_id,
        "name": KRC_PACK_ALLOWLIST.get(pack_id, pack_id),
        "version": "",
        "folder": os.path.basename(os.path.normpath(folder)),
        "requiresApi": None,
        "nodes": [],
        "network": {"hosts": [], "why": ""},
        "status": STATUS_INVALID,
        "problem": problem,
    }
    if manifest is None:
        return record
    nodes = [{"name": node, "loaded": node in registered} for node in manifest["nodes"]]
    loaded = sum(node["loaded"] for node in nodes)
    record.update({
        "name": manifest["name"],
        "version": manifest["version"],
        "requiresApi": list(manifest["requires_api"]),
        "nodes": nodes,
        "network": manifest["network"],
    })
    problem = api_problem(manifest["name"], manifest["requires_api"], api_version)
    if problem:
        record.update(status=STATUS_INCOMPATIBLE, problem=problem)
    elif loaded == len(nodes):
        record.update(status=STATUS_OK, problem="")
    elif loaded:
        missing = ", ".join(node["name"] for node in nodes if not node["loaded"])
        record.update(status=STATUS_PARTIAL, problem=f"Not loaded: {missing}. See the ComfyUI console.")
    else:
        record.update(status=STATUS_FAILED, problem=f"{manifest['name']} failed to load. See the ComfyUI console.")
    return record


def collect_packs(dirs, api_version, registered):
    """Status records for every allowlisted pack in ``dirs``, one per id. When an id is
    installed twice (e.g. a copied folder), the copy whose nodes loaded wins and the
    others are named in its ``duplicates``."""
    by_id = {}
    for folder, raw in find_manifests(dirs):
        record = pack_status(folder, raw, api_version, registered)
        by_id.setdefault(record["id"], []).append(record)
    rank = {STATUS_OK: 0, STATUS_PARTIAL: 1, STATUS_INCOMPATIBLE: 2, STATUS_FAILED: 3, STATUS_INVALID: 4}
    packs = []
    for pack_id in KRC_PACK_ALLOWLIST:
        records = sorted(by_id.get(pack_id, []), key=lambda record: rank[record["status"]])
        if not records:
            continue
        best = dict(records[0])
        best["duplicates"] = [record["folder"] for record in records[1:]]
        packs.append(best)
    return packs


# ---- runtime ---------------------------------------------------------------------------

def _registered_nodes():
    try:
        import nodes as comfy_nodes
    except ImportError:
        return set()
    return set(getattr(comfy_nodes, "NODE_CLASS_MAPPINGS", {}) or {})


def _api_version():
    from ..krc_public_api import KRC_API_VERSION
    return tuple(KRC_API_VERSION)[:2]


def krc_packs():
    """Every installed KRC sibling pack's status record (computed once, after every pack
    has loaded; packs can't change without a restart)."""
    global _PACKS
    with _LOCK:
        if _PACKS is None:
            _PACKS = collect_packs(custom_nodes_dirs(), _api_version(), _registered_nodes())
            for pack in _PACKS:
                if pack["status"] != STATUS_OK:
                    print(f"[KRC Packs] {pack['name']} ({pack['folder']}): {pack['status']} - {pack['problem']}")
                for duplicate in pack["duplicates"]:
                    print(f"[KRC Packs] {pack['name']} is installed twice; using {pack['folder']}, ignoring {duplicate}.")
        return [dict(pack) for pack in _PACKS]


def krc_pack_status(pack_id):
    """The status record for one KRC pack, or None when it isn't installed. For
    NodePack's own pack-specific features (``status == "ok"`` = installed and loaded)."""
    return next((pack for pack in krc_packs() if pack["id"] == pack_id), None)


def pack_hosts(pack_id):
    """The hosts a KRC pack declared, when it's allowlisted and loaded ("ok"); else None
    (a pack that isn't installed, didn't load, or is the wrong version reaches nothing)."""
    pack = krc_pack_status(pack_id)
    if not pack or pack["status"] != STATUS_OK:
        return None
    return list(pack.get("network", {}).get("hosts") or [])


def network_hosts():
    """Where KRC may connect, for the Portal's Network page: NodePack's lookups, then
    every loaded pack that declared hosts. -> [{owner, hosts, why}]."""
    from .library.egress import ALLOWED_DOMAINS
    listing = [{"owner": "KRC NodePack", "hosts": list(ALLOWED_DOMAINS),
                "why": "Civitai metadata by file hash, and Hugging Face model cards, only when you ask."}]
    for pack in krc_packs():
        hosts = pack.get("network", {}).get("hosts") or []
        if pack["status"] == STATUS_OK and hosts:
            listing.append({"owner": pack["name"], "hosts": list(hosts), "why": pack["network"].get("why", "")})
    return listing


# ---- route -----------------------------------------------------------------------------

_ROUTES_REGISTERED = False


def register_krc_packs_routes():
    """GET /krc/packs -> {"api": [major, minor], "packs": [status records]}."""
    global _ROUTES_REGISTERED
    try:
        from server import PromptServer
    except Exception:  # noqa: BLE001 - outside ComfyUI
        return
    if _ROUTES_REGISTERED:
        return
    _ROUTES_REGISTERED = True

    from aiohttp import web

    @PromptServer.instance.routes.get("/krc/network/hosts")
    async def get_network_hosts(_request):
        from .krc_network import network_enabled
        return web.json_response(
            {"enabled": network_enabled(), "hosts": network_hosts()},
            headers={"Cache-Control": "no-store"},
        )

    @PromptServer.instance.routes.get("/krc/packs")
    async def get_krc_packs(_request):
        return web.json_response(
            {"api": list(_api_version()), "packs": krc_packs()},
            headers={"Cache-Control": "no-store"},
        )
