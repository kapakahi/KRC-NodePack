class ModelLibraryNode:
    DESCRIPTION = (
        "Browse every model folder (checkpoints, diffusion models, VAEs, text encoders, "
        "upscalers, LoRAs, ...) with thumbnails, metadata, Collections and Civitai lookup. "
        "Organization only: no workflow inputs or outputs."
    )
    CATEGORY = "KRC NodePack"
    RETURN_TYPES = ()
    RETURN_NAMES = ()
    FUNCTION = "noop"
    OUTPUT_NODE = True

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "selected_lora_sha256": ("STRING", {"default": "", "multiline": False}),
                "metadata_edit_serial": ("INT", {"default": 0}),
                "show_nsfw": ("BOOLEAN", {"default": False}),
                "show_favorites": ("BOOLEAN", {"default": False}),
                "color_filter": ("STRING", {"default": "", "multiline": False}),
                "browser_view": ("STRING", {"default": "thumb-list", "multiline": False}),
            },
        }

    def noop(self, **kwargs):
        return {"ui": {}, "result": ()}


# Model Library owns its route namespace. LoRA visibility is read-through inside
# those routes so LoRA Loadout remains untouched.
from ..utils.model_library.routes import register_routes
register_routes()

# Cross-node Collections routes (shared store spanning models + LoRAs). Idempotent; also
# registered from the LoRA Loadout node, whichever loads first.
from ..utils.library.collections_routes import register_collection_routes
from ..utils.library.transfer_history import register_transfer_history_routes
register_collection_routes()
register_transfer_history_routes()


NODE_CLASS_MAPPINGS = {
    "KRC Model Library": ModelLibraryNode,
}
NODE_DISPLAY_NAME_MAPPINGS = {
    "KRC Model Library": "KRC Model Library",
}
