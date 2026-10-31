// One download gesture for the card menu, Info properties and Output node.
import { mediaApi } from "./api.js";

export function downloadMedia(item, { original = false } = {}) {
  if (!item?.id) return;
  const link = Object.assign(document.createElement("a"), {
    href: original ? mediaApi.fileUrl(item.id) : mediaApi.downloadUrl(item.id),
    download: original ? item.filename || item.name || "" : "",
  });
  document.body.append(link);
  link.click();
  link.remove();
}

export function mediaDownloadButton(item) {
  const button = Object.assign(document.createElement("button"), {
    className: "krc-icon-button krc-mio-meta-download",
    type: "button",
    title: item.kind === "video" ? "Download video (stored format)" : "Download image as PNG",
    onclick: () => downloadMedia(item),
  });
  button.setAttribute("aria-label", button.title);
  button.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3v12m-5-5 5 5 5-5M4 16v5h16v-5"/></svg>';
  return button;
}
