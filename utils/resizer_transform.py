import numpy as np
import torch
import torch.nn.functional as F


def apply_transform(frames, rotate, flip_x, flip_y):
    """Rotate (clockwise) then horizontally / vertically flip an (N, H, W, C) batch.

    rotate in {0, 90, 180, 270}; flips operate in the rotated frame. The JS canvas
    previews the identical transform via CSS so the output matches what's shown.
    Vectorised over the whole batch with no per-frame Python loop.
    """
    if rotate == 90:
        frames = torch.rot90(frames, k=-1, dims=(1, 2))
    elif rotate == 180:
        frames = torch.rot90(frames, k=2, dims=(1, 2))
    elif rotate == 270:
        frames = torch.rot90(frames, k=1, dims=(1, 2))
    if flip_x:
        frames = torch.flip(frames, dims=(2,))
    if flip_y:
        frames = torch.flip(frames, dims=(1,))
    return frames.contiguous()


def apply_transform_mask(mask, rotate, flip_x, flip_y):
    """Rotate (clockwise) then flip an (N, H, W) mask batch."""
    if rotate == 90:
        mask = torch.rot90(mask, k=-1, dims=(1, 2))
    elif rotate == 180:
        mask = torch.rot90(mask, k=2, dims=(1, 2))
    elif rotate == 270:
        mask = torch.rot90(mask, k=1, dims=(1, 2))
    if flip_x:
        mask = torch.flip(mask, dims=(2,))
    if flip_y:
        mask = torch.flip(mask, dims=(1,))
    return mask.contiguous()


def apply_fine_rotation(frames, angle_degrees, fill_rgb):
    """Rotate an (N, H, W, C) batch clockwise around frame center, preserving size."""
    angle = float(angle_degrees)
    if abs(angle) < 0.5:
        return frames
    n, h, w, c = frames.shape
    device = frames.device
    dtype = frames.dtype
    theta = torch.tensor(np.deg2rad(angle), device=device, dtype=dtype)
    cos_t = torch.cos(theta)
    sin_t = torch.sin(theta)
    ys = torch.linspace(-1.0, 1.0, h, device=device, dtype=dtype)
    xs = torch.linspace(-1.0, 1.0, w, device=device, dtype=dtype)
    try:
        yy, xx = torch.meshgrid(ys, xs, indexing="ij")
    except TypeError:
        yy, xx = torch.meshgrid(ys, xs)
    y_to_x = h / max(w, 1)
    x_to_y = w / max(h, 1)
    grid_x = cos_t * xx + sin_t * y_to_x * yy
    grid_y = -sin_t * x_to_y * xx + cos_t * yy
    grid = torch.stack((grid_x, grid_y), dim=-1).unsqueeze(0).expand(n, h, w, 2)

    nchw = frames.permute(0, 3, 1, 2)
    fill = torch.tensor(fill_rgb, device=device, dtype=dtype).view(1, c, 1, 1)
    sampled = F.grid_sample(
        nchw - fill,
        grid,
        mode="bilinear",
        padding_mode="zeros",
        align_corners=True,
    ) + fill
    return sampled.permute(0, 2, 3, 1).clamp(0.0, 1.0).contiguous()


def apply_fine_rotation_chunked(frames, angle_degrees, fill_rgb, chunk_size):
    """Rotate a batch in bounded chunks to avoid one large sampling grid."""
    if frames.shape[0] <= chunk_size:
        return apply_fine_rotation(frames, angle_degrees, fill_rgb)
    return torch.cat([
        apply_fine_rotation(frames[i:i + chunk_size], angle_degrees, fill_rgb)
        for i in range(0, frames.shape[0], chunk_size)
    ], dim=0)


def apply_fine_rotation_mask(mask, angle_degrees, fill_value=0.0):
    """Rotate an (N, H, W) mask batch clockwise around frame center, preserving size."""
    angle = float(angle_degrees)
    if abs(angle) < 0.5:
        return mask
    return apply_fine_rotation(mask.unsqueeze(-1), angle, (fill_value,)).squeeze(-1)


def apply_fine_rotation_mask_chunked(mask, angle_degrees, fill_value, chunk_size):
    """Rotate a mask batch in bounded chunks to avoid one large sampling grid."""
    if mask.shape[0] <= chunk_size:
        return apply_fine_rotation_mask(mask, angle_degrees, fill_value)
    return torch.cat([
        apply_fine_rotation_mask(mask[i:i + chunk_size], angle_degrees, fill_value)
        for i in range(0, mask.shape[0], chunk_size)
    ], dim=0)


def sample_fine_rotated_crop(frames, angle_degrees, crop_x, crop_y, crop_w, crop_h, out_w, out_h, fill_rgb, flip_x=False, flip_y=False):
    """Sample a rotated crop directly from source frames, allowing crop bounds outside the frame."""
    angle = float(angle_degrees)
    n, h, w, c = frames.shape
    device = frames.device
    dtype = frames.dtype
    if out_w <= 0 or out_h <= 0:
        return frames

    if out_w == 1:
        xs = torch.tensor([crop_x + (crop_w - 1) / 2], device=device, dtype=dtype)
    else:
        xs = torch.linspace(crop_x, crop_x + crop_w - 1, out_w, device=device, dtype=dtype)
    if out_h == 1:
        ys = torch.tensor([crop_y + (crop_h - 1) / 2], device=device, dtype=dtype)
    else:
        ys = torch.linspace(crop_y, crop_y + crop_h - 1, out_h, device=device, dtype=dtype)
    try:
        yy, xx = torch.meshgrid(ys, xs, indexing="ij")
    except TypeError:
        yy, xx = torch.meshgrid(ys, xs)

    cx = torch.tensor((w - 1) / 2, device=device, dtype=dtype)
    cy = torch.tensor((h - 1) / 2, device=device, dtype=dtype)
    dx = xx - cx
    dy = yy - cy
    if flip_x:
        dx = -dx
    if flip_y:
        dy = -dy

    theta = torch.tensor(np.deg2rad(angle), device=device, dtype=dtype)
    cos_t = torch.cos(theta)
    sin_t = torch.sin(theta)
    sample_x = cx + cos_t * dx + sin_t * dy
    sample_y = cy - sin_t * dx + cos_t * dy

    grid_x = sample_x * (2.0 / max(w - 1, 1)) - 1.0
    grid_y = sample_y * (2.0 / max(h - 1, 1)) - 1.0
    grid = torch.stack((grid_x, grid_y), dim=-1).unsqueeze(0).expand(n, out_h, out_w, 2)

    nchw = frames.permute(0, 3, 1, 2)
    fill = torch.tensor(fill_rgb, device=device, dtype=dtype).view(1, c, 1, 1)
    sampled = F.grid_sample(
        nchw - fill,
        grid,
        mode="bilinear",
        padding_mode="zeros",
        align_corners=True,
    ) + fill
    return sampled.permute(0, 2, 3, 1).clamp(0.0, 1.0).contiguous()


def sample_fine_rotated_crop_chunked(frames, angle_degrees, crop_x, crop_y, crop_w, crop_h, out_w, out_h, fill_rgb, flip_x=False, flip_y=False, *, chunk_size):
    """Sample a rotated crop in bounded chunks for video/batch workflows."""
    if frames.shape[0] <= chunk_size:
        return sample_fine_rotated_crop(
            frames,
            angle_degrees,
            crop_x,
            crop_y,
            crop_w,
            crop_h,
            out_w,
            out_h,
            fill_rgb,
            flip_x,
            flip_y,
        )
    return torch.cat([
        sample_fine_rotated_crop(
            frames[i:i + chunk_size],
            angle_degrees,
            crop_x,
            crop_y,
            crop_w,
            crop_h,
            out_w,
            out_h,
            fill_rgb,
            flip_x,
            flip_y,
        )
        for i in range(0, frames.shape[0], chunk_size)
    ], dim=0)


def sample_fine_rotated_crop_mask(mask, angle_degrees, crop_x, crop_y, crop_w, crop_h, out_w, out_h, fill_value=0.0, flip_x=False, flip_y=False):
    """Sample a rotated mask crop directly from source masks."""
    return sample_fine_rotated_crop(
        mask.unsqueeze(-1),
        angle_degrees,
        crop_x,
        crop_y,
        crop_w,
        crop_h,
        out_w,
        out_h,
        (fill_value,),
        flip_x,
        flip_y,
    ).squeeze(-1)


def sample_fine_rotated_crop_mask_chunked(mask, angle_degrees, crop_x, crop_y, crop_w, crop_h, out_w, out_h, fill_value, flip_x=False, flip_y=False, *, chunk_size):
    """Sample a rotated mask crop in bounded chunks for video/batch workflows."""
    if mask.shape[0] <= chunk_size:
        return sample_fine_rotated_crop_mask(
            mask,
            angle_degrees,
            crop_x,
            crop_y,
            crop_w,
            crop_h,
            out_w,
            out_h,
            fill_value,
            flip_x,
            flip_y,
        )
    return torch.cat([
        sample_fine_rotated_crop_mask(
            mask[i:i + chunk_size],
            angle_degrees,
            crop_x,
            crop_y,
            crop_w,
            crop_h,
            out_w,
            out_h,
            fill_value,
            flip_x,
            flip_y,
        )
        for i in range(0, mask.shape[0], chunk_size)
    ], dim=0)
