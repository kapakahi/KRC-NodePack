"""KRC NodePack public API (Python). The ONLY NodePack module other KRC packs (KRC
NodePack Extras) may use; everything behind it can be refactored freely.

Contract: every name here is listed in KRC_PUBLIC_API.md (dev repo). Any change to the
surface (added, changed or removed) bumps KRC_API_VERSION's minor by one; the major moves
only when the user asks. Change this file, the blueprint and the version in the same
commit.

Reaching it from another pack: look it up lazily (at route or run time, never at
import) through the package attribute ``KRC_PUBLIC_API`` that NodePack's ``__init__``
sets, not through the folder name. ComfyUI imports packs alphabetically, so this keeps
working whatever the folder names are.
"""

from .utils.card_resolve import (
    canonical_id,
    canonical_ids,
    resolve_models,
    resolve_models_async,
    resolve_prompts,
    resolve_prompts_async,
)
from .utils.krc_paths import get_krc_node_dir, read_max_pinned as max_pinned
from .utils.custom_badge import normalize_custom_badge
from .utils.bulk_attributes import validate_bulk_attributes, check_bulk_pin_capacity
from .utils.bulk_selection import validate_card_ids
from .utils.library.card_colors import CARD_COLOR_IDS
from .utils.loadout_kit import LoadoutKit, kit_field
from .utils.library.usage_stats import bump_usage
from .utils.preset_naming import NONE_PRESET_GROUP, canonical_group, canonical_label, compose_trigger
from .utils.server_sync import SYNC_EVENTS, publish_sync
from .utils.pack_network import krc_fetch, network_enabled
from .utils.bundle.pack_sections import register_bundle_section
from .utils import krc_video as _krc_video

KRC_API_VERSION = (2, 9)

__all__ = [
    "validate_card_ids",
    "validate_bulk_attributes",
    "check_bulk_pin_capacity",
    "CARD_COLOR_IDS",
    "KRC_API_VERSION",
    "NONE_PRESET_GROUP",
    "SYNC_EVENTS",
    "bump_usage",
    "canonical_group",
    "canonical_id",
    "canonical_ids",
    "canonical_label",
    "compose_trigger",
    "get_krc_node_dir",
    "kit_field",
    "krc_fetch",
    "loadout_kit",
    "max_pinned",
    "network_enabled",
    "normalize_custom_badge",
    "register_bundle_section",
    "publish_sync",
    "resolve_models",
    "resolve_models_async",
    "resolve_prompts",
    "resolve_prompts_async",
    "video_info",
]


def loadout_kit(kit_id, *, source, slots, fields=(), label="", short_label="", prompt_vault=False):
    """A Loadout Kit (card-stack node) described by a source, a slot count and per-slot
    fields (``kit_field``). The node uses ``kit.input_types()``, ``kit.is_changed()`` and
    ``kit.resolve()``; its JS calls ``registerLoadout({ nodeType, kit: kit_id })``. Create
    it once, lazily (e.g. on the first ``INPUT_TYPES`` call): the JS fetches the descriptor
    when the first node is created, after ComfyUI has called ``INPUT_TYPES``.

    1.7: ``label`` (display name, default the id), ``short_label`` (compact name, default
    ``label``) and ``prompt_vault`` (opt in to a preset row on Prompt Vault)."""
    return LoadoutKit(kit_id, source=source, slots=slots, fields=fields,
                      label=label, short_label=short_label, prompt_vault=prompt_vault)


def video_info():
    """(2.8) What video work this ComfyUI can do. KRC NodePack runs no ffmpeg program: video
    is PyAV (``av``), the library ComfyUI itself requires; a pack's server code uses it the
    same way. -> {"available", "version", "vp9", "opus", "vorbis"}: ``available`` False
    means no PyAV (``version`` is ""); ``vp9`` / ``opus`` / ``vorbis`` say whether its build
    can encode WebM video (VP9) and audio (Opus / Vorbis)."""
    available = _krc_video.VIDEO_SUPPORT
    codecs = set()
    if available:
        try:
            codecs = set(_krc_video.pyav_module().codecs_available)
        except Exception:  # noqa: BLE001 - answer what we know
            codecs = set()
    return {
        "available": bool(available),
        "version": _krc_video.PYAV_VERSION,
        "vp9": "libvpx-vp9" in codecs,
        "opus": "libopus" in codecs,
        "vorbis": "libvorbis" in codecs,
    }
