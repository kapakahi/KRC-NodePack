"""
KRC NodePack ConfigSwitcher — global preset store.

Reusable field/config-set presets, kept in krc.db (kind "cs" in the presets table) so
they survive across workflows. The old JSON file
(.../user/default/krc_nodes/config_switcher/config_switcher_presets.json) is read once by
the stage-2 import (utils/db/importers.py).

Record shape (id-primary, shared across all KRC preset stores):
    {"id": <hex>, "group": <group>, "name": <label>, "fields": [...], "configs": {...},
     "active_config": str, "default_config": str, "modified": int, "schema": "1.5"}
Identity is the stable ``id``; ``group`` + ``name`` are mutable display attributes (the
reserved token ``none`` = ungrouped). There is no stored trigger. The node persists its
selection as an id pointer (``configPresetId``). ``schema`` is the preset schema version
(utils/config_switcher_schema.py): a preset newer than this server is kept as stored.
"""

import time
import uuid

from .db import presets as preset_db
from .db import connection as db
from .krc_paths import get_krc_node_dir
from .config_switcher_schema import CS_SCHEMA_VERSION, is_newer, stored_newer_problem
from .config_switcher_dynamic import clean_dynamic_hidden, clean_dynamic_schema, dynamic_value_keys
from .library.card_colors import CARD_COLOR_IDS
from .preset_naming import canonical_group, canonical_label, delete_store_group, rename_store_group, ungroup_store_group

PRESETS_FILENAME = "config_switcher_presets.json"
# "combo" is the saved option picker (legacy token "string"); "string" is the new
# raw-text type. See _migrate_field_type.
FIELD_TYPES = {"combo", "string", "number", "boolean", "model", "prompt", "seed", "dynamic_combo", "note", "section"}
# A SECTION/DIVIDER's title (its name) is capped at this, as the page caps it
# (SECTION_TITLE_MAX in web/js/config_switcher/section_field.js): a save never reads Modified.
SECTION_TITLE_MAX = 60


def local_url(value):
    """A card thumbnail URL kept only when it's this server's own (root-relative: "/...").
    An imported preset or a shared workflow could otherwise make every page that shows the
    card fetch an outside address (a tracking pixel)."""
    text = str(value or "")
    return text if text.startswith("/") and not text.startswith(("//", "/\\")) else ""

# Seed fields (CS_SEED_FIELD_GAMEPLAN.md): each config keeps the seed's lock and mode next
# to its value, under "<field id>:seed" = "<mode>" or "<mode>:locked". The number itself is
# kept only while locked (an unlocked seed moves every run and is never saved).
SEED_STATE_SUFFIX = ":seed"
SEED_MODES = ("randomize", "increment", "decrement")
SEED_MAX = 2 ** 64 - 1


def parse_seed_state(raw):
    """"increment:locked" -> ("increment", True); anything unknown -> ("randomize", False)."""
    parts = str(raw or "").split(":")
    mode = parts[0] if parts[0] in SEED_MODES else "randomize"
    return mode, len(parts) > 1 and parts[1] == "locked"


def format_seed_state(mode, locked):
    return f"{mode if mode in SEED_MODES else 'randomize'}{':locked' if locked else ''}"


def clean_seed_value(raw):
    """The seed as digits, clamped to 0..2**64-1; "" for junk."""
    digits = "".join(ch for ch in str(raw or "") if ch.isdigit()).lstrip("0")
    if not str(raw or "").strip():
        return ""
    return str(min(int(digits or "0"), SEED_MAX))


def _migrate_field_type(raw_type, options):
    """Mirror of the frontend migrateFieldType: legacy option-picker fields
    serialized as "string" and are now "combo". A "string" WITH saved options is
    definitely a legacy Combo; a bare "string" (no options) is the new raw STRING
    type. A missing type is a Combo (the historical default); an unknown token -> None
    (the field is dropped, never rewritten as a Combo)."""
    if raw_type == "string":
        has_options = any(str(option).strip() for option in (options or []))
        return "combo" if has_options else "string"
    return raw_type if raw_type in FIELD_TYPES else None


NUMBER_OUTPUT_FORMATS = {"auto", "integer", "float"}


def legacy_presets_path():
    return get_krc_node_dir("config_switcher") / PRESETS_FILENAME


class ConfigSwitcherPresetStore:
    def load(self):
        return {"presets": self._clean(preset_db.load_records(preset_db.CONFIG_SWITCHER))}

    def save(self, data):
        payload = {
            "presets": self._clean(data.get("presets", []) if isinstance(data.get("presets"), list) else []),
            "modified": int(time.time()),
        }
        preset_db.save_records(preset_db.CONFIG_SWITCHER, payload["presets"])
        return payload

    @db.atomic
    def upsert(self, preset_id, group, name, fields=None, configs=None, active_config="", default_config="", shared_values=None):
        """Create or update a preset, addressed by id. group + name are display
        attributes; an empty/unknown id mints a new preset. Returns it, or None if
        unnamed."""
        name = canonical_label(name)
        if not name:
            return None
        data = self.load()
        preset_id = str(preset_id or "").strip()
        stored = next((preset for preset in data["presets"] if preset_id and preset.get("id") == preset_id), None)
        if stored and is_newer(stored):
            raise ValueError(stored_newer_problem(stored))
        if preset_id:
            presets = [preset for preset in data["presets"] if preset.get("id") != preset_id]
        else:
            preset_id = uuid.uuid4().hex
            presets = list(data["presets"])
        preset = self._clean_preset({
            "id": preset_id,
            "group": group,
            "name": name,
            "fields": fields,
            "configs": configs,
            "shared_values": shared_values,
            "active_config": active_config,
            "default_config": default_config,
            "modified": int(time.time()),
        })
        presets.append(preset)
        data["presets"] = presets
        self.save(data)
        return preset

    @db.atomic
    def rewrite_model_paths(self, moves):
        """A model moved but is the same model (same library id): point every saved
        preset's option for that id, and the config values that selected it, at the new
        path. Not an edit: the presets' own `modified` stays, so nothing reads Stale.
        `moves` = {library id: {"relativePath": new value, "path": absolute path}}.
        -> True when anything was rewritten (PATH_HEALING_GAMEPLAN.md step 4)."""
        if not moves:
            return False
        data = self.load()
        changed = False
        for preset in data["presets"]:
            configs = preset.get("configs") if isinstance(preset.get("configs"), dict) else {}
            for field in preset.get("fields") or []:
                if not isinstance(field, dict) or field.get("type") != "model":
                    continue
                for option in field.get("modelOptions") or []:
                    move = moves.get(option.get("libraryId") or option.get("sha256") or "")
                    new_value = (move or {}).get("relativePath") or ""
                    old_value = option.get("value")
                    if not new_value or old_value == new_value:
                        continue
                    option["value"] = new_value
                    option["relativePath"] = new_value
                    option["path"] = move.get("path") or option.get("path", "")
                    for values in [*configs.values(), preset.get("shared_values", {})]:
                        if isinstance(values, dict) and values.get(field.get("id")) == old_value:
                            values[field["id"]] = new_value
                    changed = True
        if changed:
            self.save(data)
        return changed

    @db.atomic
    def rewrite_prompt_texts(self, texts):
        """A Prompt Vault prompt was edited but is the same prompt (same record id): give
        every saved preset's option for that id, and the config values that selected it,
        the new text. Not an edit: the presets' own `modified` stays, so nothing reads
        Stale. `texts` = {record id: new text}.
        -> True when anything was rewritten (CS_LIVE_PROMPTS_GAMEPLAN.md step 1)."""
        if not texts:
            return False
        data = self.load()
        changed = False
        for preset in data["presets"]:
            configs = preset.get("configs") if isinstance(preset.get("configs"), dict) else {}
            for field in preset.get("fields") or []:
                if not isinstance(field, dict) or field.get("type") != "prompt":
                    continue
                for option in field.get("promptOptions") or []:
                    record_id = str(option.get("id") or "")
                    # An emptied prompt ("") follows too; only a record not in `texts` is left.
                    if not record_id or not isinstance(texts.get(record_id), str):
                        continue
                    new_value = texts[record_id]
                    old_value = option.get("value") or ""
                    if old_value == new_value:
                        continue
                    option["value"] = new_value
                    # A blank option's configs can't be told from unpicked ones (both ""),
                    # so only a real old text moves the configs that picked it.
                    if old_value:
                        for values in [*configs.values(), preset.get("shared_values", {})]:
                            if isinstance(values, dict) and values.get(field.get("id")) == old_value:
                                values[field["id"]] = new_value
                    changed = True
        if changed:
            self.save(data)
        return changed

    @db.atomic
    def rename(self, preset_id, group, new_name):
        """Atomically rename/regroup a preset addressed by id (group + name only)."""
        preset_id = str(preset_id or "").strip()
        group = canonical_group(group)
        new_name = canonical_label(new_name)
        if not preset_id or not new_name:
            return False
        data = self.load()
        target = next((preset for preset in data["presets"] if preset.get("id") == preset_id), None)
        if not target:
            return False
        # Duplicate (group, name) on a different id is disallowed to keep the picker
        # unambiguous (identity is the id, so this is advisory, not an identity clash).
        if any(preset.get("id") != preset_id and canonical_group(preset.get("group")) == group and preset.get("name") == new_name
               for preset in data["presets"]):
            return False
        target["group"] = group
        target["name"] = new_name
        target["modified"] = int(time.time())
        self.save(data)
        return True

    @db.atomic
    def rename_group(self, old, new):
        """Move every preset in group ``old`` to ``new`` (merging into an existing group).
        Refused, with the names, when one is already used in ``new`` (as rename() refuses)."""
        return rename_store_group(self, old, new, unique_names=True)

    @db.atomic
    def ungroup_group(self, group):
        """Move every preset in ``group`` to --none--; refused, with the names, when one is
        already used there."""
        return ungroup_store_group(self, group, unique_names=True)

    @db.atomic
    def delete_group(self, group):
        """Delete ``group`` and every preset in it, in one save."""
        return delete_store_group(self, group)

    @db.atomic
    def delete(self, preset_id):
        preset_id = str(preset_id or "").strip()
        data = self.load()
        before = len(data["presets"])
        data["presets"] = [preset for preset in data["presets"] if preset.get("id") != preset_id]
        self.save(data)
        return len(data["presets"]) != before

    def _clean_field(self, field):
        if not isinstance(field, dict):
            return None
        field_id = str(field.get("id") or "").strip()
        if not field_id:
            return None
        raw_type = str(field.get("type") or "combo")
        options = field.get("options") if isinstance(field.get("options"), list) else []
        field_type = _migrate_field_type(raw_type, options)
        if field_type is None:
            return None
        # A DYNAMIC COMBO is only as good as its captured schema; without one it's a COMBO.
        dynamic_combo = clean_dynamic_schema(field.get("dynamicCombo")) if field_type == "dynamic_combo" else None
        if field_type == "dynamic_combo" and dynamic_combo is None:
            field_type = "combo"
        raw_number_output = str(field.get("numberOutput") or "auto")
        name = str(field.get("name", ""))
        cleaned = {
            "id": field_id,
            "name": name[:SECTION_TITLE_MAX] if field_type == "section" else name,
            "type": field_type,
            "options": [str(option) for option in options if str(option).strip()] if field_type == "combo" else [],
            "numberOutput": raw_number_output if field_type == "number" and raw_number_output in NUMBER_OUTPUT_FORMATS else ("auto" if field_type == "number" else ""),
            "modelType": str(field.get("modelType") or "") if field_type == "model" else "",
            "stringMultiline": bool(field.get("stringMultiline")) if field_type == "string" else False,
        }
        if dynamic_combo is not None:
            cleaned["dynamicCombo"] = dynamic_combo
            hidden = clean_dynamic_hidden(dynamic_combo, field.get("dynamicHidden"))
            if hidden:
                cleaned["dynamicHidden"] = hidden
        if field_type == "section":
            # Schema 1.6: a title (the name) and an optional card colour; nothing to share.
            color = str(field.get("color") or "").strip().lower()
            if color in CARD_COLOR_IDS:
                cleaned["color"] = color
        elif field.get("shared") is True:
            cleaned["shared"] = True
        if field_type == "model":
            model_options = field.get("modelOptions") if isinstance(field.get("modelOptions"), list) else []
            cleaned["modelOptions"] = [self._clean_model_option(option) for option in model_options if isinstance(option, dict)]
            cleaned["modelOptions"] = [option for option in cleaned["modelOptions"] if option]
        if field_type == "prompt":
            prompt_options = field.get("promptOptions") if isinstance(field.get("promptOptions"), list) else []
            cleaned["promptOptions"] = [self._clean_prompt_option(option) for option in prompt_options if isinstance(option, dict)]
            cleaned["promptOptions"] = [option for option in cleaned["promptOptions"] if option]
        return cleaned

    def _clean_model_option(self, option):
        value = str(option.get("value") or option.get("relativePath") or option.get("file") or option.get("path") or option.get("id") or "").strip()
        if not value:
            return None
        return {
            "value": value,
            "id": str(option.get("id") or ""),
            "libraryId": str(option.get("libraryId") or option.get("sha256") or ""),
            "sha256": str(option.get("sha256") or option.get("libraryId") or ""),
            "title": str(option.get("title") or value),
            "modelType": str(option.get("modelType") or option.get("type") or ""),
            "relativePath": str(option.get("relativePath") or option.get("relative_path") or ""),
            "path": str(option.get("path") or option.get("file") or ""),
            "thumbnail": local_url(option.get("thumbnail")),
            "cardColor": str(option.get("cardColor") or ""),
            "customBadge": str(option.get("customBadge") or ""),
            "favorite": bool(option.get("favorite")),
            "nsfw": bool(option.get("nsfw")),
        }

    def _clean_prompt_option(self, option):
        # A prompt option's `value` IS the prompt text (the emitted output). `id` (else
        # category + name) identifies the source Prompt Vault record, whose saved text the
        # value follows; `dateModified` is the record's when the text was taken.
        value = str(option.get("value") or option.get("text") or "")
        # A blank option is kept only while it's linked (its prompt was emptied); it follows
        # the prompt's next text. A blank hand-typed one is nothing.
        if not value and not (option.get("id") or (option.get("category") and option.get("name"))):
            return None
        return {
            "value": value,
            "id": str(option.get("id") or ""),
            "dateModified": str(option.get("dateModified") or ""),
            "profileId": str(option.get("profileId") or "default"),
            "title": str(option.get("title") or option.get("name") or ""),
            "category": str(option.get("category") or ""),
            "name": str(option.get("name") or option.get("title") or ""),
            "thumbnail": local_url(option.get("thumbnail") or option.get("thumbnailUrl")),
            "cardColor": str(option.get("cardColor") or ""),
            "customBadge": str(option.get("customBadge") or ""),
            "favorite": bool(option.get("favorite")),
            "nsfw": bool(option.get("nsfw")),
        }

    def _clean_configs(self, configs, field_ids, seed_ids=(), dynamic_keys=None):
        """`dynamic_keys`: {DYNAMIC COMBO field id: every value key it owns}, kept when
        present (remembered settings of options that aren't picked included)."""
        cleaned = {}
        source = configs if isinstance(configs, dict) else {}
        seed_ids = set(seed_ids)
        dynamic_keys = dynamic_keys or {}
        for name, values in source.items():
            config_name = str(name or "").strip()
            if not config_name or not isinstance(values, dict):
                continue
            cleaned_values = {}
            for field_id in field_ids:
                if field_id in dynamic_keys:
                    for value_key in dynamic_keys[field_id]:
                        if value_key in values:
                            cleaned_values[value_key] = str(values.get(value_key, ""))
                    continue
                if field_id in seed_ids:
                    mode, locked = parse_seed_state(values.get(field_id + SEED_STATE_SUFFIX))
                    cleaned_values[field_id + SEED_STATE_SUFFIX] = format_seed_state(mode, locked)
                    seed = clean_seed_value(values.get(field_id))
                    if locked and seed:
                        cleaned_values[field_id] = seed
                    continue
                if field_id in values:
                    cleaned_values[field_id] = str(values.get(field_id, ""))
            cleaned[config_name] = cleaned_values
        return dict(sorted(cleaned.items(), key=lambda item: item[0].lower()))

    def _clean_preset(self, preset):
        if is_newer(preset):
            return dict(preset)   # written by newer code: kept exactly as stored
        fields = []
        seen_field_ids = set()
        for field in preset.get("fields", []) if isinstance(preset, dict) else []:
            cleaned = self._clean_field(field)
            if not cleaned or cleaned["id"] in seen_field_ids:
                continue
            seen_field_ids.add(cleaned["id"])
            fields.append(cleaned)

        # Configs keep their own values for shared fields too: hidden while shared, they
        # come back when Share is turned off.
        field_ids = [field["id"] for field in fields]
        seed_ids = [field["id"] for field in fields if field["type"] == "seed"]
        dynamic_keys = {field["id"]: dynamic_value_keys(field) for field in fields if field["type"] == "dynamic_combo"}
        configs = self._clean_configs(preset.get("configs"), field_ids, seed_ids, dynamic_keys)
        shared_ids = [field["id"] for field in fields if field.get("shared")]
        shared_values = self._clean_configs({"shared": preset.get("shared_values") or {}}, shared_ids, seed_ids, dynamic_keys).get("shared", {})
        active_config = str(preset.get("active_config") or "")
        if active_config and active_config not in configs:
            active_config = ""
        if not active_config and configs:
            active_config = next(iter(configs.keys()))
        default_config = str(preset.get("default_config") or "")
        if default_config and default_config not in configs:
            default_config = ""

        return {
            "id": str(preset.get("id") or "").strip() or uuid.uuid4().hex,
            "group": canonical_group(preset.get("group")),
            "name": canonical_label(preset.get("name", "")),
            "fields": fields,
            "configs": configs,
            **({"shared_values": shared_values} if shared_ids else {}),
            "active_config": active_config,
            "default_config": default_config,
            "modified": preset.get("modified") or int(time.time()),
            "schema": CS_SCHEMA_VERSION,
        }

    def _clean(self, presets):
        deduped = {}
        for preset in presets:
            if not isinstance(preset, dict) or not preset.get("name"):
                continue
            cleaned = self._clean_preset(preset)
            if cleaned.get("name") and cleaned.get("id"):
                deduped[cleaned["id"]] = cleaned
        return sorted(
            deduped.values(),
            key=lambda item: (item.get("group", "").lower(), item.get("name", "").lower()),
        )
