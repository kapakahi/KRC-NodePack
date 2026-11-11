import base64
import io
from collections import OrderedDict

import numpy as np
import server
import torch
import torch.nn.functional as F
from aiohttp import web
from PIL import Image

from ..utils.resizer_mask import combine_masks, normalize_mask, select_mask_frames
# crop_state's format and rules live in one place, shared with the external API provider.
from ..utils.resizer_state import (
    changed_input_frame_selection as _changed_input_frame_selection,
    is_stale,
    media_signature,
    nearest_under_grid as _nearest_under_grid,
    parse_color as _parse_color,
    parse_crop_state,
    parse_frame_select as _parse_frame_select,
    stale_fallback,
)
from ..utils.resizer_transform import (
    apply_fine_rotation_chunked,
    apply_fine_rotation_mask_chunked,
    apply_transform,
    apply_transform_mask,
    sample_fine_rotated_crop_chunked,
    sample_fine_rotated_crop_mask_chunked,
)

_GRID = 16

_MIN_DIM = 32           # smaller than this is not a real video frame
_FINE_ROTATE_CHUNK = 8  # bound grid_sample memory for batch/video fine rotation


# Module-level frame cache: str(node_id) -> {"width", "height", "frame_count",
# "media_sig", "frames"}. Populated on each node execution; consumed by the JS
# widget via API. Ordered so the least-recently-used entry can be evicted once
# the total encoded size exceeds _MAX_CACHE_BYTES — otherwise the dict grows
# unbounded across a session (stale node ids from deleted/edited nodes linger).
_frame_cache = OrderedDict()

# Soft ceiling on total encoded bytes held across all cached nodes. Evicted
# LRU-first; the just-written entry is always kept even if it exceeds this alone.
_MAX_CACHE_BYTES = 512 * 1024 * 1024


def _cache_entry_bytes(entry):
    return sum(len(f) for f in entry["frames"])


def _store_frame_cache(key, entry):
    """Insert/replace a cache entry as most-recently-used, then evict LRU
    entries until the total encoded size is within _MAX_CACHE_BYTES."""
    _frame_cache.pop(key, None)          # drop any prior entry so re-insert re-orders
    _frame_cache[key] = entry            # appended → most-recently-used
    total = sum(_cache_entry_bytes(e) for e in _frame_cache.values())
    while total > _MAX_CACHE_BYTES and len(_frame_cache) > 1:
        _, evicted = _frame_cache.popitem(last=False)   # oldest
        total -= _cache_entry_bytes(evicted)


def _notify_preview_ready(unique_id):
    """Tell the browser this node's frame cache is ready to fetch."""
    try:
        server.PromptServer.instance.send_sync("krc-resizer-preview-ready", {
            "node_id": str(unique_id),
        })
    except Exception:
        # Preview refresh is best-effort; image processing should never fail
        # just because the UI websocket is unavailable.
        pass


def _tensor_to_jpeg(frame_tensor):
    """Convert a (H, W, 3) float32 0-1 tensor to JPEG bytes."""
    arr = (frame_tensor.cpu().numpy() * 255).clip(0, 255).astype(np.uint8)
    img = Image.fromarray(arr)
    buf = io.BytesIO()
    img.save(buf, format="JPEG", quality=85)
    return buf.getvalue()


def _media_signature(images):
    """Cheap deterministic input fingerprint for first-run stale-state detection
    (utils/resizer_state.media_signature, shared with the external API)."""
    n, h, w, _ = images.shape
    return media_signature(n, h, w, lambda index: images[index])


def _slice_audio_for_range(audio, frame_mode, f_in, frame_count, fps):
    """Clip a ComfyUI AUDIO dict to the selected local frame range."""
    if frame_mode != "range" or audio is None:
        return None
    if isinstance(audio, dict):
        waveform = audio.get("waveform")
        sample_rate = audio.get("sample_rate")
    else:
        try:
            waveform = audio["waveform"]
            sample_rate = audio["sample_rate"]
        except (KeyError, TypeError, AttributeError):
            waveform = getattr(audio, "waveform", None)
            sample_rate = getattr(audio, "sample_rate", None)
    if waveform is None or sample_rate is None or not hasattr(waveform, "shape"):
        return None
    try:
        sr = int(sample_rate)
        fps = float(fps)
    except (TypeError, ValueError):
        return None
    if sr <= 0 or fps <= 0:
        return None
    total_samples = int(waveform.shape[-1])
    start = max(0, min(total_samples, round((f_in / fps) * sr)))
    count = max(0, round((frame_count / fps) * sr))
    end = max(start, min(total_samples, start + count))
    return {
        "waveform": waveform[..., start:end].contiguous(),
        "sample_rate": sr,
    }


class KRCResizer:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "images": ("IMAGE", {
                    "tooltip": "Image or frame batch to crop, pad, resize, or pass through with KRC Resizer."
                }),
                "crop_state": ("STRING", {
                    "default": "",
                    "tooltip": "Managed by the KRC Resizer UI; stores the current crop box.",
                }),
                "pad_color": ("STRING", {
                    "default": "ltx",
                    "tooltip": "Managed by the KRC Resizer UI; stores the selected padding color preset.",
                }),
                "custom_pad_color": ("STRING", {
                    "default": "115,115,115",
                    "tooltip": "Managed by the KRC Resizer UI; stores the custom padding color.",
                }),
                "frame_select": ("STRING", {
                    "default": "",
                    "tooltip": "Managed by the KRC Resizer UI; stores the selected frame range.",
                }),
                "passthrough": ("STRING", {
                    "default": "0",
                    "tooltip": "Managed by the KRC Resizer UI; stores whether passthrough is enabled.",
                }),
            },
            "hidden": {
                "unique_id": "UNIQUE_ID",
            },
            "optional": {
                "mask": ("MASK", {
                    "tooltip": "Optional mask to crop, pad, resize, rotate, flip, and frame-select with the image."
                }),
                "audio": ("AUDIO", {
                    "tooltip": "Optional VHS audio. In Range mode, KRC Resizer clips it to match the selected output frame range."
                }),
            },
        }

    RETURN_TYPES = ("IMAGE", "MASK", "AUDIO")
    RETURN_NAMES = ("output_images", "output_mask", "output_audio")
    FUNCTION = "process"
    OUTPUT_NODE = True
    CATEGORY = "KRC NodePack"
    DESCRIPTION = (
        "Interactively crop, pad, resize, rotate, flip, and select frame ranges "
        "from image batches, with both resolution-based and megapixel-based "
        "output sizing, a literal passthrough, and DISABLE (mute) on the node."
    )

    # ------------------------------------------------------------------
    # Main
    # ------------------------------------------------------------------

    def process(self, images, crop_state, pad_color, custom_pad_color,
                      frame_select, passthrough, unique_id, mask=None, audio=None):
        n, src_h, src_w, _ = images.shape
        input_mask = normalize_mask(mask, n, src_h, src_w, images.device, images.dtype)

        if src_w < _MIN_DIM or src_h < _MIN_DIM:
            raise ValueError(
                f"[KRC Resizer] Input frame dimensions ({src_w}x{src_h}) are too small to be valid. "
                "Connect a real image or video frame batch before running the node."
            )

        # Cache ALL input frames so the JS viewer/scrubber always spans the full
        # video, independent of any frame selection applied to the outputs.
        # Re-encoding every frame to JPEG is the node's biggest CPU cost, so skip
        # it when the input is unchanged: an existing entry whose media_sig, frame
        # count and dimensions all match is the same media — reuse its JPEGs.
        media_sig = _media_signature(images)
        key = str(unique_id)
        prev = _frame_cache.get(key)
        if (prev is not None
                and prev["media_sig"] == media_sig
                and prev["frame_count"] == n
                and prev["width"] == src_w
                and prev["height"] == src_h):
            frames = prev["frames"]
        else:
            frames = [_tensor_to_jpeg(images[i]) for i in range(n)]
        _store_frame_cache(key, {
            "width": src_w,
            "height": src_h,
            "frame_count": n,
            "media_sig": media_sig,
            "frames": frames,
        })
        _notify_preview_ready(unique_id)

        # ── Passthrough ───────────────────────────────────────────────────
        # A literal pass-through: every input frame, the audio and the mask exactly as
        # they came in. No frame selection, transform, crop, resize or mask settings.
        if passthrough == "1":
            print(f"[KRC Resizer] passthrough {src_w}x{src_h} | frames={n} (untouched)")
            output_mask = mask if mask is not None else torch.zeros((n, src_h, src_w), device=images.device, dtype=images.dtype)
            return (images, output_mask, audio)

        # ── Frame selection ───────────────────────────────────────────────
        # frame_select is "in,out" inclusive indices or "last", set by the
        # canvas widget. Empty/legacy values are intentionally safe: output only
        # frame 0 instead of silently sending a full batch into image workflows.
        frame_mode, f_in, f_out = _parse_frame_select(frame_select, n)

        # Parse crop state from widget value ("x,y,w,h" or "x,y,w,h,ow,oh,...").
        # The trailing fields (7th onward) are canvas UI flags: index 9 = No-Selection,
        # 10 = output divisor, 11 = rotation, 12/13 = horizontal/vertical flips,
        # 14 = retired (was the output target; always 0), 15/16 = the raw source dims the crop was computed against,
        # 17 = padding enabled, 18 = frame count, 19 = media fingerprint,
        # 20 = viewed frame, 21 = fixed range enabled, 22 = fixed FPS*100,
        # 23 = fixed duration seconds*10, 24 = fixed active edge, 25 = fine
        # rotation angle, 26 = mask mode (0=both, 1=input, 2=empty), 27 = invert
        # output_mask, 28 = feather UI value, 29 = grow UI value, 30 = threshold * 1000,
        # 31 = manual resolution lock, 32 = explicit frame mode (frontend persistence only).
        # Crop coords are in EFFECTIVE (post-rotation)
        # source space, matching the transformed frames below.
        p = parse_crop_state(crop_state)
        crop_x, crop_y, crop_w, crop_h = p["crop_x"], p["crop_y"], p["crop_w"], p["crop_h"]
        output_width, output_height = p["output_width"], p["output_height"]
        no_select = p["no_select"]
        res_mode_mp = p["res_mode_mp"]          # field 7: output sizing mode (1 = megapixels)
        target_mp = p["target_mp"]              # field 8: megapixel target (stored *100)
        divisor = p["divisor"]                  # output W/H must be a multiple of this (field 10)
        rotate = p["rotate"]
        flip_x, flip_y = p["flip_x"], p["flip_y"]
        padding_enabled = p["padding_enabled"]
        fine_rotate = p["fine_rotate"]
        mask_mode, mask_invert = p["mask_mode"], p["mask_invert"]
        mask_feather, mask_grow, mask_threshold = p["mask_feather"], p["mask_grow"], p["mask_threshold"]
        res_locked = p["res_locked"]            # forces manual output and divisor 1
        audio_fps = p["audio_fps"]

        # Guarantee a full-frame pass when the crop was computed for a different
        # input. The canvas only learns a new input's identity AFTER a run, so the
        # first run on a changed input would otherwise apply stale crop/frame state.
        # Dims catch most changes; frame count and media_sig catch same-size swaps.
        # src_w/src_h here are still the raw input dims (transform happens below).
        if is_stale(crop_state, p, src_w, src_h, n, media_sig):
            print("[KRC Resizer] input changed; full-frame pass this run")
            fallback = stale_fallback(p, frame_mode, src_w, src_h, n)
            rotate = fallback["rotate"]
            fine_rotate = fallback["fineRotate"]
            f_in, f_out = fallback["frames"]["in"], fallback["frames"]["out"]
            no_select = fallback["noSelection"]
            if fallback["crop"]:
                crop = fallback["crop"]
                crop_x, crop_y, crop_w, crop_h = crop["x"], crop["y"], crop["w"], crop["h"]

        frames = images[f_in:f_out + 1]
        n_sel  = frames.shape[0]
        selected_mask = select_mask_frames(input_mask, f_in, f_out, n_sel)
        sel_info = "" if (f_in == 0 and f_out == n - 1) else f" | frames {f_in}-{f_out} of {n}"

        output_audio = _slice_audio_for_range(audio, frame_mode, f_in, n_sel, audio_fps)

        _PRESETS = {"wan": (115 / 255, 115 / 255, 115 / 255), "ltx": (0.0, 0.0, 0.0)}
        fill_rgb = _PRESETS[pad_color] if pad_color in _PRESETS else _parse_color(custom_pad_color)

        # ── Rotate / flip ─────────────────────────────────────────────────
        # Transform the selected frames up front so crop/No-Selection operate on
        # the rotated/flipped frame. A 90°/270° rotation swaps H and W, so
        # recompute the working source dims.
        if fine_rotate:
            if rotate:
                frames = apply_transform(frames, rotate, False, False)
                if selected_mask is not None:
                    selected_mask = apply_transform_mask(selected_mask, rotate, False, False)
                src_h, src_w = frames.shape[1], frames.shape[2]
        elif rotate or flip_x or flip_y:
            frames = apply_transform(frames, rotate, flip_x, flip_y)
            if selected_mask is not None:
                selected_mask = apply_transform_mask(selected_mask, rotate, flip_x, flip_y)
            src_h, src_w = frames.shape[1], frames.shape[2]

        # Fallback: widget hasn't set crop values yet (first run, uninitialized).
        if crop_w < _GRID or crop_h < _GRID:
            crop_x = 0
            crop_y = 0
            crop_w = src_w
            crop_h = src_h
            no_select = True
            print(
                f"[KRC Resizer] crop_state unset - using full-frame default: "
                f"x={crop_x} y={crop_y} w={crop_w} h={crop_h}"
            )

        # No-Selection mode: ignore the supplied crop window and use the full
        # ACTUAL source frame, so the output is the whole image resized — never
        # cropped or padded — regardless of any stale dimensions the canvas may
        # have sent before it learned the real input size.
        if no_select:
            crop_x = crop_y = 0
            crop_w, crop_h = src_w, src_h
            # Derive the output aspect ratio from the ACTUAL source frame. The
            # canvas-supplied output dims may carry a previous input's aspect
            # ratio (it can't know the new size until the node has run once),
            # which would squeeze/stretch the image. Treat them as a pixel
            # budget and re-derive at the true source AR.
            if output_width >= _GRID and output_height >= _GRID:
                ar = src_w / src_h
                if res_mode_mp and target_mp > 0:
                    # Reproduce the frontend applyMP EXACTLY against the true source
                    # AR, using the raw megapixel target — not the product of the
                    # already-quantised dims, which would compound the rounding.
                    # Nearest-under: pick the grid-aligned pair with the largest
                    # area that still sits at or under the MP budget, so output
                    # never overshoots the target (shortfall ≤ one grid step). This
                    # keeps No-Selection identical to normal (selection) MP output
                    # for a same-AR image.
                    ideal_w = (target_mp * 1e6 * ar) ** 0.5
                    ow, oh = _nearest_under_grid(ideal_w, ideal_w / ar, target_mp * 1e6, divisor)
                else:
                    # Manual W×H: treat the sent dims as a pixel budget and
                    # re-project onto the true source AR (they can still carry a
                    # previous input's AR before the canvas learns the new size).
                    # Nearest-under, same as MP mode, so the re-projected output
                    # never exceeds the requested pixel budget.
                    target_px = output_width * output_height
                    ideal_w = (target_px * ar) ** 0.5
                    ow, oh = _nearest_under_grid(ideal_w, ideal_w / ar, target_px, divisor)
                output_width, output_height = ow, oh

        if not padding_enabled and not no_select:
            crop_w = min(crop_w, max(divisor, (src_w // divisor) * divisor))
            crop_h = min(crop_h, max(divisor, (src_h // divisor) * divisor))
            crop_x = max(0, min(crop_x, max(0, src_w - crop_w)))
            crop_y = max(0, min(crop_y, max(0, src_h - crop_h)))

        crop_w_dim, crop_h_dim = crop_w, crop_h

        # Determine effective output resolution early so we can work at the
        # smallest possible buffer size throughout.
        eff_w = output_width  if output_width  >= _GRID else crop_w_dim
        eff_h = output_height if output_height >= _GRID else crop_h_dim

        # Guarantee the output is divisible by the requested factor (e.g. Wan needs
        # 16 or 32). The canvas normally sends already-aligned dims, but this also
        # covers the unset-output case (eff = crop) and any stale-state edges.
        eff_w = max(divisor, round(eff_w / divisor) * divisor)
        eff_h = max(divisor, round(eff_h / divisor) * divisor)

        if fine_rotate:
            output_frames = sample_fine_rotated_crop_chunked(
                frames,
                fine_rotate,
                crop_x,
                crop_y,
                crop_w_dim,
                crop_h_dim,
                eff_w,
                eff_h,
                fill_rgb,
                flip_x,
                flip_y,
                chunk_size=_FINE_ROTATE_CHUNK,
            )
            source_mask = selected_mask if selected_mask is not None else torch.zeros((n_sel, src_h, src_w), device=frames.device, dtype=frames.dtype)
            transformed_mask = sample_fine_rotated_crop_mask_chunked(
                source_mask,
                fine_rotate,
                crop_x,
                crop_y,
                crop_w_dim,
                crop_h_dim,
                eff_w,
                eff_h,
                0.0,
                flip_x,
                flip_y,
                chunk_size=_FINE_ROTATE_CHUNK,
            )
            empty_mask = sample_fine_rotated_crop_mask_chunked(
                torch.zeros((n_sel, src_h, src_w), device=frames.device, dtype=frames.dtype),
                fine_rotate,
                crop_x,
                crop_y,
                crop_w_dim,
                crop_h_dim,
                eff_w,
                eff_h,
                1.0,
                flip_x,
                flip_y,
                chunk_size=_FINE_ROTATE_CHUNK,
            )
            output_mask = combine_masks(transformed_mask, empty_mask, mask_mode, mask_invert, mask_feather, mask_grow, mask_threshold)
            pad_t = max(0, -crop_y)
            pad_b = max(0, crop_y + crop_h_dim - src_h)
            pad_l = max(0, -crop_x)
            pad_r = max(0, crop_x + crop_w_dim - src_w)
            scale_info = f" -> output {eff_w}x{eff_h}" if (eff_w != crop_w_dim or eff_h != crop_h_dim) else ""
            chunk_info = f" | chunk={_FINE_ROTATE_CHUNK}" if n_sel > _FINE_ROTATE_CHUNK else ""
            print(
                f"[KRC Resizer] {src_w}x{src_h} -> rotated {fine_rotate}deg crop {crop_w_dim}x{crop_h_dim}{scale_info} | "
                f"pad L{pad_l} R{pad_r} T{pad_t} B{pad_b} | frames={n_sel}{sel_info}{chunk_info}"
            )
            return (output_frames, output_mask, output_audio)

        # Build output frames.
        #
        # The output window top-left is (crop_x, crop_y) in source pixel space.
        # A negative crop_x / crop_y means the window extends to the left / top
        # of the source, so those regions are filled with the selected pad color.
        #
        # For each output pixel (px, py), the corresponding source pixel is
        #   (crop_x + px, crop_y + py).
        # We copy the intersection and leave the rest filled.
        #
        # Memory-optimised path: when the crop box is much larger than the
        # requested output resolution (e.g. 4096×4096 crop → 1280×720 output),
        # we scale the source frames to the output resolution FIRST, then
        # compose at the small size.  This avoids allocating huge intermediate
        # buffers at the crop-box scale that would only be shrunk immediately
        # afterwards.

        if eff_w == crop_w_dim and eff_h == crop_h_dim:
            # No scaling — work directly at crop-box dimensions.
            # Top-left corner of the copied region in both spaces (same for all frames).
            dst_x = max(0, -crop_x)
            dst_y = max(0, -crop_y)
            src_x = max(0, crop_x)
            src_y = max(0, crop_y)
            copy_w = min(src_w - src_x, eff_w - dst_x)
            copy_h = min(src_h - src_y, eff_h - dst_y)

            output_frames_list = []
            input_masks_list = []
            empty_masks_list = []
            for i in range(n_sel):
                src_np = frames[i].cpu().numpy()       # (src_h, src_w, 3) float32
                out    = np.full((eff_h, eff_w, 3), fill_rgb, dtype=np.float32)
                input_mask_out = np.zeros((eff_h, eff_w), dtype=np.float32)
                empty_mask_out = np.ones((eff_h, eff_w), dtype=np.float32)
                if copy_w > 0 and copy_h > 0:
                    out[dst_y:dst_y + copy_h, dst_x:dst_x + copy_w] = \
                        src_np[src_y:src_y + copy_h, src_x:src_x + copy_w]
                    if selected_mask is not None:
                        mask_np = selected_mask[i].detach().cpu().numpy()
                        input_mask_out[dst_y:dst_y + copy_h, dst_x:dst_x + copy_w] = \
                            mask_np[src_y:src_y + copy_h, src_x:src_x + copy_w]
                    empty_mask_out[dst_y:dst_y + copy_h, dst_x:dst_x + copy_w] = 0.0
                output_frames_list.append(out)
                input_masks_list.append(input_mask_out)
                empty_masks_list.append(empty_mask_out)

            output_frames = torch.from_numpy(np.stack(output_frames_list))  # (N, eff_h, eff_w, 3)
            input_mask_out = torch.from_numpy(np.stack(input_masks_list))    # (N, eff_h, eff_w)
            empty_mask_out = torch.from_numpy(np.stack(empty_masks_list))    # (N, eff_h, eff_w)
            output_mask = combine_masks(input_mask_out, empty_mask_out, mask_mode, mask_invert, mask_feather, mask_grow, mask_threshold)
        else:
            # Scaling path — work entirely at the small output resolution.
            #
            # Strategy: crop the relevant source region first, then scale it
            # directly to the output dimensions.  This avoids allocating a
            # huge crop-box-sized intermediate buffer.
            #
            # The original (non-optimised) approach would:
            #   1. Allocate (crop_w_dim × crop_h_dim) canvas, paste source region
            #   2. F.interpolate from crop-box size to (eff_h × eff_w)
            #
            # Instead we:
            #   1. Crop source to (copy_h × copy_w)
            #   2. F.interpolate directly to (out_copy_h × out_copy_w)
            #   3. Paste into the (eff_h × eff_w) output canvas
            #
            # Crop-then-scale vs scale-then-crop differ by at most a few pixels
            # of bilinear sampling offset, which is visually negligible here.

            # Where the source content sits in the crop-box canvas.
            dst_x = max(0, -crop_x)         # crop-box coords
            dst_y = max(0, -crop_y)
            src_x = max(0, crop_x)          # source coords
            src_y = max(0, crop_y)
            copy_w = min(src_w - src_x, crop_w_dim - dst_x)
            copy_h = min(src_h - src_y, crop_h_dim - dst_y)

            # Destination of the content in the output canvas
            # (crop-box coords scaled to output coords).
            has_source_overlap = copy_w > 0 and copy_h > 0
            out_dst_x = round(dst_x * eff_w / crop_w_dim) if has_source_overlap else 0
            out_dst_y = round(dst_y * eff_h / crop_h_dim) if has_source_overlap else 0
            out_copy_w = max(1, round(copy_w * eff_w / crop_w_dim)) if has_source_overlap else 0
            out_copy_h = max(1, round(copy_h * eff_h / crop_h_dim)) if has_source_overlap else 0

            # Pre-allocate output tensor filled with the pad colour.
            output_frames = torch.full((n_sel, eff_h, eff_w, 3), 0.0, device=frames.device)
            output_frames[:, :, :, 0] = fill_rgb[0]
            output_frames[:, :, :, 1] = fill_rgb[1]
            output_frames[:, :, :, 2] = fill_rgb[2]
            input_mask_out = torch.zeros((n_sel, eff_h, eff_w), device=frames.device, dtype=frames.dtype)
            empty_mask_out = torch.ones((n_sel, eff_h, eff_w), device=frames.device, dtype=frames.dtype)

            for i in range(n_sel):
                if not has_source_overlap:
                    continue
                # Crop the relevant region from the source frame,
                # then scale it directly to the output sub-region size.
                region = F.interpolate(
                    frames[i: i + 1, src_y: src_y + copy_h,
                           src_x: src_x + copy_w, :].permute(0, 3, 1, 2),  # (1,3,copy_h,copy_w)
                    size=(out_copy_h, out_copy_w),
                    mode="bilinear", align_corners=False,
                ).permute(0, 2, 3, 1).squeeze(0)  # (out_copy_h, out_copy_w, 3)
                output_frames[i, out_dst_y: out_dst_y + out_copy_h,
                              out_dst_x: out_dst_x + out_copy_w] = region
                if selected_mask is not None:
                    mask_region = F.interpolate(
                        selected_mask[i: i + 1, src_y: src_y + copy_h,
                                      src_x: src_x + copy_w].unsqueeze(1),
                        size=(out_copy_h, out_copy_w),
                        mode="bilinear", align_corners=False,
                    ).squeeze(0).squeeze(0)
                else:
                    mask_region = torch.zeros((out_copy_h, out_copy_w), device=frames.device, dtype=frames.dtype)
                input_mask_out[i, out_dst_y: out_dst_y + out_copy_h,
                               out_dst_x: out_dst_x + out_copy_w] = mask_region
                empty_mask_out[i, out_dst_y: out_dst_y + out_copy_h,
                               out_dst_x: out_dst_x + out_copy_w] = 0.0
            output_mask = combine_masks(input_mask_out, empty_mask_out, mask_mode, mask_invert, mask_feather, mask_grow, mask_threshold)

        pad_t = max(0, -crop_y)
        pad_b = max(0, crop_y + crop_h_dim - src_h)
        pad_l = max(0, -crop_x)
        pad_r = max(0, crop_x + crop_w_dim - src_w)
        scale_info = f" -> output {eff_w}x{eff_h}" if (eff_w != crop_w_dim or eff_h != crop_h_dim) else ""
        print(
            f"[KRC Resizer] {src_w}x{src_h} -> crop {crop_w_dim}x{crop_h_dim}{scale_info} | "
            f"pad T={pad_t} B={pad_b} L={pad_l} R={pad_r} | frames={n_sel}{sel_info}"
        )

        return (output_frames, output_mask, output_audio)




# ── API routes ──────────────────────────────────────────────────────────
# Serve cached frame data to the JS widget. Under /krc/resizer/ since the node moved back
# into NodePack (2026-11-10): an older KRC NodePack Extras still registers /krc_resizer/,
# and two packs registering the same route would stop ComfyUI's server from starting.

@server.PromptServer.instance.routes.get("/krc/resizer/info")
async def resizer_info(request):
    """Return source dimensions, frame count, and the first frame as base64 JPEG."""
    node_id = request.query.get("node_id", "")
    if not node_id or node_id not in _frame_cache:
        return web.Response(status=204)
    _frame_cache.move_to_end(node_id)   # mark most-recently-used
    cache = _frame_cache[node_id]
    return web.json_response({
        "width":       cache["width"],
        "height":      cache["height"],
        "frame_count": cache["frame_count"],
        "media_sig":   cache["media_sig"],
        "frame":       base64.b64encode(cache["frames"][0]).decode(),
    })


@server.PromptServer.instance.routes.get("/krc/resizer/frame")
async def resizer_frame(request):
    """Return a single frame by index as a JPEG image."""
    node_id = request.query.get("node_id", "")
    try:
        idx = int(request.query.get("idx", "0"))
    except ValueError:
        idx = 0
    if not node_id or node_id not in _frame_cache:
        return web.Response(status=404, text="No cached frame data for this node.")
    _frame_cache.move_to_end(node_id)   # mark most-recently-used
    cache = _frame_cache[node_id]
    idx = max(0, min(idx, cache["frame_count"] - 1))
    return web.Response(body=cache["frames"][idx], content_type="image/jpeg")


NODE_CLASS_MAPPINGS = {
    "KRC Resizer": KRCResizer,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "KRC Resizer": "KRC Resizer",
}
