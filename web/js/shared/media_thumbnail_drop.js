// A Media card (Portal Media, a Media Loader slot, a Media Output history cell) dropped on an
// Info Panel thumbnail becomes that card's thumbnail: its file is fetched and handed to the
// panel's own upload (`onFile`), exactly as if it had been picked with UPLOAD, so the same
// image / video paths, size limits and checks apply.
import { installMediaDropTarget } from "../media/drag.js";
import { mediaApi } from "../media/api.js";
import { mediaItem } from "../media/preview.js";

const EXTENSIONS = { "image/png": ".png", "image/jpeg": ".jpg", "image/webp": ".webp", "image/gif": ".gif",
  "video/webm": ".webm", "video/mp4": ".mp4", "video/quicktime": ".mov" };

async function mediaFile(id) {
  const response = await fetch(mediaApi.fileUrl(id), { cache: "no-store" });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const blob = await response.blob();
  const item = mediaItem(id);
  const type = blob.type || (item?.kind === "video" ? "video/webm" : "image/png");
  const name = item?.name ? `${item.name}${item.ext || EXTENSIONS[type] || ""}` : `media${EXTENSIONS[type] || ""}`;
  return new File([blob], name, { type });
}

// `enabled()` says whether the panel can take a thumbnail now (a saved record is selected);
// `onFile(file)` uploads it; `onError(message)` reports a fetch failure.
export function installMediaThumbnailDrop(element, { enabled = () => true, onFile, onError = () => {} } = {}) {
  installMediaDropTarget(element, {
    enabled,
    onDrop: async (id) => {
      let file;
      try {
        file = await mediaFile(id);
      } catch (error) {
        console.warn(`[KRC Media] couldn't read the dropped media for a thumbnail: ${error?.message || error}`);
        onError("Couldn't read that media file.");
        return;
      }
      await onFile(file);
    },
  });
  element.classList.add("krc-media-thumb-drop");
  return element;
}
