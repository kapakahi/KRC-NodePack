"""External API providers: a KRC pack plugs node-specific logic into
NodePack's ``/krc/ext/v1`` routes (public API 2.10 ``register_ext_provider``).

NodePack keeps everything an outside app touches first: the routes, the switch and key, the
permissions, capability discovery, the sources (ext_api_sources.py) and the resource limits.
A provider only answers the node-specific questions. The routes for a provider are always
registered, so the contract is fixed; while no compatible provider is registered they answer
``503 provider_unavailable`` and /info lists none of its capabilities.

Known providers: none today. The KRC Resizer was the first (interface 1: PROVIDER_API,
VERSION, PACK, CAPABILITIES; prepare / get / frame / drop / build_inputs / read_settings); it
moved into NodePack on 2026-11-10 and is called directly (ext_api_resizer.py), so a pack that
still registers "resizer" (an older KRC NodePack Extras) is ignored without a word. The
function stays in the public API for future packs: a name gets an entry in PROVIDERS along
with its routes.

Registering again replaces the earlier object (a pack reloaded). An unknown name, a missing
method or an interface version this NodePack doesn't speak is refused with one log line.
Registering works quietly: nothing is logged when it succeeds.
"""
import threading

PROVIDERS = {}
# Names NodePack now handles itself: a registration is ignored quietly (no log line).
BUILT_IN = ("resizer",)

_registered = {}
_lock = threading.Lock()


def register_ext_provider(name, provider):
    """Register ``provider`` for ``name``. -> True when it's in use, False when refused
    (logged once per refusal)."""
    if name in BUILT_IN:
        return False
    spec = PROVIDERS.get(name)
    if spec is None:
        print(f"[KRC External API] ignored provider {name!r}: NodePack has no routes for it")
        return False
    interface = getattr(provider, "PROVIDER_API", None)
    if interface not in spec["interfaces"]:
        supported = ", ".join(str(v) for v in spec["interfaces"])
        print(f"[KRC External API] ignored provider {name!r}: interface {interface!r}, this NodePack speaks {supported}; "
              "update the older pack")
        return False
    missing = [method for method in spec["methods"] if not callable(getattr(provider, method, None))]
    if missing:
        print(f"[KRC External API] ignored provider {name!r}: missing {', '.join(missing)}")
        return False
    with _lock:
        _registered[name] = provider
    return True


def unregister_ext_provider(name):
    with _lock:
        _registered.pop(name, None)


def get_provider(name):
    with _lock:
        return _registered.get(name)


def provider_capabilities():
    """The capabilities registered providers bring (only those NodePack knows)."""
    out = []
    with _lock:
        items = list(_registered.items())
    for name, provider in items:
        allowed = PROVIDERS[name]["capabilities"]
        out.extend(cap for cap in (getattr(provider, "CAPABILITIES", ()) or ()) if cap in allowed and cap not in out)
    return out


def provider_info():
    """/info's providers: {name: {"version", "interface", "pack"}} for the registered ones."""
    with _lock:
        items = list(_registered.items())
    return {name: {"version": str(getattr(provider, "VERSION", "")), "interface": getattr(provider, "PROVIDER_API", 0),
                   "pack": str(getattr(provider, "PACK", ""))} for name, provider in items}
