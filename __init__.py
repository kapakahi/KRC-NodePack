"""
KRC NodePack
=============
A unified ComfyUI node pack consolidating a LoRA loadout/loader, a model library,
prompt management, a word bank, and ConfigSwitcher nodes into a single maintainable
codebase. Optional nodes (e.g. the KRC Resizer) live in KRC NodePack
Extras.

All nodes register and display under the ``KRC NodePack`` category so they group
together in the ComfyUI search and right-click menu.
"""

__version__ = "1.0.0"

# KRC's data lives in krc.db (utils/db/, KRC_SQLITE_GAMEPLAN.md). It must be usable before
# any node or route loads: a Python without sqlite3, a failed integrity check or a failed
# one-time import prints a clear [KRC DB] block and stops the pack loading here.
from .utils.db.check import require_sqlite as _require_sqlite
_require_sqlite()
from .utils.db.startup import initialize as _initialize_db, register_db_routes as _register_db_routes
_initialize_db()
_register_db_routes()

from .nodes.krc_prompt_vault        import NODE_CLASS_MAPPINGS as _pm_c,  NODE_DISPLAY_NAME_MAPPINGS as _pm_d
from .nodes.krc_word_bank             import NODE_CLASS_MAPPINGS as _wb_c,  NODE_DISPLAY_NAME_MAPPINGS as _wb_d
from .nodes.krc_config_switcher       import NODE_CLASS_MAPPINGS as _cs_c,  NODE_DISPLAY_NAME_MAPPINGS as _cs_d
from .nodes.krc_config_switcher_link   import NODE_CLASS_MAPPINGS as _csl_c, NODE_DISPLAY_NAME_MAPPINGS as _csl_d

NODE_CLASS_MAPPINGS = {
    **_pm_c, **_wb_c, **_cs_c, **_csl_c,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    **_pm_d, **_wb_d, **_cs_d, **_csl_d,
}

# LoRA Loadout nodes (support code in utils/lora_loadout/). Guarded so a load
# failure can never take down the rest of the pack; krc_lora_loadout registers
# the shared LoRA Loadout API routes at import.
try:
    from .nodes.krc_lora_loadout import NODE_CLASS_MAPPINGS as _lst_c, NODE_DISPLAY_NAME_MAPPINGS as _lst_d
    from .nodes.krc_lora_loader  import NODE_CLASS_MAPPINGS as _lld_c, NODE_DISPLAY_NAME_MAPPINGS as _lld_d
    NODE_CLASS_MAPPINGS.update(_lst_c); NODE_CLASS_MAPPINGS.update(_lld_c)
    NODE_DISPLAY_NAME_MAPPINGS.update(_lst_d); NODE_DISPLAY_NAME_MAPPINGS.update(_lld_d)
except Exception as _ls_err:
    print(f"[KRC NodePack] Warning: LoRA Loadout failed to load: {_ls_err}")

# Model Library clone checkpoint. It is intentionally still backed by the LoRA Loadout
# surface/routes until the next surgical strip/generalization pass.
# Guarded independently so it can never take down LoRA Loadout or the rest of the pack.
try:
    from .nodes.krc_model_library import NODE_CLASS_MAPPINGS as _ml_c, NODE_DISPLAY_NAME_MAPPINGS as _ml_d
    NODE_CLASS_MAPPINGS.update(_ml_c)
    NODE_DISPLAY_NAME_MAPPINGS.update(_ml_d)
except Exception as _ml_err:
    print(f"[KRC NodePack] Warning: Model Library failed to load: {_ml_err}")

# Public API for other KRC packs (KRC NodePack Extras), looked up through this
# attribute. See krc_public_api.py.
try:
    from . import krc_public_api as KRC_PUBLIC_API
except Exception as _api_err:
    KRC_PUBLIC_API = None
    print(f"[KRC NodePack] Warning: public API failed to load: {_api_err}")

# KRC Media (moved in from KRC Media IO, MEDIA_INTO_NODEPACK_GAMEPLAN.md): the Portal's
# Media tab, media presets, KRC Media Loader and KRC Media Output. Each part guarded on
# its own so Media can never take down the rest of the pack.
try:
    from .nodes.krc_media_loader import NODE_CLASS_MAPPINGS as _mld_c, NODE_DISPLAY_NAME_MAPPINGS as _mld_d
    NODE_CLASS_MAPPINGS.update(_mld_c)
    NODE_DISPLAY_NAME_MAPPINGS.update(_mld_d)
except Exception as _mld_err:
    print(f"[KRC NodePack] Warning: Media Loader failed to load: {_mld_err}")
try:
    from .nodes.krc_media_output import NODE_CLASS_MAPPINGS as _mout_c, NODE_DISPLAY_NAME_MAPPINGS as _mout_d
    NODE_CLASS_MAPPINGS.update(_mout_c)
    NODE_DISPLAY_NAME_MAPPINGS.update(_mout_d)
except Exception as _mout_err:
    print(f"[KRC NodePack] Warning: Media Output failed to load: {_mout_err}")
# Media's routes, and once the server starts, the clean-up of unfinished uploads and of
# untouched auto presets.
try:
    from .utils.media import media_routes as _media_routes
    _media_routes.register_routes()
    try:
        import asyncio as _asyncio
        from server import PromptServer as _PromptServer

        async def _media_startup(_app):
            try:
                await _asyncio.to_thread(_media_routes.startup_cleanup)
            except Exception as _cleanup_err:  # noqa: BLE001
                print(f"[KRC Media] Warning: startup cleanup failed: {_cleanup_err}")

        _PromptServer.instance.app.on_startup.append(_media_startup)
    except Exception:  # noqa: BLE001 - outside ComfyUI
        pass
except Exception as _media_routes_err:
    print(f"[KRC NodePack] Warning: Media routes failed to load: {_media_routes_err}")

# KRC Resizer (image resizer / outpainter; moved back from KRC NodePack Extras 2026-11-10).
try:
    from .nodes.krc_resizer import NODE_CLASS_MAPPINGS as _rz_c, NODE_DISPLAY_NAME_MAPPINGS as _rz_d
    NODE_CLASS_MAPPINGS.update(_rz_c)
    NODE_DISPLAY_NAME_MAPPINGS.update(_rz_d)
except Exception as _rz_err:
    print(f"[KRC NodePack] Warning: Resizer failed to load: {_rz_err}")


def _older_extras_resizer():
    """An older KRC NodePack Extras still carries its own KRC Resizer: say so once."""
    try:
        import nodes as _comfy_nodes
        found = _comfy_nodes.NODE_CLASS_MAPPINGS.get("KRC Resizer")
        if found is not None and "krc_resizer" in found.__module__ and not found.__module__.startswith(__name__):
            print("[KRC NodePack] Warning: an older KRC NodePack Extras also provides KRC Resizer. "
                  "Update KRC NodePack Extras: the Resizer is part of KRC NodePack now.")
    except Exception:  # noqa: BLE001 - outside ComfyUI
        pass


try:
    from server import PromptServer as _RzServer

    async def _check_older_extras(_app):
        _older_extras_resizer()

    _RzServer.instance.app.on_startup.append(_check_older_extras)
except Exception:  # noqa: BLE001 - outside ComfyUI
    pass

# The route behind the public Card API's JS resolveCards.
try:
    from .utils.card_api_routes import register_card_api_routes
    register_card_api_routes()
except Exception as _card_api_err:
    print(f"[KRC NodePack] Warning: Card API route failed to load: {_card_api_err}")

# Loadout Kit routes (descriptors + per-kit presets), shared by every kit.
try:
    from .utils.loadout_kit.routes import register_loadout_kit_routes
    register_loadout_kit_routes()
except Exception as _kit_err:
    print(f"[KRC NodePack] Warning: Loadout Kit routes failed to load: {_kit_err}")

# KRC sibling packs (Extras, future KRC packs): which are installed and loaded.
try:
    from .utils.krc_packs import register_krc_packs_routes
    register_krc_packs_routes()
except Exception as _packs_err:
    print(f"[KRC NodePack] Warning: KRC packs route failed to load: {_packs_err}")

# The KRC bundle (UNIFIED_BUNDLE_GAMEPLAN.md): one export / import for every node's data.
try:
    from .utils.bundle.routes import register_bundle_routes
    register_bundle_routes()
except Exception as _bundle_err:
    print(f"[KRC NodePack] Warning: KRC bundle routes failed to load: {_bundle_err}")

# KRC's write routes only accept ComfyUI's own page (KRC_EXTERNAL_API_GAMEPLAN.md stage 13):
# a web page from another site open in the browser can't change, delete or import anything.
try:
    from .utils.request_guard import install_same_site_middleware
    install_same_site_middleware()
except Exception as _guard_err:
    print(f"[KRC NodePack] Warning: same-site check failed to load: {_guard_err}")

# The external API for outside apps (/krc/ext/v1, off until the user turns it on) and
# its Options routes. KRC_EXTERNAL_API_GAMEPLAN.md.
try:
    from .utils.ext_api_routes import register_ext_api_routes
    register_ext_api_routes()
except Exception as _ext_api_err:
    print(f"[KRC NodePack] Warning: external API routes failed to load: {_ext_api_err}")

# Single web registration for all consolidated JS extensions.
WEB_DIRECTORY = "./web/js"

__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS", "WEB_DIRECTORY", "__version__"]

# Startup banner: identity + node count, then an optional-capability readout
# (animated thumbnails / posters) so missing video support (PyAV) is visible up front.
# Guarded so a banner failure can never block the pack from loading.
try:
    from .utils.krc_startup import print_banner as _krc_print_banner
    _krc_print_banner(len(NODE_CLASS_MAPPINGS), __version__)
except Exception as _banner_err:  # noqa: BLE001
    print(f"[KRC NodePack] v{__version__} - {len(NODE_CLASS_MAPPINGS)} nodes registered")
