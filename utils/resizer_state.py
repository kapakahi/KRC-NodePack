"""KRC Resizer's settings, outside the browser: the one Python home of the ``crop_state``
format and its rules, shared by the node (nodes/krc_resizer.py reads its inputs with it) and
the external API provider (utils/resizer_provider.py builds inputs with it).

``crop_state`` is a comma list of integers (the browser writes it in web/js/resizer/ui_state.js
syncWidgets and reads it in geometry.js restoreCropFromWidgets; the dev repo's parity check
runs both against this module). Crop coordinates are in the EFFECTIVE source space: after a
90 / 270 degree rotation, width and height swap.

    0-3   crop x, y, w, h            16 output divisor (16 px grid for crops)
    4-5   output width, height       11 rotate (0 / 90 / 180 / 270)
    6     aspect lock (UI)           12-13 flip x, flip y
    7     megapixel mode             14 retired (always 0)
    8     megapixels * 100           15-16 raw source width, height   } the source identity
    9     no selection               18 frame count, 19 media signature }
    10    output divisor             17 padding enabled
    20    viewed frame (UI)          21-24 fixed range: on, fps * 100, seconds * 10, edge (1 = out)
    25    fine rotation (degrees)    26 mask mode (0 both, 1 input, 2 empty), 27 invert
    28    feather, 29 grow           30 threshold * 1000, 31 resolution lock, 32 frame mode (1/2/3)

The source identity (15, 16, 18, 19) is what the node compares with the input it gets: when
any differs (or a crop has none), the crop is stale and the node runs a full-frame pass
instead (``is_stale`` / ``stale_fallback``). ``media_signature`` is the node's fingerprint.
"""
import math

GRID = 16
DEFAULT_FPS = 24
CROP_STATE_FIELDS = 33
DIVISORS = (1, 8, 16, 32, 64)
PAD_PRESETS = {"wan": (115 / 255, 115 / 255, 115 / 255), "ltx": (0.0, 0.0, 0.0)}
MASK_MODES = ("both", "input", "empty")
FRAME_MODES = ("single", "range", "last")


def nearest_under_grid(ideal_w, ideal_h, budget_px, g):
    """Pick the grid-aligned (W, H) whose area is the greatest that does NOT exceed
    ``budget_px``. Ceils AND floors each axis to ``g``, then among the 2x2 combos keeps
    those with area <= budget and returns the largest; floor/floor is always <= budget, so
    a valid candidate always exists. Mirrors nearestUnderGrid() in web/js/resizer/geometry.js."""
    w_lo = max(g, int(math.floor(ideal_w / g)) * g)
    w_hi = max(g, int(math.ceil(ideal_w / g)) * g)
    h_lo = max(g, int(math.floor(ideal_h / g)) * g)
    h_hi = max(g, int(math.ceil(ideal_h / g)) * g)
    best = (w_lo, h_lo)
    best_area = w_lo * h_lo
    for w in ((w_lo,) if w_hi == w_lo else (w_lo, w_hi)):
        for h in ((h_lo,) if h_hi == h_lo else (h_lo, h_hi)):
            area = w * h
            if area <= budget_px and area > best_area:
                best = (w, h)
                best_area = area
    return best


def parse_color(s):
    """custom_pad_color: "#rrggbb" or "r,g,b" (0-255, or 0-1) -> an RGB 0-1 tuple."""
    s = s.strip().lstrip("#")
    if len(s) == 6 and all(c in "0123456789abcdefABCDEF" for c in s):
        r, g, b = int(s[0:2], 16), int(s[2:4], 16), int(s[4:6], 16)
        return (r / 255.0, g / 255.0, b / 255.0)
    parts = [p.strip() for p in s.split(",")]
    if len(parts) != 3:
        raise ValueError(f"[KRC Resizer] custom_pad_color must be hex or 3 comma-separated values, got: {s!r}")
    vals = [float(p) for p in parts]
    if any(v > 1.0 for v in vals):
        vals = [v / 255.0 for v in vals]
    return tuple(max(0.0, min(1.0, v)) for v in vals)


def parse_frame_select(frame_select, frame_count):
    """(mode, f_in, f_out) from frame_select: "in,out" inclusive, "last", or ""/legacy ->
    single frame 0 (never a whole batch by accident)."""
    max_f = max(0, frame_count - 1)
    mode = "single"
    f_in = f_out = 0
    if frame_select == "last":
        mode = "last"
        f_in = f_out = max_f
    elif frame_select:
        try:
            parts = [int(v) for v in frame_select.split(",")]
            if len(parts) >= 2:
                f_in, f_out = parts[0], parts[1]
                mode = "single" if f_in == f_out else "range"
        except ValueError:
            pass
    f_in = max(0, min(f_in, max_f))
    f_out = max(0, min(f_out, max_f))
    if f_out < f_in:
        f_in, f_out = f_out, f_in
    return mode, f_in, f_out


def changed_input_frame_selection(frame_mode, frame_count):
    """The frames a stale (changed-input) run uses: the browser's new-input reset."""
    max_f = max(0, frame_count - 1)
    if frame_mode == "last":
        return max_f, max_f
    if frame_mode == "range":
        return 0, max_f
    return 0, 0


def parse_crop_state(crop_state):
    """crop_state -> its values, with the node's defaults and clamps. An unreadable value
    (any non-integer field) reads as all defaults, as in the node. The resolution lock
    forces manual output and divisor 1."""
    s = {
        "crop_x": 0, "crop_y": 0, "crop_w": 0, "crop_h": 0, "output_width": 0, "output_height": 0,
        "ar_locked": False, "res_mode_mp": False, "target_mp": 0.0, "no_select": False, "divisor": GRID,
        "rotate": 0, "flip_x": False, "flip_y": False, "base_src_w": 0, "base_src_h": 0, "padding_enabled": True,
        "base_frame_count": 0, "base_media_sig": 0, "view_frame": 0, "fixed_range": False,
        "fixed_fps": float(DEFAULT_FPS), "fixed_seconds": 5.0, "fixed_edge_out": False, "audio_fps": DEFAULT_FPS,
        "fine_rotate": 0, "mask_mode": "both", "mask_invert": False, "mask_feather": 0, "mask_grow": 0,
        "mask_threshold": 0.0, "res_locked": False, "frame_mode_code": 0, "fields": 0,
    }
    if crop_state:
        try:
            parts = [int(v) for v in crop_state.split(",")]
        except ValueError:
            parts = []
        s["fields"] = len(parts)
        n = len(parts)
        if n >= 4:
            s["crop_x"], s["crop_y"], s["crop_w"], s["crop_h"] = parts[:4]
        if n >= 6:
            s["output_width"], s["output_height"] = parts[4], parts[5]
        if n >= 7:
            s["ar_locked"] = parts[6] != 0
        if n >= 8:
            s["res_mode_mp"] = parts[7] != 0
        if n >= 9:
            s["target_mp"] = parts[8] / 100.0
        if n >= 10:
            s["no_select"] = parts[9] != 0
        if n >= 11 and parts[10] > 0:
            s["divisor"] = parts[10]
        if n >= 12 and parts[11] in (90, 180, 270):
            s["rotate"] = parts[11]
        if n >= 13:
            s["flip_x"] = parts[12] != 0
        if n >= 14:
            s["flip_y"] = parts[13] != 0
        if n >= 17:
            s["base_src_w"], s["base_src_h"] = parts[15], parts[16]
        if n >= 18:
            s["padding_enabled"] = parts[17] != 0
        if n >= 19:
            s["base_frame_count"] = parts[18]
        if n >= 20:
            s["base_media_sig"] = parts[19]
        if n >= 21:
            s["view_frame"] = parts[20]
        if n >= 22:
            s["fixed_range"] = parts[21] != 0
        if n >= 23 and parts[22] > 0:
            s["fixed_fps"] = parts[22] / 100.0
            s["audio_fps"] = max(1.0, min(99.0, parts[22] / 100.0))
        if n >= 24 and parts[23] > 0:
            s["fixed_seconds"] = parts[23] / 10.0
        if n >= 25:
            s["fixed_edge_out"] = parts[24] != 0
        if n >= 26:
            s["fine_rotate"] = max(-180, min(180, parts[25]))
        if n >= 27:
            s["mask_mode"] = "input" if parts[26] == 1 else "empty" if parts[26] == 2 else "both"
        if n >= 28:
            s["mask_invert"] = parts[27] != 0
        if n >= 29:
            s["mask_feather"] = max(0, min(99, parts[28]))
        if n >= 30:
            s["mask_grow"] = max(-99, min(99, parts[29]))
        if n >= 31:
            s["mask_threshold"] = max(0.0, min(1.0, parts[30] / 1000.0))
        if n >= 32:
            s["res_locked"] = parts[31] != 0
        if n >= 33:
            s["frame_mode_code"] = parts[32]
    if s["res_locked"]:
        s["res_mode_mp"] = False
        s["divisor"] = 1
    return s


def is_stale(crop_state, parsed, width, height, frame_count, media_sig):
    """The node's rule: the crop was computed for another input (or carries no identity)."""
    p = parsed
    has_identity = bool(p["base_src_w"] and p["base_src_h"] and p["base_frame_count"] and p["base_media_sig"])
    return bool(
        (bool(crop_state) and not has_identity)
        or (p["base_src_w"] and p["base_src_h"] and (p["base_src_w"] != width or p["base_src_h"] != height))
        or (p["base_frame_count"] and p["base_frame_count"] != frame_count)
        or (p["base_media_sig"] and p["base_media_sig"] != media_sig)
    )


def _sample_positions(size):
    """torch.linspace(0, size - 1, steps=min(5, size)).round().long(), without torch: the
    positions are exact quarter steps, which float32 (torch) and float64 (numpy) both hold
    exactly, and both round half to even."""
    import numpy as np

    return np.round(np.linspace(0, size - 1, num=min(5, size))).astype(np.int64)


def media_signature(frame_count, height, width, frame_at):
    """The node's input fingerprint (what crop_state field 19 must hold). ``frame_at(i)``
    gives frame ``i`` as the node sees it: a torch (H, W, 3) float tensor, or a uint8 /
    float32 numpy array (uint8 is read as value / 255, which is how Load Image and KRC
    Media Loader build their tensors). Only frames 0 and the last are sampled."""
    import numpy as np

    n, h, w = int(frame_count), int(height), int(width)
    frame_indices = [0] if n == 1 else [0, n - 1]
    sig = (n * 1000003 + h * 1009 + w * 9176) & 0x7fffffff
    ys, xs = _sample_positions(h), _sample_positions(w)
    for fi in frame_indices:
        frame = frame_at(fi)
        if hasattr(frame, "detach"):   # a torch tensor (the node's own input)
            import torch
            rows = torch.as_tensor(ys, device=frame.device)
            cols = torch.as_tensor(xs, device=frame.device)
            sample = frame[rows][:, cols, :].detach().float().cpu().numpy()
        else:
            array = np.asarray(frame)
            sample = array[np.ix_(ys, xs)][..., :3]
            sample = sample.astype(np.float32) / np.float32(255.0) if array.dtype == np.uint8 else sample.astype(np.float32)
        vals = (sample.reshape(-1) * 255.0).round().astype(np.int64)
        for v in vals:
            sig = ((sig * 131) + int(v)) & 0x7fffffff
    return int(sig)


# ---- structured settings (the external API) -------------------------------------------

class SettingsError(ValueError):
    """Settings the Resizer can't take; the message says which."""


def _effective(width, height, rotate):
    return (height, width) if rotate in (90, 270) else (width, height)


def _quantize(crop):
    """geometry.js quantizeSrc: the 16 px grid, at least one cell."""
    return {"x": round(crop["x"] / GRID) * GRID, "y": round(crop["y"] / GRID) * GRID,
            "w": max(GRID, round(crop["w"] / GRID) * GRID), "h": max(GRID, round(crop["h"] / GRID) * GRID)}


def _constrain(crop, src_w, src_h, padding, divisor):
    """geometry.js constrainSrcToPaddingMode (no aspect): with padding the crop must touch
    the source by at least 1 px; without, it stays inside, in divisor steps."""
    c = dict(crop)
    if padding:
        if c["x"] >= src_w - 1:
            c["x"] = src_w - 1
        if c["y"] >= src_h - 1:
            c["y"] = src_h - 1
        if c["x"] + c["w"] <= 1:
            c["x"] = 1 - c["w"]
        if c["y"] + c["h"] <= 1:
            c["y"] = 1 - c["h"]
        return c
    g = divisor or GRID
    c["w"] = min(max(g, c["w"]), max(g, (src_w // g) * g))
    c["h"] = min(max(g, c["h"]), max(g, (src_h // g) * g))
    c["x"] = max(0, min(c["x"], max(0, src_w - c["w"])))
    c["y"] = max(0, min(c["y"], max(0, src_h - c["h"])))
    return c


def _bool(value, name):
    if not isinstance(value, bool):
        raise SettingsError(f"{name} must be true or false")
    return value


def _int(value, name, lo, hi):
    if isinstance(value, bool) or not isinstance(value, (int, float)) or float(value) != int(value):
        raise SettingsError(f"{name} must be a whole number")
    value = int(value)
    if not lo <= value <= hi:
        raise SettingsError(f"{name} must be from {lo} to {hi}")
    return value


def _number(value, name, lo, hi):
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(float(value)):
        raise SettingsError(f"{name} must be a number")
    if not lo <= float(value) <= hi:
        raise SettingsError(f"{name} must be from {lo:g} to {hi:g}")
    return float(value)


def _object(value, name, keys):
    if value is None:
        return {}
    if not isinstance(value, dict):
        raise SettingsError(f"{name} must be an object")
    unknown = sorted(set(value) - set(keys))
    if unknown:
        raise SettingsError(f"{name}: unknown key {unknown[0]!r} (one of {', '.join(keys)})")
    return value


SETTINGS_KEYS = ("crop", "noSelection", "aspectLocked", "output", "padding", "rotate", "fineRotate", "flipX", "flipY",
                 "frames", "mask", "passthrough")


def build_inputs(identity, settings):
    """Structured settings for one source -> (inputs, normalized settings). ``identity``:
    {"width", "height", "frameCount", "mediaSig"} of the raw source. Raises SettingsError.
    The inputs are the node's own: crop_state (stamped with this identity, so the node
    never treats it as stale for this source), pad_color, custom_pad_color, frame_select,
    passthrough."""
    width, height = int(identity["width"]), int(identity["height"])
    frame_count, media_sig = int(identity["frameCount"]), int(identity["mediaSig"])
    if width < 32 or height < 32 or frame_count < 1:
        raise SettingsError("The source is too small for KRC Resizer (at least 32 x 32, one frame)")
    settings = _object(settings, "settings", SETTINGS_KEYS)

    rotate = settings.get("rotate", 0)
    if rotate not in (0, 90, 180, 270):
        raise SettingsError("rotate must be 0, 90, 180 or 270")
    fine = _int(settings.get("fineRotate", 0), "fineRotate", -180, 180)
    flip_x = _bool(settings.get("flipX", False), "flipX")
    flip_y = _bool(settings.get("flipY", False), "flipY")
    src_w, src_h = _effective(width, height, rotate)

    output = _object(settings.get("output"), "output", ("mode", "megapixels", "width", "height", "divisor", "locked"))
    locked = _bool(output.get("locked", False), "output.locked")
    mode = "manual" if locked else output.get("mode", "megapixels")
    if mode not in ("megapixels", "manual"):
        raise SettingsError('output.mode must be "megapixels" or "manual"')
    divisor = 1 if locked else output.get("divisor", 32)
    if divisor not in DIVISORS:
        raise SettingsError(f"output.divisor must be one of {', '.join(map(str, DIVISORS))}")

    padding = _object(settings.get("padding"), "padding", ("enabled", "color", "custom"))
    pad_enabled = _bool(padding.get("enabled", True), "padding.enabled")
    pad_color = padding.get("color", "ltx")
    if pad_color not in ("ltx", "wan", "custom"):
        raise SettingsError('padding.color must be "ltx", "wan" or "custom"')
    custom = padding.get("custom", "115,115,115")
    if not isinstance(custom, str):
        raise SettingsError("padding.custom must be \"r,g,b\" or \"#rrggbb\"")
    try:
        parse_color(custom)
    except ValueError:
        raise SettingsError("padding.custom must be \"r,g,b\" or \"#rrggbb\"") from None

    no_select = _bool(settings.get("noSelection", "crop" not in settings or settings.get("crop") is None), "noSelection")
    if no_select:
        crop = {"x": 0, "y": 0, "w": src_w, "h": src_h}
    else:
        raw = _object(settings.get("crop"), "crop", ("x", "y", "w", "h"))
        if set(raw) != {"x", "y", "w", "h"}:
            raise SettingsError("crop needs x, y, w and h (effective source pixels, after rotate)")
        crop = {key: _int(raw[key], f"crop.{key}", -100000, 100000) for key in ("x", "y", "w", "h")}
        if crop["w"] < 1 or crop["h"] < 1:
            raise SettingsError("crop.w and crop.h must be positive")
        full = crop == {"x": 0, "y": 0, "w": src_w, "h": src_h}
        if not full:
            crop = _constrain(_quantize(crop), src_w, src_h, pad_enabled, divisor)
    crop_ar = crop["w"] / crop["h"]

    if mode == "megapixels":
        mp = _number(output.get("megapixels", 0.6), "output.megapixels", 0.01, 100.0)
        mp = round(mp * 100) / 100.0
        ideal_w = math.sqrt(mp * 1e6 * crop_ar)
        out_w, out_h = nearest_under_grid(ideal_w, ideal_w / crop_ar, mp * 1e6, divisor)
    else:
        mp = _number(output.get("megapixels", 0.6), "output.megapixels", 0.01, 100.0) if "megapixels" in output else 0.6
        out_w = _int(output.get("width", 0), "output.width", 1, 16384)
        g = max(1, divisor)
        if "height" in output:
            out_h = _int(output["height"], "output.height", 1, 16384)
        else:   # geometry.js syncOutToAR: height follows the crop's aspect
            out_h = max(g, round(out_w / crop_ar / g) * g)
        out_w = max(g, round(out_w / g) * g)
        out_h = max(g, round(out_h / g) * g)

    frames = _object(settings.get("frames"), "frames", ("mode", "in", "out", "fps", "fixedRange", "viewFrame"))
    frame_mode = frames.get("mode", "single")
    if frame_mode not in FRAME_MODES:
        raise SettingsError('frames.mode must be "single", "range" or "last"')
    last = frame_count - 1
    f_in = _int(frames.get("in", 0), "frames.in", 0, last)
    if frame_mode == "range":
        f_out = _int(frames.get("out", last), "frames.out", 0, last)
        if f_out < f_in:
            raise SettingsError("frames.out must not be before frames.in")
    elif frame_mode == "last":
        f_in = f_out = last
    else:
        f_out = f_in
    fps = _number(frames.get("fps", DEFAULT_FPS), "frames.fps", 1, 99)
    fixed = _object(frames.get("fixedRange"), "frames.fixedRange", ("enabled", "seconds", "activeEdge"))
    fixed_on = _bool(fixed.get("enabled", False), "frames.fixedRange.enabled")
    seconds = _number(fixed.get("seconds", 5), "frames.fixedRange.seconds", 0.1, 3600)
    edge = fixed.get("activeEdge", "in")
    if edge not in ("in", "out"):
        raise SettingsError('frames.fixedRange.activeEdge must be "in" or "out"')
    view = _int(frames.get("viewFrame", f_in), "frames.viewFrame", 0, last)

    mask = _object(settings.get("mask"), "mask", ("mode", "invert", "feather", "grow", "threshold"))
    mask_mode = mask.get("mode", "both")
    if mask_mode not in MASK_MODES:
        raise SettingsError('mask.mode must be "both", "input" or "empty"')
    mask_invert = _bool(mask.get("invert", False), "mask.invert")
    feather = _int(mask.get("feather", 0), "mask.feather", 0, 99)
    grow = _int(mask.get("grow", 0), "mask.grow", -99, 99)
    threshold = _number(mask.get("threshold", 0), "mask.threshold", 0, 1)

    ar_locked = _bool(settings.get("aspectLocked", False), "aspectLocked")
    passthrough = _bool(settings.get("passthrough", False), "passthrough")

    fields = [crop["x"], crop["y"], crop["w"], crop["h"], out_w, out_h, int(ar_locked),
              int(mode == "megapixels"), int(round(mp * 100)), int(no_select), divisor or GRID,
              rotate, int(flip_x), int(flip_y), 0,
              width, height, int(pad_enabled), frame_count, media_sig, view,
              int(fixed_on), int(round(fps * 100)), int(round(seconds * 10)), int(edge == "out"),
              fine, MASK_MODES.index(mask_mode), int(mask_invert), feather, grow, int(round(threshold * 1000)),
              int(locked), {"single": 1, "range": 2, "last": 3}[frame_mode]]
    inputs = {
        "crop_state": ",".join(str(int(v)) for v in fields),
        "pad_color": pad_color,
        "custom_pad_color": custom,
        "frame_select": "last" if frame_mode == "last" else f"{f_in},{f_out}",
        "passthrough": "1" if passthrough else "0",
    }
    normalized = {
        "crop": crop, "noSelection": no_select, "aspectLocked": ar_locked,
        "output": {"mode": mode, "megapixels": mp, "width": out_w, "height": out_h, "divisor": divisor, "locked": locked},
        "padding": {"enabled": pad_enabled, "color": pad_color, "custom": custom},
        "rotate": rotate, "fineRotate": fine, "flipX": flip_x, "flipY": flip_y,
        "frames": {"mode": frame_mode, "in": f_in, "out": f_out, "fps": fps,
                   "fixedRange": {"enabled": fixed_on, "seconds": seconds, "activeEdge": edge}, "viewFrame": view},
        "mask": {"mode": mask_mode, "invert": mask_invert, "feather": feather, "grow": grow, "threshold": threshold},
        "passthrough": passthrough,
        "effectiveSource": {"width": src_w, "height": src_h},
    }
    return inputs, normalized


def read_settings(inputs, identity=None):
    """The node's inputs (crop_state, pad_color, custom_pad_color, frame_select, passthrough)
    -> structured settings, as the node will read them, plus whether the crop is stale for
    ``identity`` (the source it will get; None = unknown) and, when it is, what the node
    actually runs instead (``fallback``)."""
    crop_state = str(inputs.get("crop_state") or "")
    p = parse_crop_state(crop_state)
    width = int((identity or {}).get("width") or p["base_src_w"] or 0)
    height = int((identity or {}).get("height") or p["base_src_h"] or 0)
    frame_count = int((identity or {}).get("frameCount") or p["base_frame_count"] or 1)
    frame_select = str(inputs.get("frame_select") or "")
    # What the node runs: frame_select alone (field 32 is the browser's own memory).
    mode, f_in, f_out = parse_frame_select(frame_select, frame_count)
    pad_color = str(inputs.get("pad_color") or "ltx")
    settings = {
        "crop": None if p["crop_w"] < GRID or p["crop_h"] < GRID else
        {"x": p["crop_x"], "y": p["crop_y"], "w": p["crop_w"], "h": p["crop_h"]},
        "noSelection": p["no_select"], "aspectLocked": p["ar_locked"],
        "output": {"mode": "megapixels" if p["res_mode_mp"] else "manual", "megapixels": p["target_mp"],
                   "width": p["output_width"], "height": p["output_height"], "divisor": p["divisor"], "locked": p["res_locked"]},
        "padding": {"enabled": p["padding_enabled"], "color": pad_color if pad_color in PAD_PRESETS else "custom",
                    "custom": str(inputs.get("custom_pad_color") or "115,115,115")},
        "rotate": p["rotate"], "fineRotate": p["fine_rotate"], "flipX": p["flip_x"], "flipY": p["flip_y"],
        "frames": {"mode": mode, "in": f_in, "out": f_out, "fps": p["audio_fps"],
                   "fixedRange": {"enabled": p["fixed_range"], "seconds": p["fixed_seconds"],
                                  "activeEdge": "out" if p["fixed_edge_out"] else "in"},
                   "viewFrame": p["view_frame"]},
        "mask": {"mode": p["mask_mode"], "invert": p["mask_invert"], "feather": p["mask_feather"],
                 "grow": p["mask_grow"], "threshold": p["mask_threshold"]},
        "passthrough": str(inputs.get("passthrough") or "0") == "1",
    }
    answer = {"settings": settings, "source": {"width": p["base_src_w"], "height": p["base_src_h"],
                                               "frameCount": p["base_frame_count"], "mediaSig": p["base_media_sig"]}}
    if identity is not None:
        stale = is_stale(crop_state, p, width, height, frame_count, int(identity.get("mediaSig") or 0))
        answer["stale"] = stale
        if stale:
            answer["fallback"] = stale_fallback(p, mode, width, height, frame_count)
    return answer


def stale_fallback(p, frame_mode, width, height, frame_count):
    """What the node runs instead of a stale crop: no rotation, frames reset for the mode,
    and either the locked resolution's centred crop or the whole frame (no selection)."""
    f_in, f_out = changed_input_frame_selection(frame_mode, frame_count)
    crop, no_select = None, True
    if (p["res_locked"] and not p["no_select"] and not p["res_mode_mp"]
            and p["output_width"] >= GRID and p["output_height"] >= GRID):
        ar = p["output_width"] / p["output_height"]
        if width / height > ar:
            ch = max(GRID, (height // GRID) * GRID)
            cw = max(GRID, int((ch * ar) // GRID) * GRID)
        else:
            cw = max(GRID, (width // GRID) * GRID)
            ch = max(GRID, int((cw / ar) // GRID) * GRID)
        crop = {"x": round((width - cw) / (2 * GRID)) * GRID, "y": round((height - ch) / (2 * GRID)) * GRID, "w": cw, "h": ch}
        no_select = False
    return {"rotate": 0, "fineRotate": 0, "frames": {"in": f_in, "out": f_out}, "crop": crop, "noSelection": no_select}
