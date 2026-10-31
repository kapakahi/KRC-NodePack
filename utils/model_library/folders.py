import time

from ..db import presets as folder_db
from .metadata import get_krc_model_base_dir
# Valid card-color ids come from the one shared source (parsed from card_colors.js).
from ..library.card_colors import CARD_COLOR_IDS

FOLDER_META_FILENAME = "model_library_folder_meta.json"  # pre-database file (stage-3 import)
FOLDER_LINEAGE = "models"  # krc.db folder_colors lineage

# First-run seeded defaults (returned until the folder meta is first saved): a couple of core
# type folders pinned + colored so the library opens with a sensible shape. Keyed by the
# folder-name type row ids (universal auto-detect). `lora` is the read-through type, still
# keyed by the LoRA Loadout modelType "lora".
DEFAULT_TYPE_FOLDERS = {
    "__type__:diffusion_models": "blue",
    "__type__:lora": "red",
    "__type__:text_encoders": "yellow",
    "__type__:vae": "green",
}
DEFAULT_PINNED_FOLDERS = list(DEFAULT_TYPE_FOLDERS.keys())


def legacy_folder_meta_path():
    return get_krc_model_base_dir() / FOLDER_META_FILENAME


class ModelLibraryFolderStore:
    """Model Library folder colours and pins, in krc.db (folder_colors, lineage "models")."""

    def load(self):
        if not folder_db.folder_colors_saved(FOLDER_LINEAGE):
            return {"folders": dict(DEFAULT_TYPE_FOLDERS), "pinned": list(DEFAULT_PINNED_FOLDERS), "modified": 0}
        return self.clean(folder_db.load_folder_colors(FOLDER_LINEAGE))

    def clean(self, data):
        """A folder-meta payload with only known colours and string pins."""
        raw_folders = data.get("folders") if isinstance(data, dict) else {}
        folders = {}
        if isinstance(raw_folders, dict):
            for folder_id, color_id in raw_folders.items():
                color_id = self._normalize_color(color_id)
                if color_id:
                    folders[str(folder_id)] = color_id
        raw_pinned = data.get("pinned") if isinstance(data, dict) else []
        pinned = [str(folder_id) for folder_id in raw_pinned if folder_id] if isinstance(raw_pinned, list) else []
        return {
            "folders": folders,
            "pinned": pinned,
            "modified": int(data.get("modified") or 0) if isinstance(data, dict) else 0,
        }

    def save_folder(self, folder_id, color_id):
        data = self.load()
        folder_id = str(folder_id or "").strip()
        folders = data["folders"]
        color_id = self._normalize_color(color_id)
        if folder_id and color_id:
            folders[folder_id] = color_id
        elif folder_id:
            folders.pop(folder_id, None)
        return self._write({"folders": folders, "pinned": data["pinned"], "modified": int(time.time())})

    def save_pin(self, folder_id, pinned):
        data = self.load()
        folder_id = str(folder_id or "").strip()
        pins = [item for item in data["pinned"] if item != folder_id]
        if pinned and folder_id and folder_id not in ("__model_home__", "__root__"):
            pins.append(folder_id)
        return self._write({"folders": data["folders"], "pinned": pins, "modified": int(time.time())})

    def _write(self, payload):
        return folder_db.save_folder_colors(FOLDER_LINEAGE, payload)

    def _normalize_color(self, color_id):
        color_id = str(color_id or "").strip().lower()
        return color_id if color_id in CARD_COLOR_IDS else ""
