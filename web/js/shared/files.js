export function blobToDataURL(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

// One picker for a thumbnail source: a still image, or an mp4/webm that the server
// transcodes into the constrained animated thumbnail. The caller branches on
// isVideoFile() to route to the image or the video upload path.
export function pickThumbnailFile() {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "image/*,video/mp4,video/webm,.mp4,.webm";
    input.style.display = "none";
    input.addEventListener("change", () => {
      const file = input.files?.[0] || null;
      input.remove();
      resolve(file);
    }, { once: true });
    document.body.append(input);
    input.click();
  });
}

// True when a picked file should go through the video (ffmpeg) path rather than
// the image (PIL) path. Falls back to the extension when the browser gives no MIME.
export function isVideoFile(file) {
  if (!file) return false;
  if (typeof file.type === "string" && file.type.startsWith("video/")) return true;
  return /\.(mp4|webm|mov|m4v|mkv)$/i.test(file.name || "");
}

export async function clipboardImageBlob() {
  if (!navigator.clipboard?.read) {
    throw new Error("clipboard-read-unavailable");
  }
  const items = await navigator.clipboard.read();
  for (const item of items) {
    const type = item.types.find((entry) => entry.startsWith("image/"));
    if (type) {
      return { blob: await item.getType(type), type };
    }
  }
  return null;
}

export async function clipboardImageFile(filename = "pasted-thumbnail") {
  const image = await clipboardImageBlob();
  if (!image) return null;
  return new File([image.blob], filename, { type: image.type });
}
