from pathlib import Path

from ..library.civitai_map import civitai_model_url
from ..library.metadata import primary_file_size_bytes
from ..library.nsfw import civitai_nsfw
from ..library.source_import import (  # noqa: F401  (re-exported for call sites)
    clean_html,
    normalize_tags,
)


def build_civitai_fields(path, civitai):
    """The KRC record fields a Civitai by-hash response (model grafted in) maps to.

    Returns exactly CIVITAI_DERIVED_KEYS; the caller (civitai_map.merge_civitai_into_record)
    overlays them onto the existing record and stamps the source, identity and
    verification. The NSFW rating is the shared one (utils/library/nsfw.py)."""
    path = Path(path)
    civitai = civitai if isinstance(civitai, dict) else {}
    civitai_model = civitai.get("model") if isinstance(civitai.get("model"), dict) else {}
    name = str(civitai_model.get("name") or "").strip()
    images = source_civitai_preview_images(civitai)
    download_url = civitai.get("downloadUrl") or first_primary_file_download(civitai) or ""
    model_id = civitai.get("modelId")
    rating, nsfw = civitai_nsfw(civitai, civitai_model, images)
    primary = primary_civitai_file(civitai)
    return {
        "name": name,
        "originalName": name,
        "version": str(civitai.get("name") or "").strip(),
        "baseModel": str(civitai.get("baseModel") or civitai_model.get("baseModel") or ""),
        "description": clean_html(civitai_model.get("description") or civitai.get("description") or ""),
        "trainedWords": normalize_words(civitai.get("trainedWords")),
        "tags": normalize_tags(civitai_model.get("tags")),
        "images": images,
        "previewImages": images,
        # Prefer the Civitai model PAGE (deep-linked to the version) over the raw
        # .safetensor download link, matching the generic-model fetch + the verification
        # shield. The download URL is still kept in sourceMetadata.civitai.downloadUrl.
        "originUrl": civitai_model_url(model_id, civitai.get("id")) or download_url,
        # The same shape as a generic model's Civitai source.
        "source": {
            "name": "Civitai",
            "url": civitai_model_url(model_id),
            "modelId": model_id,
            "versionId": civitai.get("id"),
        },
        "sourceMetadata": build_source_metadata(civitai, civitai_model, images, download_url),
        "nsfw": nsfw,
        "nsfwLevel": rating,
        "creator": {
            "username": nested_present(civitai, ("creator", "username")) or "",
            "avatarUrl": nested_present(civitai, ("creator", "image")) or nested_present(civitai, ("creator", "avatarUrl")) or "",
        },
        "usage": {
            "allowNoCredit": civitai_model.get("allowNoCredit"),
            "allowCommercialUse": civitai_model.get("allowCommercialUse"),
            "allowDerivatives": civitai_model.get("allowDerivatives"),
            "allowDifferentLicense": civitai_model.get("allowDifferentLicense"),
            "uploadType": civitai_model.get("uploadType") or civitai.get("uploadType") or "",
            "credit": civitai_model.get("credit") or civitai.get("credit") or "",
            "usageControl": civitai_model.get("usageControl") if isinstance(civitai_model.get("usageControl"), dict) else {},
        },
        "primaryFile": {
            "filename": primary.get("name") or path.name,
            "sizeBytes": primary_file_size_bytes({"sizeKB": primary.get("sizeKB")}),
            "hashes": primary.get("hashes") if isinstance(primary.get("hashes"), dict) else {},
            "scanResult": primary.get("pickleScanResult") or primary.get("scanResult") or "",
            "scanMessage": primary.get("pickleScanMessage") or primary.get("scanMessage") or "",
            "scanTimestamp": primary.get("scannedAt") or primary.get("scanTimestamp") or "",
        },
    }


def build_source_metadata(civitai, civitai_model, images, download_url):
    files = civitai.get("files") if isinstance(civitai.get("files"), list) else []
    return {
        "civitai": {
            "modelId": civitai.get("modelId"),
            "versionId": civitai.get("id"),
            "modelName": civitai_model.get("name") or "",
            "versionName": civitai.get("name", ""),
            "modelType": civitai_model.get("type") or civitai_model.get("modelType") or "",
            "baseModelType": civitai.get("baseModelType") or civitai_model.get("baseModelType") or "",
            "creator": nested_present(civitai, ("creator", "username")) or "",
            "air": civitai.get("air", ""),
            "downloadUrl": download_url,
            "publishedAt": civitai.get("publishedAt", ""),
            "updatedAt": civitai.get("updatedAt", ""),
            "createdAt": civitai.get("createdAt", ""),
            "nsfwLevel": civitai.get("nsfwLevel"),
            "modelNsfw": civitai_model.get("nsfw"),
            "stats": civitai.get("stats") if isinstance(civitai.get("stats"), dict) else {},
            "allowNoCredit": civitai_model.get("allowNoCredit"),
            "allowCommercialUse": civitai_model.get("allowCommercialUse"),
            "allowDerivatives": civitai_model.get("allowDerivatives"),
            "allowDifferentLicense": civitai_model.get("allowDifferentLicense"),
            "images": images,
            "files": [
                {
                    "id": item.get("id"),
                    "name": item.get("name"),
                    "sizeKB": item.get("sizeKB"),
                    "primary": item.get("primary"),
                    "downloadUrl": item.get("downloadUrl"),
                    "hashes": item.get("hashes") if isinstance(item.get("hashes"), dict) else {},
                }
                for item in files
                if isinstance(item, dict)
            ],
        },
    }


def primary_civitai_file(civitai):
    files = civitai.get("files") if isinstance(civitai.get("files"), list) else []
    for item in files:
        if isinstance(item, dict) and item.get("primary"):
            return item
    for item in files:
        if isinstance(item, dict):
            return item
    return {}


def source_civitai_preview_images(civitai):
    images = civitai.get("images") if isinstance(civitai.get("images"), list) else []
    return [
        {
            "url": image.get("url", ""),
            "nsfwLevel": image.get("nsfwLevel"),
            "width": image.get("width"),
            "height": image.get("height"),
            "type": image.get("type", ""),
            "hash": image.get("hash", ""),
        }
        for image in images
        if isinstance(image, dict)
    ]


def first_primary_file_download(civitai):
    files = civitai.get("files") if isinstance(civitai.get("files"), list) else []
    for item in files:
        if isinstance(item, dict) and item.get("primary") and item.get("downloadUrl"):
            return item["downloadUrl"]
    for item in files:
        if isinstance(item, dict) and item.get("downloadUrl"):
            return item["downloadUrl"]
    return ""


def nested_present(data, keys):
    value = data
    for key in keys:
        if isinstance(key, int):
            if not isinstance(value, list) or len(value) <= key:
                return None
            value = value[key]
            continue
        if not isinstance(value, dict):
            return None
        value = value.get(key)
    return value if value not in (None, "", [], {}) else None


def normalize_words(value):
    if not value:
        return []
    if isinstance(value, str):
        return [{"word": word.strip()} for word in value.split(",") if word.strip()]
    if isinstance(value, list):
        words = []
        for item in value:
            if isinstance(item, dict):
                # Only the word: older records carried per-word origin flags nothing read.
                word = item.get("word")
                if word:
                    words.append({"word": str(word)})
            elif item:
                words.append({"word": str(item)})
        return words
    return []


def normalize_prompts(value):
    if not value:
        return []
    if isinstance(value, str):
        return [{"text": value, "source": "krc"}]
    if isinstance(value, list):
        prompts = []
        for item in value:
            if isinstance(item, dict):
                text = item.get("text") or item.get("prompt")
                if text:
                    prompts.append({**item, "text": str(text)})
            elif item:
                prompts.append({"text": str(item), "source": "krc"})
        return prompts
    return []
