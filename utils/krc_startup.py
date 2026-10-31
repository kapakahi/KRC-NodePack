"""
KRC NodePack startup banner.

A short, greppable readout printed once when ComfyUI loads the pack. Its real job
is to answer, before a user files a bug, *why an optional capability is off* — the
animated-thumbnail path depends on a system ffmpeg the pack deliberately does not
install (dependencies = []). Everything here is cheap and safe at import time: a
few import probes plus the already-cached ffmpeg capability check. It never scans
the LoRA library (that stays lazy) so it can't cause a startup spike.

Two verbosity levels:
  * default  — two lines: identity + hard requirements, then optional capabilities.
  * KRC_QUIET — a single summary line.
"""
import os
import sys

from . import krc_video as kv

PREFIX = "[KRC NodePack]"


def _pillow_version():
    try:
        import PIL  # noqa: F401
    except Exception:  # noqa: BLE001 — any import failure means "unavailable"
        return None
    return getattr(PIL, "__version__", "ok")


def _store_state():
    """'ok' if the KRC data dir (or its nearest existing parent) is writable."""
    try:
        from .krc_paths import get_krc_nodes_dir
        path = get_krc_nodes_dir()
        probe = path
        while not probe.exists() and probe != probe.parent:
            probe = probe.parent
        return "ok" if os.access(probe, os.W_OK) else "read-only"
    except Exception:  # noqa: BLE001
        return None


def _python_version():
    v = sys.version_info
    return f"{v.major}.{v.minor}.{v.micro}"


def _animated_state(cap):
    """(summary_word, line2_fragment) for the animated-thumbnail capability."""
    if cap["webm"]:
        ver = kv.ffmpeg_version()
        # posters are guaranteed here (Pillow fallback if not libwebp), so only
        # advertise +webp when ffmpeg itself has the encoder; don't clutter otherwise.
        webp = "+webp" if kv.have_libwebp() else ""
        # Name where ffmpeg came from, except plain PATH (the unsurprising case).
        source = (cap.get("detection") or {}).get("source") or ""
        via = f"via {source}" if source and source != kv.SOURCE_PATH else ""
        detail = " ".join(x for x in (f"ffmpeg {ver}" if ver else "ffmpeg", via, "+vp9", webp) if x)
        return "on", f"animated thumbnails: ON ({detail})"
    if cap["webmReason"] == "no_ffmpeg":
        return "off", "animated thumbnails: OFF - ffmpeg not found (set it in KRC Portal > Options > Media)"
    return "off", "animated thumbnails: OFF - ffmpeg lacks libvpx-vp9"


def format_lines(node_count, version):
    """Return the list of lines to print (1 line under KRC_QUIET, else 2)."""
    cap = kv.capability()
    pillow = _pillow_version()
    posters = "on" if cap["poster"] else "off"

    if os.environ.get("KRC_QUIET"):
        animated = "on" if cap["webm"] else "off"
        return [f"{PREFIX} v{version} | {node_count} nodes | "
                f"animated:{animated} posters:{posters} | store:{_store_state() or '?'}"]

    # Line 1 — identity + the hard requirements (Python, Pillow).
    pillow_txt = f"Pillow {pillow}" if pillow else "Pillow MISSING (image thumbnails off)"
    line1 = f"{PREFIX} v{version} | {node_count} nodes | Python {_python_version()} | {pillow_txt}"

    # Line 2 — the optional capability verdict + environment.
    _, animated_frag = _animated_state(cap)
    parts = [animated_frag]
    if not cap["webm"] and cap["poster"]:
        parts.append(f"posters ON ({'libwebp' if kv.have_libwebp() else 'Pillow'})")
    store = _store_state()
    if store:
        parts.append(f"store {store}{' [!]' if store != 'ok' else ''}")
    line2 = f"{PREFIX} " + " | ".join(parts)

    return [line1, line2]


def print_banner(node_count, version):
    for line in format_lines(node_count, version):
        print(line)
