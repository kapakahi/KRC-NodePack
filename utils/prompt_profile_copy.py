"""Copy a loaded prompt into an explicit profile, using the normal save normalizer."""
import copy
import json
import os
import uuid
from contextlib import ExitStack

import server

from .db import connection as db
from .prompt_vault_store import prompts_by_id
from .prompt_vault_thumbnails import copied_thumbnail_files


def copy_prompt_response(store, data, save_normalized):
    if not isinstance(data, dict):
        raise ValueError("Expected a prompt object")
    source_id = data.get("source_id")
    if not isinstance(source_id, str) or not source_id.strip() or len(source_id) > 256:
        raise ValueError("A source prompt ID is required")
    source_id = source_id.strip()
    # The outer file context sees transaction/commit failures too. Files are placed
    # under the writer lock so GC cannot collect an uncommitted copy.
    with ExitStack() as files:
        with db.write() as conn:
            matches = prompts_by_id(source_id)
            match = next((entry for entry in matches if entry[:2] == (data.get("source_category"), data.get("source_name"))), matches[0] if matches else None)
            source = copy.deepcopy(match[2]) if match else {}
            meta = {}
            if match:
                row = conn.execute(
                    "SELECT c.meta FROM prompt_categories c JOIN prompts p "
                    "ON p.profile_id = c.profile_id AND p.category = c.name "
                    "WHERE p.id = ? AND p.category = ? AND p.name = ?", (source_id, match[0], match[1]),
                ).fetchone()
                meta = json.loads(row[0]) if row and row[0] else {}
                if not isinstance(meta, dict):
                    meta = {}
            # Identity, dates and thumbnail facts belong to the fresh record. Unknown
            # source metadata and shared preset links otherwise survive normalization.
            for key in ("id", "dateAdded", "dateModified", "hasThumb", "thumbType", "thumbHasPoster", "thumbnailVersion"):
                source.pop(key, None)
            payload = {**data, "mode": "create", "id": "", "hasThumb": False}
            for key in ("dateAdded", "dateModified", "thumbType", "thumbHasPoster", "thumbnailVersion"):
                payload.pop(key, None)
            payload["nsfw"] = bool(payload.get("nsfw", source.get("nsfw")) or meta.get("nsfw"))
            category_meta = {key: meta[key] for key in ("cardColor", "nsfw") if meta.get(key)}
            response = save_normalized(store, payload, source_record=source, category_meta=category_meta)
            result = response.body if isinstance(response.body, dict) else json.loads(response.body)
            if not result.get("success"):
                return response
            new_id = result["id"]
            copied = files.enter_context(copied_thumbnail_files(source_id if match else None, new_id))
            library = store.load_prompts()
            record = library[result["category"]][result["name"]]
            for key in ("hasThumb", "thumbType", "thumbHasPoster", "thumbnailVersion"):
                record.pop(key, None)
            if copied:
                animated = any(os.path.splitext(path)[1] == ".webm" for path in copied)
                record.update(hasThumb=True, thumbType="video" if animated else "image", thumbnailVersion=uuid.uuid4().hex)
                if animated:
                    record["thumbHasPoster"] = any(os.path.splitext(path)[1] == ".webp" for path in copied)
            store.save_prompts(library)
            result.update(prompts=store.prompts_for_response(library), copied=True, profileId=store.profile_id)
        return server.web.json_response(result)
