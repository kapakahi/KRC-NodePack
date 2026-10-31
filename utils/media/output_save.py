"""Media Output saves the finished product into the Media library: native resolution, atomic
publication, private thumbnails only. Stills are written here (PNG or lossless WebP, one file
per image). KRC never encodes video: a VIDEO is written by its own ``save_to`` (ComfyUI core,
as Save Video does; a file-backed video is remuxed, not re-encoded), then probed and given a
WebP card thumbnail."""
import json
import os
import re
from pathlib import Path, PurePosixPath
import shutil
import tempfile

from PIL import Image, PngImagePlugin, features
from . import media_store as store, media_paths
from .process_image import THUMB_MAX, THUMB_QUALITY
from .process_video import ffmpeg, probe, thumbnail

FORMATS = {"png": ".png", "webp": ".webp"}


def capabilities():
    return {"png": True, "webp": features.check("webp")}


def settings(value, filename=None):
    try:
        data = json.loads(value) if isinstance(value, str) else value
    except ValueError as err:
        raise ValueError("Invalid Media Output settings.") from err
    if not isinstance(data, dict):
        raise ValueError("Invalid Media Output settings.")
    fmt = data.get("format", "png")
    if fmt not in FORMATS:
        raise ValueError("Unknown Media Output image format.")
    if "saveMetadata" in data and not isinstance(data["saveMetadata"], bool):
        raise ValueError("saveMetadata must be true or false.")
    if "native" in data and not isinstance(data["native"], bool):
        raise ValueError("native must be true or false.")
    prefix = filename if filename is not None else data.get("prefix", "ComfyUI_output")
    if not isinstance(prefix, str) or not prefix.strip() or "\x00" in prefix or "\\" in prefix:
        raise ValueError("Enter a relative filename/prefix.")
    parts = PurePosixPath(prefix)
    if not parts.parts or parts.is_absolute() or ".." in parts.parts or ":" in parts.parts[0]:
        raise ValueError("The filename/prefix must stay inside the selected output folder.")
    # The node's key tags its records, so the node finds its outputs in Media even when the
    # run's "executed" message never reached it (its workflow tab was closed).
    key = data.get("key") if isinstance(data.get("key"), str) and re.fullmatch(r"[0-9a-f]{32}", data.get("key")) else ""
    folder = data.get("folder") if isinstance(data.get("folder"), str) else ""
    # "" is Default; "output" was the old placeholder for it.
    folder = "" if folder == "output" else folder
    return {"folder": folder, "prefix": prefix, "format": fmt,
            "metadata": data.get("saveMetadata", True), "key": key, "native": data.get("native", True)}


DEFAULT_FOLDER = {"id": "", "name": "Default"}


def output_folder(folder_id):
    """The folder a run saves into. Saving always works: no folder chosen, or one deleted
    since, saves to Default (DEFAULT_OUTPUT_DIRECTORY, the Output view's Unsorted)."""
    if not folder_id:
        return DEFAULT_FOLDER
    found = next((folder for folder in store.folders() if folder["id"] == folder_id and folder.get("storage") == "output"), None)
    if not found:
        print("[KRC Media] Output: the chosen output folder no longer exists; saving to Default.")
        return DEFAULT_FOLDER
    return found


def _interrupt():
    from comfy.model_management import throw_exception_if_processing_interrupted
    throw_exception_if_processing_interrupted()


def _array(value):
    return value.detach().cpu().numpy() if hasattr(value, "detach") else value


def _frame(images, index):
    import numpy as np
    data = np.asarray(_array(images[index]))
    if data.ndim != 3 or data.shape[2] not in (1, 3, 4) or min(data.shape[:2]) < 1 or not np.isfinite(data).all():
        raise ValueError("Images must contain finite H×W×1/3/4 frames.")
    data = (np.clip(data, 0, 1) * 255).round().astype(np.uint8)
    return Image.fromarray(data[:, :, 0] if data.shape[2] == 1 else data).convert("RGBA" if data.shape[2] == 4 else "RGB")


def _video_extension(video):
    """The saved video's extension, which picks core's container: a WebM / Matroska source
    stays WebM (its streams are kept when WebM can hold them), everything else is MP4 (core's
    default; a video built from frames has no container yet)."""
    try:
        name = video.get_container_format() if hasattr(video, "get_container_format") else ""
    except Exception:  # noqa: BLE001 - an unreadable source: let save_to decide on MP4
        name = ""
    parts = {part.strip().lower() for part in str(name or "").split(",")}
    return ".webm" if parts & {"webm", "matroska"} else ".mp4"


def _save_video(video, scratch, metadata):
    """Write ``video`` into scratch with core's save; -> (path, probed facts)."""
    if not hasattr(video, "save_to"):
        raise ValueError("The video input isn't a ComfyUI VIDEO.")
    temp = scratch / ("output" + _video_extension(video))
    try:
        video.save_to(str(temp), metadata=metadata or None)
    except Exception as err:  # noqa: BLE001 - core / PyAV errors become one clear message
        raise ValueError(f"Couldn't save the video: {err}") from err
    if not temp.is_file() or not temp.stat().st_size:
        raise ValueError("Couldn't save the video: nothing was written.")
    return temp, probe(temp)


def _publish(temp, folder, prefix, width, height, batch, storage_root):
    import folder_paths
    if str(media_paths.configured_root("output")) != storage_root:
        raise ValueError("ComfyUI output storage changed while saving. Retry the output.")
    # Let ComfyUI expand dimension/date tokens and choose the initial counter.
    _, base = store.output_destination(folder["id"], "placeholder")
    directory = base.parent
    directory.mkdir(parents=True, exist_ok=True)
    # Expand using ComfyUI inside private scratch first: the helper can mkdir.
    # Validate the expanded target before allowing that side effect in output storage.
    _, _, _, _, expanded = folder_paths.get_save_image_path(prefix, str(temp.parent / "naming"), width, height)
    _, checked = store.output_destination(folder["id"], expanded, subfolders=True)
    checked.relative_to(directory.resolve())
    full, filename, counter, _, _ = folder_paths.get_save_image_path(expanded, str(directory), width, height)
    relative_dir = Path(full).resolve().relative_to(directory.resolve())
    stem = filename.replace("%batch_num%", str(batch))
    if not stem or Path(stem).name != stem or "\\" in stem:
        raise ValueError("Invalid expanded output filename.")
    # Stage only the finished file on the destination filesystem; scratch stays private. A hard link publishes the completed file without overwrites.
    with tempfile.TemporaryDirectory(prefix=".krc-save-", dir=full, ignore_cleanup_errors=True) as work:
        staged = Path(work) / temp.name
        with temp.open("rb") as source, staged.open("xb") as target:
            while chunk := source.read(1024 * 1024):
                _interrupt()
                target.write(chunk)
        while True:
            _interrupt()
            if str(media_paths.configured_root("output")) != storage_root:
                raise ValueError("ComfyUI output storage changed while saving. Retry the output.")
            relative_name = (relative_dir / f"{stem}_{counter:05}_{temp.suffix}").as_posix()
            relative, dest = store.output_destination(folder["id"], relative_name, subfolders=True)
            dest.parent.mkdir(parents=True, exist_ok=True)
            try:
                os.link(staged, dest)
                return relative, dest
            except FileExistsError:
                counter += 1


def save_outputs(output_data, images=None, video=None, prompt=None, extra_pnginfo=None, filename=None):
    state = settings(output_data, filename=filename)
    has_images = images is not None and len(images) > 0
    if not has_images and video is None:
        raise ValueError("Connect images or a video to save.")
    if has_images and not capabilities()[state["format"]]:
        raise ValueError("This server's Pillow can't write WebP. Choose PNG.")
    _interrupt()
    folder = output_folder(state["folder"])
    # Resolve the destination first; all scratch stays in the private media.
    _, base = store.output_destination(folder["id"], "placeholder")
    base.parent.mkdir(parents=True, exist_ok=True)
    storage_root = str(media_paths.configured_root("output"))
    records, owned, thumbs, pending_thumbs = [], [], [], []
    committed = False
    try:
        from comfy.cli_args import args
        metadata = {**(extra_pnginfo or {}), **({"prompt": prompt} if prompt is not None else {})} if state["metadata"] and not args.disable_metadata else {}
        with tempfile.TemporaryDirectory(prefix="output-", dir=store.incoming_dir(), ignore_cleanup_errors=True) as work:
            scratch = Path(work)
            # One still per image in the batch.
            for index in range(len(images) if has_images else 0):
                _interrupt()
                item_id = store.new_id()
                temp = scratch / ("output" + FORMATS[state["format"]])
                with _frame(images, index) as frame:
                    width, height = frame.size
                    alpha = frame.mode == "RGBA"
                    if state["format"] == "png":
                        info = PngImagePlugin.PngInfo()
                        for key, value in metadata.items():
                            info.add_text(key, json.dumps(value))
                        frame.save(temp, "PNG", pnginfo=info)
                    else:
                        exif = Image.Exif()
                        if metadata:
                            exif[0x0110] = "prompt:" + json.dumps(metadata.get("prompt", {}))
                            exif[0x010F] = "workflow:" + json.dumps(metadata.get("workflow", {}))
                        frame.save(temp, "WEBP", lossless=True, exif=exif)
                    thumb = scratch / f"{item_id}.webp"
                    pending_thumbs.append((thumb, store.thumb_path(item_id)))
                    frame.thumbnail((THUMB_MAX, THUMB_MAX), Image.Resampling.LANCZOS)
                    frame.save(thumb, "WEBP", quality=THUMB_QUALITY, method=4)
                relative, dest = _publish(temp, folder, state["prefix"], width, height, index, storage_root)
                owned.append(dest)
                temp.unlink()
                records.append({"id": item_id, "kind": "image", "name": dest.stem,
                                "ext": dest.suffix, "storage": "output", "relative_path": relative,
                                "storage_root": storage_root, "folder": folder["id"],
                                "width": width, "height": height, "alpha": alpha, "bytes": dest.stat().st_size,
                                "frames": 1, "fps": 0, "duration": 0, "audio": False, "outputKey": state["key"]})
            if video is not None:
                _interrupt()
                item_id = store.new_id()
                temp, info = _save_video(video, scratch, metadata)
                _interrupt()
                thumb = scratch / f"{item_id}.webp"
                thumbnail(ffmpeg(require_vp9=False)[0], temp, thumb, min(1.0, (info["duration"] or 0) / 2))
                pending_thumbs.append((thumb, store.thumb_path(item_id)))
                relative, dest = _publish(temp, folder, state["prefix"], info["width"], info["height"],
                                          len(images) if has_images else 0, storage_root)
                owned.append(dest)
                temp.unlink()
                records.append({"id": item_id, "kind": "video", "name": dest.stem,
                                "ext": dest.suffix, "storage": "output", "relative_path": relative,
                                "storage_root": storage_root, "folder": folder["id"],
                                "width": info["width"], "height": info["height"], "alpha": info["alpha"],
                                "bytes": dest.stat().st_size, "frames": info["frames"], "fps": info["fps"],
                                "duration": info["duration"], "audio": info["audio"], "outputKey": state["key"]})
            _interrupt()
            with store.locked():
                for source, target in pending_thumbs:
                    target.parent.mkdir(parents=True, exist_ok=True)
                    thumbs.append(target)
                    shutil.copyfile(source, target)
                result = store.add_many(records)
                committed = True
                return result
    except BaseException:
        if not committed:
            for path in owned + thumbs:
                try:
                    path.unlink(missing_ok=True)
                except OSError as error:
                    print(f"[KRC Media] Could not clean unfinished output {path.name}: {error}")
        raise
