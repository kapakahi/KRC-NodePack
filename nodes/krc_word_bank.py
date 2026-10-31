import os
import hashlib
import json
import random
import re

from ..utils.word_bank_banks import WordBankCatalog, normalize_bank_name
from ..utils.word_bank_presets import WordBankPresetStore
from ..utils.preset_naming import GROUP_ACTIONS, group_action_answer
from ..utils.library.transfer_history import log_transfer, record_export, record_import, size_text, transfer_route
from ..utils.upload_limits import TEXT_UPLOAD_MAX, UploadTooLarge, read_part
from ..utils.bundle.sections import register_section
from ..utils.word_bank_bundle import MAX_BANK_LINES, MAX_LINE_LEN, bundle_sections, validate_bank_text

def _normalize_bank_name(name):
    """Return a safe bank stem, or "" when the requested name is unusable."""
    return normalize_bank_name(name)


def _write_bank(category, entries):
    cleaned = []
    for item in entries:
        value = str(item or "").strip()
        if not value:
            continue
        if len(value) > MAX_LINE_LEN:
            return False, "entry too long"
        cleaned.append(value)
    if len(cleaned) > MAX_BANK_LINES:
        return False, "too many entries"
    if not _bank_catalog().write_lines(category, cleaned):
        return False, "invalid bank name"
    return True, ""


def _bank_catalog():
    return WordBankCatalog()


def _bank_name(bank):
    return bank.get("name", "") if isinstance(bank, dict) else ""


def _bank_id(bank):
    return bank.get("id", "") if isinstance(bank, dict) else ""


# Banks live in krc.db (utils/word_bank_banks.py). The starter set in data/word_banks/
# seeds a fresh install once (utils/db/importers.py).
print("[KRC Word Bank] krc_word_bank.py loaded - banks in krc.db")


def _get_bank_names():
    return _bank_catalog().list()


def _read_bank(category):
    try:
        return _bank_catalog().read_lines(category)
    except Exception:
        return []


# ── API routes ────────────────────────────────────────────────────────────────
try:
    from aiohttp import web
    import server as comfy_server

    # This node's KRC bundle section (UNIFIED_BUNDLE_GAMEPLAN.md).
    for _section in bundle_sections():
        register_section(_section)

    @comfy_server.PromptServer.instance.routes.get("/wordbank/banks")
    async def _api_list_banks(request):
        return web.json_response(_get_bank_names())

    @comfy_server.PromptServer.instance.routes.get("/wordbank/random/{category}")
    async def _api_random_word(request):
        lines = _read_bank(request.match_info["category"])
        exclude = (request.query.get("exclude") or "").strip().lower()
        choices = [line for line in lines if line.strip().lower() != exclude]
        value = random.choice(choices or lines) if lines else ""
        return web.json_response({"value": value})

    @comfy_server.PromptServer.instance.routes.get("/wordbank/banks/{category}/entries")
    async def _api_bank_entries(request):
        return web.json_response({"entries": _read_bank(request.match_info["category"])})

    @comfy_server.PromptServer.instance.routes.get("/wordbank/banks/{category}/export")
    @transfer_route("export", "word_bank.bank")
    async def _api_export_bank(request):
        catalog = _bank_catalog()
        bank = catalog.get(request.match_info["category"])
        text = catalog.read_text(_bank_id(bank)) if bank else None
        if not bank or text is None:
            return web.json_response({"error": "Word bank not found"}, status=404)
        filename = _bank_name(bank).replace("/", "_") or "word_bank"
        body = text.encode("utf-8")
        record_export("word_bank.bank", _bank_name(bank), summary=size_text(len(body)))
        return web.Response(
            body=body,
            headers={
                "Content-Type": "text/plain; charset=utf-8",
                "Content-Disposition": f'attachment; filename="{filename}.txt"',
            },
        )

    @comfy_server.PromptServer.instance.routes.post("/wordbank/banks")
    async def _api_create_bank(request):
        payload = await request.json()
        bank, reason = _bank_catalog().create(payload.get("name", ""))
        if not bank:
            status = 409 if reason == "Word bank already exists" else 400
            return web.json_response({"error": reason}, status=status)
        return web.json_response({"ok": True, **bank})

    @comfy_server.PromptServer.instance.routes.post("/wordbank/banks/rename")
    async def _api_rename_bank(request):
        payload = await request.json()
        bank, reason = _bank_catalog().rename(payload.get("id") or payload.get("old", ""), payload.get("new", ""))
        if not bank:
            status = 404 if reason == "Word bank not found" else 409 if reason == "Target word bank exists" else 400
            return web.json_response({"ok": False, "error": reason}, status=status)
        return web.json_response({"ok": True, **bank})

    @comfy_server.PromptServer.instance.routes.delete("/wordbank/banks")
    async def _api_delete_bank(request):
        payload = await request.json()
        bank = _bank_catalog().delete(payload.get("id") or payload.get("name", ""))
        if not bank:
            return web.json_response({"ok": False}, status=404)
        return web.json_response({"ok": True, **bank})

    @comfy_server.PromptServer.instance.routes.post("/wordbank/banks/entry")
    async def _api_insert_entry(request):
        payload = await request.json()
        category = payload.get("categoryId") or payload.get("category", "")
        value = str(payload.get("value", "") or "").strip()
        bank = _bank_catalog().get(category)
        if not bank:
            return web.json_response({"ok": False, "error": "Invalid bank name"}, status=400)
        if not value or len(value) > MAX_LINE_LEN:
            return web.json_response({"ok": False, "error": "Invalid entry"}, status=400)
        entries = _read_bank(category)
        if any(item.strip().lower() == value.lower() for item in entries):
            return web.json_response({"ok": True, "added": False, **bank})
        ok, reason = _write_bank(_bank_id(bank), entries + [value])
        if not ok:
            return web.json_response({"ok": False, "error": reason}, status=400)
        return web.json_response({"ok": True, "added": True, **bank})

    @comfy_server.PromptServer.instance.routes.delete("/wordbank/banks/entry")
    async def _api_delete_entry(request):
        payload = await request.json()
        category = payload.get("categoryId") or payload.get("category", "")
        value = str(payload.get("value", "") or "").strip()
        bank = _bank_catalog().get(category)
        if not bank or not value:
            return web.json_response({"ok": False}, status=400)
        entries = _read_bank(_bank_id(bank))
        kept = [item for item in entries if item.strip().lower() != value.lower()]
        removed = len(kept) != len(entries)
        if removed:
            ok, reason = _write_bank(_bank_id(bank), kept)
            if not ok:
                return web.json_response({"ok": False, "error": reason}, status=400)
        return web.json_response({"ok": True, "removed": removed, **bank})

    @comfy_server.PromptServer.instance.routes.post("/wordbank/banks/import")
    @transfer_route("import", "word_bank.bank")
    async def _api_import_banks(request):
        # Save uploaded .txt files as banks (one bank per file). Each file is
        # validated as a word list first; non-.txt parts and files that fail
        # validation are rejected (with a reason), not imported. Existing banks with
        # the same name are overwritten.
        reader = await request.multipart()
        saved, rejected = [], []
        while True:
            field = await reader.next()
            if field is None:
                break
            filename = getattr(field, "filename", None)
            if not filename:
                await field.release()  # drain non-file part
                continue
            base = os.path.basename(filename)  # basename blocks path traversal
            if not base.lower().endswith(".txt"):
                await field.release()
                rejected.append({"name": base or filename, "reason": "not a .txt file"})
                continue
            safe_name = _normalize_bank_name(base)
            if not safe_name:
                await field.release()
                rejected.append({"name": base, "reason": "invalid bank name"})
                continue
            try:
                raw = await read_part(field, TEXT_UPLOAD_MAX)
            except UploadTooLarge as err:
                await field.release()
                rejected.append({"name": base, "reason": str(err)})
                continue
            ok, reason = validate_bank_text(raw)
            if not ok:
                rejected.append({"name": base, "reason": reason})
                continue
            try:
                bank, reason = _bank_catalog().upsert_file(safe_name, raw)
            except Exception as exc:  # noqa: BLE001
                bank, reason = None, f"could not save ({exc})"
            if not bank:
                rejected.append({"name": base, "reason": reason or "could not save"})
                continue
            saved.append(bank)
        if saved:
            detail = _bank_name(saved[0]) if len(saved) == 1 else f"{len(saved)} banks"
            record_import("word_bank.bank", "", detail, summary={"saved": saved, "rejected": rejected})
        for item in rejected:
            log_transfer("import", "word_bank.bank", False, detail=item["name"], summary=item["reason"])
        return web.json_response({"ok": True, "saved": saved, "rejected": rejected})


    # ── Global presets (disk-backed, unbounded, keyed by name) ──
    @comfy_server.PromptServer.instance.routes.get("/wordbank/presets")
    async def _api_list_presets(request):
        return web.json_response(WordBankPresetStore().load())

    @comfy_server.PromptServer.instance.routes.post("/wordbank/presets")
    async def _api_save_preset(request):
        payload = await request.json()
        preset = WordBankPresetStore().upsert_by_id(payload.get("id", ""), payload.get("group", ""), payload.get("name", ""), payload.get("rows", []))
        if preset is None:
            return web.json_response({"error": "Missing preset name"}, status=400)
        return web.json_response(preset)

    @comfy_server.PromptServer.instance.routes.post("/wordbank/presets/rename")
    async def _api_rename_preset(request):
        payload = await request.json()
        ok = WordBankPresetStore().rename(payload.get("id", ""), payload.get("group", ""), payload.get("new", ""))
        return web.json_response({"ok": ok})

    # Group menu: rename-group {from, to}, ungroup-group {group}, delete-group {group}.
    def _group_route(action):
        async def handler(request):
            payload = await request.json()
            result, status = group_action_answer(WordBankPresetStore(), action, payload, "Word Bank")
            return web.json_response(result, status=status)
        return handler

    for _action in GROUP_ACTIONS:
        comfy_server.PromptServer.instance.routes.post(f"/wordbank/presets/{_action}-group")(_group_route(_action))

    @comfy_server.PromptServer.instance.routes.delete("/wordbank/presets")
    async def _api_delete_preset(request):
        payload = await request.json()
        ok = WordBankPresetStore().delete(payload.get("id", ""))
        return web.json_response({"ok": ok})

except Exception:
    pass


# ── Word Bank Node ────────────────────────────────────────────────────────────

class KRCWordBank:
    DESCRIPTION = (
        "Randomize selected words in text using saved word banks and presets, "
        "with seed control, auto-seed randomization, and two text outputs for "
        "prompt workflows. Use tags like <color> or <style> to mark replaceable words."
    )
    CATEGORY = "KRC NodePack"

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {},
            "optional": {
                "prompt_a": ("STRING", {"forceInput": True}),
                "prompt_b": ("STRING", {"forceInput": True}),
                # JS keeps this in sync; widget.hidden = true hides it in the UI.
                "state_json": ("STRING", {"default": "{}"}),
            },
            "hidden": {
                "unique_id": "UNIQUE_ID",
            },
        }

    RETURN_TYPES = ("STRING", "STRING")
    RETURN_NAMES = ("output_a", "output_b")
    FUNCTION = "execute"
    OUTPUT_NODE = False

    @classmethod
    def IS_CHANGED(cls, prompt_a="", prompt_b="", state_json="{}", unique_id=None):
        try:
            state = json.loads(state_json) if state_json else {}
            if state.get("autoSeed", True):
                return float("nan")  # NaN != NaN → always re-execute
            # Auto-seed off: re-execute only when the deterministic inputs
            # change. Hash the seed together with the row/category selections
            # and text inputs — not the seed alone — so editing which banks are
            # drawn (with the seed held fixed) still refreshes the output.
            payload = json.dumps(
                [state.get("seed", 0), state.get("rows", []), prompt_a, prompt_b],
                sort_keys=True, default=str,
            )
            return hashlib.sha256(payload.encode("utf-8")).hexdigest()
        except Exception:
            return float("nan")

    def execute(
        self,
        prompt_a: str = "",
        prompt_b: str = "",
        state_json: str = "{}",
        unique_id=None,
    ):
        try:
            state: dict = json.loads(state_json) if state_json else {}
        except Exception:
            state = {}

        rows = state.get("rows", [])
        seed = state.get("seed", 0)
        token_syntax = state.get("tokenSyntax", "angle")
        rng  = random.Random(int(seed))

        buckets: dict[str, list[str]] = {}
        aliases: dict[str, str] = {}
        for row in rows:
            bank_ref = row.get("categoryId") or row.get("category", "")
            if not bank_ref:
                continue
            bank = _bank_catalog().get(bank_ref) if _bank_catalog() else None
            category = _bank_name(bank) if bank else row.get("category", "")
            category_id = _bank_id(bank) if bank else bank_ref
            value = row.get("value", "")
            if not value:
                lines = _read_bank(category_id)
                value = rng.choice(lines) if lines else ""
            if not value:
                continue
            # Rows reusing the same bank are addressed by a stable per-row
            # occurrence number: occ 1 → bare <category>, occ ≥ 2 → <category#N>.
            # (The JS UI assigns/persists occ; default to 1 for legacy state.)
            try:
                occ = int(row.get("occ", 1) or 1)
            except (TypeError, ValueError):
                occ = 1
            key = category if occ <= 1 else f"{category}#{occ}"
            buckets.setdefault(key, []).append(value)
            spaced_category = category.replace("_", " ")
            if spaced_category != category:
                alias_key = spaced_category if occ <= 1 else f"{spaced_category}#{occ}"
                aliases[alias_key] = key

        # Comma-join is only a fallback if two rows ever resolve to the same key.
        replacements = {key: ", ".join(vals) for key, vals in buckets.items()}
        replacements.update({alias: replacements[key] for alias, key in aliases.items() if key in replacements})

        token_patterns = {
            "angle": r"<([^<>\r\n]+)>",
            "brace": r"\{\{([^{}\r\n]+)\}\}",
            "bracket": r"\[\[([^\[\]\r\n]+)\]\]",
        }
        token_pattern = token_patterns.get(token_syntax, token_patterns["angle"])

        def _replace(text: str) -> str:
            if not text:
                return ""
            return re.sub(
                token_pattern,
                lambda m: replacements.get(m.group(1).strip(), m.group(0)),
                text,
            )

        return (_replace(prompt_a), _replace(prompt_b) if prompt_b else "")


# ── Mappings ──────────────────────────────────────────────────────────────────

NODE_CLASS_MAPPINGS = {
    "KRC Word Bank": KRCWordBank,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "KRC Word Bank": "KRC Word Bank",
}
