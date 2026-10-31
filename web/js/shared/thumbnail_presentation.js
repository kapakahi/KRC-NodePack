// Display-only framing, shared by static images, video posters and animated previews.
export const INFO_THUMB_MAX_WIDTH = 160;
export const INFO_THUMB_MAX_HEIGHT = 284;

export function applyThumbnailFraming(value) {
  document.documentElement.dataset.krcThumbnailFraming =
    ["fill-top", "fill-center", "fit"].includes(value) ? value : "fill-top";
}

export function infoThumbnailSize(width, height) {
  if (!(width > 0 && height > 0 && Number.isFinite(width) && Number.isFinite(height))) return null;
  const scale = Math.min(INFO_THUMB_MAX_WIDTH / width, INFO_THUMB_MAX_HEIGHT / height);
  return { width: width * scale, height: height * scale };
}

// Bind each actual media element, including the static fallback after a video error.
// Reading a poster's dimensions does not attach or autoplay the video's source.
export function bindInfoThumbnailSize(thumb, media, posterUrl = "") {
  if (!thumb.classList.contains("krc-info-thumb")) return;
  const apply = (width, height) => {
    const size = infoThumbnailSize(width, height);
    if (!size) return;
    thumb.style.setProperty("--krc-info-thumbnail-width", `${size.width}px`);
    thumb.style.setProperty("--krc-info-thumbnail-ratio", `${width} / ${height}`);
  };
  if (media.tagName === "VIDEO") {
    let posterSize = null;
    media.addEventListener("loadedmetadata", () => apply(media.videoWidth, media.videoHeight));
    media.addEventListener("emptied", () => { if (posterSize) apply(...posterSize); });
    if (posterUrl) {
      const poster = new Image();
      poster.onload = () => {
        posterSize = [poster.naturalWidth, poster.naturalHeight];
        if (!media.videoWidth) apply(...posterSize);
      };
      poster.src = posterUrl;
    }
  } else {
    const loaded = () => apply(media.naturalWidth, media.naturalHeight);
    media.addEventListener("load", loaded);
    if (media.complete) loaded();
  }
}
