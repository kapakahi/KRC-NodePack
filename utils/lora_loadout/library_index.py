import json
from pathlib import Path

from ..library.library_index import (
    BaseLibraryIndex,
    is_under_output,
    resolve_output_dir,
    roots_for_folder_key,
)
from .identity import IdentityStore, file_signature, is_local_library_id
from .thumbnails import find_thumbnail, save_thumbnail_image, thumbnail_kind


SUPPORTED_EXTENSIONS = {".safetensors"}


def get_lora_roots():
    try:
        import folder_paths
    except ImportError:
        return []

    # Skip LoRA roots living under ComfyUI's output directory (e.g. the
    # auto-registered output/loras). That folder holds node-produced artifacts,
    # not the user's library, so LS should never scan it.
    output_dir = resolve_output_dir()
    deduped = []
    seen = set()
    for root in roots_for_folder_key(folder_paths, "loras"):
        if is_under_output(root, output_dir):
            continue
        key = str(root)
        if key not in seen:
            deduped.append(root)
            seen.add(key)
    return deduped


def build_library_scan_status(roots, records, errors):
    return {
        "roots": [{"path": str(root), "exists": root.exists()} for root in roots],
        "lora_count": len(records),
        "errors": errors,
    }


def get_poster_needed_report_path(extension=".txt"):
    from .metadata import get_krc_base_dir

    return get_krc_base_dir() / f"poster_needed_loras{extension}"


class LoraLibraryIndex(BaseLibraryIndex):
    _cache = {}
    LINEAGE = "loras"
    SUPPORTED_EXTENSIONS = SUPPORTED_EXTENSIONS

    def __init__(self, roots=None):
        super().__init__([Path(root) for root in roots] if roots else get_lora_roots())

    def _cache_key(self):
        return tuple(str(root) for root in self.roots)

    def _iter_roots(self):
        for root in self.roots:
            yield root, None

    def _identity_store(self):
        return IdentityStore()

    def _on_missing_root(self, root, errors):
        errors.append(f"LoRA root does not exist: {root}")

    def _post_scan(self, records):
        write_poster_needed_report(records)

    def scan_file(self, path, root, root_meta, scan_state):
        from .metadata import make_library_id, read_lora_metadata

        identities = scan_state
        fallback_id = make_library_id(path, root)
        signature = file_signature(path, root)
        library_id = identities.resolve(fallback_id, signature, root=root)
        metadata = read_lora_metadata(path, library_id)
        if not is_local_library_id(library_id):
            identities.remember_file(library_id, fallback_id, signature, sha256=metadata.get("sha256") or library_id)
        else:
            # Path-derived id: record its current path + fingerprint so a future
            # move can be recovered (and re-homed) instead of orphaning the
            # metadata. Stays local/promotable.
            identities.remember_path(library_id, signature)
        return library_id, self._record_from_metadata(path, root, metadata, library_id)

    def status(self):
        return build_library_scan_status(self.roots, self.records, self.errors)

    def save_thumbnail_from_comfy_image(self, library_id, image):
        record = self.get(library_id)
        if not record:
            return None

        try:
            import numpy
        except ImportError:
            return None

        tensor = image[0] if hasattr(image, "__getitem__") else image
        array = numpy.clip(255.0 * tensor.cpu().numpy(), 0, 255).astype(numpy.uint8)
        try:
            from PIL import Image
        except ImportError:
            return None
        return save_thumbnail_image(record, Image.fromarray(array))

    def _record_from_metadata(self, path, root, metadata, library_id):
        relpath = path.relative_to(root) if root in path.parents or path == root else path.name
        folder = str(Path(relpath).parent) if Path(relpath).parent != Path(".") else ""
        metadata = dict(metadata)
        try:
            file_modified = int(path.stat().st_mtime * 1000)
        except OSError:
            file_modified = 0
        thumb = find_thumbnail(path, library_id, prefer_animated=True)
        return {
            "library_id": library_id,
            "sha256": metadata.get("sha256", ""),
            "path": str(path),
            "relative_path": str(relpath),
            "folder": folder,
            "filename": path.name,
            "display_name": metadata.get("name") or path.stem,
            "date_added": int(metadata.get("krcFirstSeen") or metadata.get("modified") or file_modified),
            "date_modified": int(metadata.get("modified") or file_modified),
            "thumbnail": str(thumb) if thumb else "",
            "thumbnail_type": thumbnail_kind(thumb) if thumb else "image",
            "sidecar_data": metadata,
        }


def write_poster_needed_report(records):
    rows = []
    for record in records.values():
        metadata = record.get("sidecar_data") if isinstance(record.get("sidecar_data"), dict) else {}
        if not metadata.get("thumbnailNeedsPoster") or record.get("thumbnail"):
            continue
        rows.append(
            {
                "lora_path": record.get("path", ""),
                "preview_path": metadata.get("thumbnailSourcePath", ""),
                "name": metadata.get("name") or record.get("display_name") or record.get("filename", ""),
                "library_id": record.get("library_id", ""),
            }
        )

    rows.sort(key=lambda item: item["lora_path"].lower())
    txt_path = get_poster_needed_report_path(".txt")
    json_path = get_poster_needed_report_path(".json")
    txt_path.parent.mkdir(parents=True, exist_ok=True)

    with txt_path.open("w", encoding="utf-8") as handle:
        for row in rows:
            if row["lora_path"]:
                handle.write(f"{row['lora_path']}\n")

    with json_path.open("w", encoding="utf-8") as handle:
        json.dump(rows, handle, indent=2, ensure_ascii=False)
        handle.write("\n")

    return txt_path
