"""Generalized multi-root model scanner for the Model Library.

Uses the shared BaseLibraryIndex scan skeleton (roots, per-root-set cache, one
record per id, duplicate collapse) and supplies the model scan descriptor across
ComfyUI model folder keys and the broader model file extensions.

Deliberate Stage-3 scoping:
- The `loras` folder key is NOT scanned here. Model Library must never mint a generic
  record for a LoRA (schema doc S8); LoRA catalog visibility is read-through against
  LoRA Loadout metadata, a separate mechanism added later.
- Scanning builds normalized records IN MEMORY and does not store them. Passively
  browsing must not write a record per model; persistence happens on edit/save.
- No identity/move recovery yet: ids are path-derived (local-...). Manual stabilization
  is the default (schema doc S6); a Model-Library-owned identity store comes later.
"""

from pathlib import Path

from ..library.library_index import (
    BaseLibraryIndex,
    is_under_output,
    resolve_output_dir,
    roots_for_folder_key,
)
from .identity import IdentityStore, file_signature, is_local_library_id
from .metadata import (
    default_model_metadata,
    make_model_library_id,
    normalize_model_metadata,
    read_model_metadata,
)
from ..library.thumbnails import thumbnail_version
from .thumbnails import find_model_animated_thumbnail, find_model_thumbnail


SUPPORTED_EXTENSIONS = {".safetensors", ".ckpt", ".pt", ".pth", ".bin", ".gguf"}

# Structural excludes for the universal scan (matched case-insensitively on the folder
# name): `loras` is read-through-only (a LoRA is owned by LoRA Loadout — the one-id-space
# invariant), `diffusers` is directory-based multi-file models the single-file scanner
# can't represent, `configs`/`transformers` are aux/config data, not managed models, and
# `custom_nodes` (a ComfyUI folder key) holds packs whose bundled weights aren't library
# models.
MODEL_FOLDER_DENYLIST = {"loras", "diffusers", "configs", "transformers", "custom_nodes"}

# Roots skipped (and logged) once per path per process.
_SKIPPED_ROOTS_LOGGED = set()


def _container_anchors(folder_paths):
    """ComfyUI's models/ dir and base folder, resolved. A registered folder key whose root
    IS one of these, or contains one, would claim every model under it as one type named
    after that folder (e.g. "models") and empty the real type folders, so it's never a
    root (a custom node or an extra_model_paths entry registering e.g. models/ itself)."""
    anchors = set()
    for value in (getattr(folder_paths, "models_dir", None), getattr(folder_paths, "base_path", None)):
        if not value:
            continue
        try:
            anchors.add(Path(value).resolve())
        except OSError:
            anchors.add(Path(value))
    return anchors


def get_model_roots():
    """Return [(root_path, model_type)] for every model folder we scan, universally.

    The model type IS the folder's own name. Two sources, deduped by resolved path:
    every registered ComfyUI folder-key root (so `extra_model_paths` external roots are
    covered) plus every immediate subdirectory of `models/` (so custom, unregistered
    folders appear without a curated list). Structural denylist folders, anything under
    the output dir, and a root that is or contains models/ or ComfyUI's base folder are
    skipped; non-existent roots are ignored."""
    try:
        import folder_paths
    except ImportError:
        return []

    output_dir = resolve_output_dir()
    anchors = _container_anchors(folder_paths)
    result = []
    seen = set()

    def _add(root):
        root = Path(root)
        if not root.is_dir() or is_under_output(root, output_dir):
            return
        if root.name.lower() in MODEL_FOLDER_DENYLIST:
            return
        try:
            marker = str(root.resolve())
        except OSError:
            marker = str(root)
        if any(anchor == Path(marker) or anchor.is_relative_to(marker) for anchor in anchors):
            if marker not in _SKIPPED_ROOTS_LOGGED:
                _SKIPPED_ROOTS_LOGGED.add(marker)
                safe = marker.encode("ascii", "replace").decode("ascii")
                print(f"[KRC Library] Skipped model root {safe}: it is (or contains) ComfyUI's models folder; "
                      "a custom node or extra_model_paths entry registered it as a model folder")
            return
        if marker in seen:
            return
        seen.add(marker)
        result.append((root, root.name))

    # 1. Registered folder-key roots — the source that knows extra_model_paths externals.
    names_and_paths = getattr(folder_paths, "folder_names_and_paths", {}) or {}
    for key in list(names_and_paths.keys()):
        for root in roots_for_folder_key(folder_paths, key):
            _add(root)

    # 2. Every immediate subdirectory of models/ — custom folders never registered as keys.
    models_dir = getattr(folder_paths, "models_dir", None)
    if models_dir:
        models_dir = Path(models_dir)
        if models_dir.is_dir():
            try:
                for child in sorted(models_dir.iterdir()):
                    _add(child)
            except OSError:
                pass

    return result


def build_model_scan_status(roots, records, errors):
    return {
        "roots": [{"path": str(root), "modelType": mt, "exists": Path(root).exists()} for root, mt in roots],
        "model_count": len(records),
        "errors": errors,
    }


class ModelLibraryIndex(BaseLibraryIndex):
    _cache = {}
    LINEAGE = "models"
    SUPPORTED_EXTENSIONS = SUPPORTED_EXTENSIONS

    def __init__(self, roots=None):
        # roots may be a list of (path, model_type) pairs or bare paths (model_type
        # then defaults to "other"). Bare-path form is mainly for tests.
        if roots is None:
            roots = get_model_roots()
        else:
            roots = [r if isinstance(r, tuple) else (Path(r), "other") for r in roots]
        super().__init__(roots)

    def _cache_key(self):
        return tuple((str(root), mt) for root, mt in self.roots)

    def _iter_roots(self):
        for root, model_type in self.roots:
            yield root, model_type

    def _identity_store(self):
        return IdentityStore()

    def scan_file(self, path, root, root_meta, scan_state):
        model_type = root_meta
        fallback_id = make_model_library_id(path, root)
        signature = file_signature(path, root)
        identities = scan_state   # one batched IdentityStore for the whole walk
        library_id = identities.resolve(fallback_id, signature, root=root)
        if is_local_library_id(library_id):
            identities.remember_path(library_id, signature)
        else:
            # A stabilized model records where it is now (and aliases this path's local
            # id), exactly like LoRA Loadout. Without it a move or rename was found once,
            # but rename recovery drops the old entry, so the next move or rename had
            # nothing left to match and the model fell back to a local id.
            identities.remember_file(library_id, fallback_id, signature, sha256=library_id)
        return library_id, self._record_from_scan(path, root, model_type, library_id)

    def status(self):
        return build_model_scan_status(self.roots, self.records, self.errors)

    def _record_from_scan(self, path, root, model_type, library_id):
        relpath = path.relative_to(root) if root in path.parents or path == root else Path(path.name)
        folder = str(relpath.parent) if relpath.parent != Path(".") else ""
        try:
            file_modified = int(path.stat().st_mtime * 1000)
        except OSError:
            file_modified = 0

        # Read an existing sidecar if the user has edited this model before; otherwise a
        # fresh in-memory default (NOT persisted here). Either way normalize on read.
        existing = read_model_metadata(library_id, model_type)
        if existing:
            meta = normalize_model_metadata(path, library_id, existing)
        else:
            meta = default_model_metadata(path, library_id)
            meta["modelType"] = model_type
            meta["format"] = path.suffix.lower().lstrip(".")
            meta = normalize_model_metadata(path, library_id, meta)
        # The scanned folder IS the model type. Force it (even over an existing sidecar
        # written under the legacy semantic value, e.g. "checkpoint") so every record in a
        # folder groups under the one folder-name type; it persists on the next write. The
        # storage dir is unchanged — legacy value and folder name map to the same dir.
        meta["modelType"] = model_type

        # Thumbnail is served through the API by library_id; expose a prefix-relative
        # sub-path (the frontend wraps it with the model-library API base) plus an mtime
        # cache-buster so a re-upload refreshes without a full-page reload.
        # The static webp poster drives the base thumbnail URL (a plain <img> must
        # never get the webm). An animated webm alongside it flips thumbnail_type to
        # "video" so the card/InfoPanel request the poster/animated variants and enable
        # the hover loop. "which variant exists" is file-derived, like LoRA Loadout.
        animated = find_model_animated_thumbnail(library_id, model_type)
        thumb = find_model_thumbnail(library_id, model_type)
        # Per-item image cache version (newest thumbnail file mtime), the browser's ?v=.
        version = thumbnail_version(thumb, animated)
        thumbnail = ""
        if thumb or animated:
            thumbnail = f"/thumbnail/{library_id}?v={version}" if version else f"/thumbnail/{library_id}"

        return {
            "library_id": library_id,
            "sha256": meta.get("sha256", ""),
            "modelType": meta.get("modelType") or model_type,
            "path": str(path),
            "relative_path": str(relpath),
            "folder": folder,
            "filename": path.name,
            "display_name": meta.get("name") or path.stem,
            "date_added": int(meta.get("krcFirstSeen") or meta.get("modified") or file_modified),
            "date_modified": int(meta.get("modified") or file_modified),
            "thumbnail": thumbnail,
            "thumbnail_type": "video" if animated else "image",
            "thumbnail_version": version,
            "sidecar_data": meta,
        }
