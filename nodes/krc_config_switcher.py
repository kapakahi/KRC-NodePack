"""KRC Config Switcher — config payload source with saved configs.

Defines a shared set of named *fields*; each field becomes one link output. A
*config* is a named snapshot of values for those fields. An `active_config`
selector picks which snapshot drives the outputs, so you can swap whole config
bundles (e.g. Distilled vs Base diffusion settings: cfg, steps, model,
scheduler, gpu) from a single node.

Storage: the fields + all configs live in one declared `config_data` STRING
(hidden in the UI, maintained by the DOM editor in web/config_switcher/config.js), so the
whole node survives ComfyUI's API-format export. `active_config` is a declared
combo, so it too survives export and can be promoted to a subgraph boundary.
`config_preset_id` (hidden, optional) carries the id of the global preset the node was
loaded from, so an API-format export says which preset it is; the run ignores it.

The node emits one stable KRC_CONFIG payload. KRC Config Switcher Link is the
graph-facing companion that exposes selected fields as output sockets via an
explicit link update.
"""

import json

from ..utils.bundle.sections import register_section
from ..utils.config_switcher_bundle import bundle_sections
from ..utils.config_switcher_dynamic import dynamic_value_keys
from ..utils.library.run_usage import node_used
from ..utils.config_switcher_heal import resolve_model_values, resolve_prompt_values
from ..utils.config_switcher_presets import ConfigSwitcherPresetStore
from ..utils.config_switcher_schema import save_problem
from ..utils.preset_naming import GROUP_ACTIONS, group_action_answer
from .krc_config_switcher_common import MAX_CONFIG_OUTPUTS

# Shown by the active_config combo before any config exists. Kept in sync with
# web/js/config_switcher/config.js.
PLACEHOLDER = "(no config)"


# ── API routes ────────────────────────────────────────────────────────────────
try:
    from aiohttp import web
    import server as comfy_server

    # This node's KRC bundle section (UNIFIED_BUNDLE_GAMEPLAN.md).
    for _section in bundle_sections():
        register_section(_section)

    @comfy_server.PromptServer.instance.routes.get("/krc/config-switcher/presets")
    async def _api_list_presets(_request):
        return web.json_response(ConfigSwitcherPresetStore().load())

    @comfy_server.PromptServer.instance.routes.post("/krc/config-switcher/presets")
    async def _api_save_preset(request):
        payload = await request.json()
        # A page and a server on different preset schemas would lose what one of them
        # doesn't know (utils/config_switcher_schema.py).
        problem = save_problem(payload.get("schema"))
        if problem:
            return web.json_response({"error": problem}, status=409)
        try:
            preset = ConfigSwitcherPresetStore().upsert(
                payload.get("id", ""),
                payload.get("group", ""),
                payload.get("name", ""),
                payload.get("fields", []),
                payload.get("configs", {}),
                payload.get("active_config", ""),
                payload.get("default_config", ""),
                shared_values=payload.get("shared_values", {}),
            )
        except ValueError as err:
            return web.json_response({"error": str(err)}, status=409)
        if preset is None:
            return web.json_response({"error": "Missing preset name"}, status=400)
        return web.json_response(preset)

    @comfy_server.PromptServer.instance.routes.post("/krc/config-switcher/presets/heal-paths")
    async def _api_heal_preset_paths(request):
        """Moves a node found itself (the load-time catch-up, e.g. after models
        moved while ComfyUI was down): {moves: {library id: {relativePath, path}}}. The
        saved presets follow, without becoming modified."""
        payload = await request.json()
        moves = payload.get("moves") if isinstance(payload, dict) else None
        if not isinstance(moves, dict):
            return web.json_response({"ok": False, "error": "Missing moves"}, status=400)
        clean = {
            str(library_id): {"relativePath": str(move.get("relativePath") or ""), "path": str(move.get("path") or "")}
            for library_id, move in moves.items()
            if isinstance(move, dict) and move.get("relativePath")
        }
        return web.json_response({"ok": True, "changed": ConfigSwitcherPresetStore().rewrite_model_paths(clean)})

    @comfy_server.PromptServer.instance.routes.post("/krc/config-switcher/presets/heal-prompts")
    async def _api_heal_preset_prompts(request):
        """Prompt texts a node found edited itself (a Prompt Vault save or the load-time
        catch-up): {texts: {record id: text}}. The saved presets follow, without becoming
        modified (CS_LIVE_PROMPTS_GAMEPLAN.md step 1)."""
        payload = await request.json()
        texts = payload.get("texts") if isinstance(payload, dict) else None
        if not isinstance(texts, dict):
            return web.json_response({"ok": False, "error": "Missing texts"}, status=400)
        # "" is a prompt that was emptied: it follows too.
        clean = {str(record_id): text for record_id, text in texts.items() if record_id and isinstance(text, str)}
        return web.json_response({"ok": True, "changed": ConfigSwitcherPresetStore().rewrite_prompt_texts(clean)})

    @comfy_server.PromptServer.instance.routes.post("/krc/config-switcher/presets/rename")
    async def _api_rename_preset(request):
        payload = await request.json()
        ok = ConfigSwitcherPresetStore().rename(payload.get("id", ""), payload.get("group", ""), payload.get("new", ""))
        return web.json_response({"ok": ok})

    # Group menu: rename-group {from, to}, ungroup-group {group}, delete-group {group}.
    def _group_route(action):
        async def handler(request):
            payload = await request.json()
            result, status = group_action_answer(ConfigSwitcherPresetStore(), action, payload, "Config Switcher")
            return web.json_response(result, status=status)
        return handler

    for _action in GROUP_ACTIONS:
        comfy_server.PromptServer.instance.routes.post(f"/krc/config-switcher/presets/{_action}-group")(_group_route(_action))

    @comfy_server.PromptServer.instance.routes.delete("/krc/config-switcher/presets")
    async def _api_delete_preset(request):
        payload = await request.json()
        ok = ConfigSwitcherPresetStore().delete(payload.get("id", ""))
        return web.json_response({"ok": ok})


except Exception:
    pass


class KRCConfigSwitcher:
    DESCRIPTION = (
        "Create named presets of typed values and switch between them from one "
        "node, then pipe the selected config to KRC Config Switcher Link."
    )

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                # Canonical store: {"fields": [...], "configs": {...}}. Hidden;
                # maintained by the DOM editor. Declared -> survives API export.
                "config_data": ("STRING", {"default": '{"fields": [], "configs": {}}'}),
                # Active config name. Declared combo (placeholder options); the
                # real names are injected on the frontend. Promotable.
                "active_config": ([PLACEHOLDER],),
            },
            "optional": {
                # The global preset this node was loaded from (its id), or "". Hidden;
                # kept in step by the frontend. Declared so an API-format export carries
                # the link. Doesn't change the output, so it's out of IS_CHANGED.
                "config_preset_id": ("STRING", {"default": ""}),
            },
        }

    RETURN_TYPES = ("KRC_CONFIG",)
    RETURN_NAMES = ("config",)
    FUNCTION = "run"
    CATEGORY = "KRC NodePack"

    @classmethod
    def VALIDATE_INPUTS(cls, active_config):
        # The frontend injects config names that aren't in the static combo list;
        # naming active_config here skips ComfyUI's "value in list" check.
        return True

    @classmethod
    def IS_CHANGED(cls, config_data="", active_config="", **_kwargs):
        """Cache key for ComfyUI: the config as sent plus the current path of every model and
        the current saved text of every prompt it selects, so a model that moved or a prompt
        edited in Prompt Vault re-executes the node (which then emits the new value) instead
        of ComfyUI serving the cached old one. Errors re-execute."""
        try:
            fields, configs, values = cls._parse(config_data, active_config)
            resolved, _moves = resolve_model_values(fields, values)
            resolved, _texts = resolve_prompt_values(fields, resolved)
            return json.dumps([config_data, active_config, resolved], sort_keys=True)
        except Exception:  # noqa: BLE001
            return float("nan")

    @staticmethod
    def _parse(config_data, active_config):
        try:
            data = json.loads(config_data)
        except (json.JSONDecodeError, TypeError):
            data = {}
        if not isinstance(data, dict):
            data = {}
        fields = data.get("fields") if isinstance(data.get("fields"), list) else []
        configs = data.get("configs") if isinstance(data.get("configs"), dict) else {}
        values = configs.get(active_config, {})
        if not isinstance(values, dict):
            values = {}
        shared = data.get("shared_values")
        if isinstance(shared, dict):
            values = dict(values)
            for value_key in KRCConfigSwitcher._shared_value_keys(fields):
                if value_key in shared:
                    values[value_key] = shared[value_key]
        return fields, configs, values

    @staticmethod
    def _shared_value_keys(fields):
        """The value keys a shared field reads from shared_values: a seed's lock/mode too, and
        a DYNAMIC COMBO's whole set (its pick and every option's settings)."""
        keys = set()
        for field in fields:
            if not isinstance(field, dict) or not field.get("shared"):
                continue
            key = field.get("id")
            if field.get("type") == "dynamic_combo":
                keys.update(dynamic_value_keys(field))
            else:
                keys.update([key, f"{key}:seed"] if field.get("type") == "seed" else [key])
        return keys

    def run(self, config_data, active_config, config_preset_id=""):
        fields, configs, values = self._parse(config_data, active_config)

        # Silent usage bookkeeping: count each ML-backed model selected in the emitted
        # config, keyed by its ML library id (carried on the model option — no name
        # resolution). A hand-typed option without a libraryId is skipped. Best-effort.
        # Matched against the stored values, before any path healing below.
        model_ids = []
        for field in fields:
            if not isinstance(field, dict) or field.get("type") != "model":
                continue
            selected_value = values.get(field.get("id"))
            if not selected_value:
                continue
            for option in (field.get("modelOptions") or []):
                if isinstance(option, dict) and option.get("value") == selected_value:
                    lib_id = option.get("libraryId") or option.get("sha256")
                    if lib_id:
                        model_ids.append(lib_id)
                    break
        # Once per run, cached runs included (utils/library/run_usage.py).
        node_used({"models": model_ids})

        # A model field's path follows its library id: a moved model emits its current
        # path, and the stored one is rewritten everywhere (never a modification).
        try:
            values, _moves = resolve_model_values(fields, values)
        except Exception as exc:  # noqa: BLE001 — never fail a run over healing
            print(f"[KRC Config Switcher] could not check model paths: {exc}")
        # A prompt field's text follows its Prompt Vault record: an edited prompt emits its
        # current saved text, rewritten everywhere (never a modification).
        try:
            values, _texts = resolve_prompt_values(fields, values)
        except Exception as exc:  # noqa: BLE001 — never fail a run over a prompt lookup
            print(f"[KRC Config Switcher] could not check prompt texts: {exc}")
        # Healed values written back into the active config: its own keys only, so a shared
        # field's hidden per-config value stays as it was.
        if active_config in configs and isinstance(configs[active_config], dict):
            shared_keys = self._shared_value_keys(fields)
            own = {**configs[active_config],
                   **{key: value for key, value in values.items() if key not in shared_keys}}
            if own != configs[active_config]:
                configs = dict(configs)
                configs[active_config] = own

        return ({
            "fields": fields[:MAX_CONFIG_OUTPUTS],
            "configs": configs,
            "active_config": active_config if active_config != PLACEHOLDER else "",
            "values": values,
        },)


NODE_CLASS_MAPPINGS = {
    "KRC Config Switcher": KRCConfigSwitcher,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "KRC Config Switcher": "KRC Config Switcher",
}
