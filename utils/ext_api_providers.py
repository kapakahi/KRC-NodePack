"""External API providers: a KRC pack (KRC NodePack Extras) plugs node-specific logic into
NodePack's ``/krc/ext/v1`` routes (public API 2.10 ``register_ext_provider``).

NodePack keeps everything an outside app touches first: the routes, the switch and key, the
permissions, capability discovery, the sources (ext_api_sources.py) and the resource limits.
A provider only answers the node-specific questions. The routes for a provider are always
registered, so the contract is fixed; while no compatible provider is registered they answer
``503 provider_unavailable`` and /info lists none of its capabilities.

Known providers, and the provider interface versions this NodePack speaks:

    "resizer" (KRC Resizer, in KRC NodePack Extras): interface 1. The provider object has
        PROVIDER_API = 1, VERSION (its own, a string), PACK (its pack id), CAPABILITIES
        (a subset of RESIZER_CAPABILITIES), and the methods
            prepare(source) -> preview dict            (source: ext_api_sources.Source)
            get(handle) -> preview dict | None
            frame(handle, index) -> JPEG bytes | None
            drop(handle)
            build_inputs(identity, settings) -> {"inputs", "settings"}   (ValueError -> 400)
            read_settings(inputs, identity|None) -> {"settings", "source", "stale"?, "fallback"?}

Registering again replaces the earlier object (a pack reloaded). An unknown name, a missing
method or an interface version this NodePack doesn't speak is refused with one log line,
and the routes keep answering ``provider_unavailable``.
"""
import threading

PROVIDERS = {
    "resizer": {
        "interfaces": (1,),
        "methods": ("prepare", "get", "frame", "drop", "build_inputs", "read_settings"),
        "capabilities": ("resizer.previews", "resizer.settings"),
    },
}

_registered = {}
_lock = threading.Lock()


def register_ext_provider(name, provider):
    """Register ``provider`` for ``name``. -> True when it's in use, False when refused
    (logged once per refusal)."""
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
    print(f"[KRC External API] provider {name!r} {getattr(provider, 'VERSION', '?')} "
          f"from {getattr(provider, 'PACK', '?')} (interface {interface})")
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
