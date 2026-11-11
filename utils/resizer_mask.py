import torch
import torch.nn.functional as F


def normalize_mask(mask, n, src_h, src_w, device, dtype):
    """Return mask as (M, H, W) float tensor aligned to the raw image size."""
    if mask is None:
        return None
    if mask.ndim == 2:
        mask = mask.unsqueeze(0)
    elif mask.ndim == 4:
        if mask.shape[-1] == 1:
            mask = mask[..., 0]
        elif mask.shape[1] == 1:
            mask = mask[:, 0, :, :]
        else:
            raise ValueError(f"[KRC Resizer] mask must be MASK-shaped (N,H,W), got {tuple(mask.shape)}")
    if mask.ndim != 3:
        raise ValueError(f"[KRC Resizer] mask must be MASK-shaped (N,H,W), got {tuple(mask.shape)}")
    if mask.shape[0] not in (1, n):
        raise ValueError(
            f"[KRC Resizer] mask frame count ({mask.shape[0]}) must be 1 or match image frame count ({n})."
        )
    mask = mask.to(device=device, dtype=dtype).clamp(0.0, 1.0).contiguous()
    if mask.shape[1] != src_h or mask.shape[2] != src_w:
        print(
            f"[KRC Resizer] resizing mask {mask.shape[2]}x{mask.shape[1]} "
            f"to match image {src_w}x{src_h}"
        )
        mask = F.interpolate(
            mask.unsqueeze(1),
            size=(src_h, src_w),
            mode="bilinear",
            align_corners=False,
        ).squeeze(1).clamp(0.0, 1.0).contiguous()
    return mask


def select_mask_frames(mask, f_in, f_out, n_sel):
    if mask is None:
        return None
    if mask.shape[0] == 1:
        return mask.expand(n_sel, -1, -1).contiguous()
    return mask[f_in:f_out + 1]


def grow_mask(mask, amount):
    amount = int(amount)
    if amount == 0:
        return mask
    radius = abs(amount)
    kernel = radius * 2 + 1
    src = mask.unsqueeze(1)
    if amount > 0:
        grown = F.max_pool2d(src, kernel_size=kernel, stride=1, padding=radius)
    else:
        grown = 1.0 - F.max_pool2d(1.0 - src, kernel_size=kernel, stride=1, padding=radius)
    return grown.squeeze(1).clamp(0.0, 1.0)


def feather_mask(mask, radius):
    radius = int(radius)
    if radius <= 0:
        return mask
    kernel = radius * 2 + 1
    blurred = F.avg_pool2d(mask.unsqueeze(1), kernel_size=kernel, stride=1, padding=radius)
    return blurred.squeeze(1).clamp(0.0, 1.0)


def mask_ui_to_radius(value, ui_max=99, radius_max=256):
    """Map compact UI values to pixels with finer control near zero."""
    value = int(value)
    if value == 0:
        return 0
    sign = -1 if value < 0 else 1
    t = min(abs(value), ui_max) / ui_max
    return sign * int(round((t * t) * radius_max))


def combine_masks(input_mask, empty_mask, mask_mode="both", invert=False, feather=0, grow=0, threshold=0.0):
    """Combine and post-process masks using ComfyUI mask polarity."""
    if mask_mode == "input":
        output_mask = input_mask
    elif mask_mode == "empty":
        output_mask = empty_mask
    else:
        output_mask = torch.maximum(input_mask, empty_mask)
    output_mask = grow_mask(output_mask, mask_ui_to_radius(grow))
    output_mask = feather_mask(output_mask, mask_ui_to_radius(feather))
    if threshold > 0:
        output_mask = (output_mask >= float(threshold)).to(dtype=output_mask.dtype)
    output_mask = output_mask.clamp(0.0, 1.0)
    return 1.0 - output_mask if invert else output_mask
