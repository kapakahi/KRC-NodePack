"""Add the finished product to the Media library: images as stills, a VIDEO as it arrives."""
from pathlib import PurePosixPath

from ..utils.media.output_save import save_outputs, settings


class KRCMediaOutput:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {"output_data": ("STRING", {"default": "{}"})},
            "optional": {
                "images": ("IMAGE", {"tooltip": "Saved as stills, one file per image in the batch."}),
                "video": ("VIDEO", {"tooltip": "A finished video, saved as it arrives. Build it upstream (Create Video, VHS...)."}),
                "filename": ("STRING", {"forceInput": True, "tooltip": "Override the filename/prefix from Options for this execution. Disconnect to use the saved prefix."}),
            },
            "hidden": {"prompt": "PROMPT", "extra_pnginfo": "EXTRA_PNGINFO"},
        }

    RETURN_TYPES = ()
    FUNCTION = "save"
    OUTPUT_NODE = True
    CATEGORY = "KRC NodePack"
    DESCRIPTION = ("Add finished images or a finished video to the Media library; keeps six recent outputs. "
                   "Images save as PNG or lossless WebP stills. Media Output never encodes video: "
                   "for frames, put Create Video (or another video node) in front.")

    def save(self, output_data="{}", images=None, video=None, prompt=None, extra_pnginfo=None, filename=None):
        from ..utils.media import run_time
        from ..utils.media.media_routes import _announce, _public
        records = save_outputs(output_data, images, video, prompt, extra_pnginfo, filename=filename)
        _announce("output")
        # The run's time is known only once the whole prompt finishes: filled in afterwards.
        run_time.watch(run_time.current_prompt_id(), [record["id"] for record in records])
        native = native_results(records) if settings(output_data, filename=filename)["native"] else {}
        return {"ui": {"krc_media_outputs": [_public(record) for record in records], **native}, "result": ()}


def native_results(records):
    """"Show in queue and Assets" (the node's Options, on by default): the saved files as
    core's result entries, so ComfyUI's queue and Assets list them (the files already live in
    ComfyUI's output directory, under KRC-Media/). The node hides ComfyUI's own preview box;
    the KRC preview stays the only one."""
    entries = []
    for record in records:
        relative = PurePosixPath(record["relative_path"])
        entries.append({"filename": relative.name, "subfolder": relative.parent.as_posix(), "type": "output"})
    if not entries:
        return {}
    only_video = all(record["kind"] == "video" for record in records)
    return {"images": entries, **({"animated": (True,)} if only_video else {})}


NODE_CLASS_MAPPINGS = {"KRC Media Output": KRCMediaOutput}
NODE_DISPLAY_NAME_MAPPINGS = {"KRC Media Output": "KRC Media Output"}
