/*
 * Video status — the "Media" cell in KRC's Options (ML node modal + Portal Options page)
 * and the ONE "no video support" wording every KRC surface uses.
 *
 * KRC NodePack runs no ffmpeg program: video thumbnails, Media uploads and the Media
 * nodes use PyAV, the video library ComfyUI itself requires. The cell shows its version
 * and whether it can make posters and animated (VP9) loops.
 */
import { el } from "./dom.js";
import { makeNodeApi } from "./api.js";

const { fetchLora } = makeNodeApi("/krc/lora-loadout");

// Same text as NO_VIDEO_MESSAGE in utils/krc_video.py.
export const NO_VIDEO_MESSAGE = "Video thumbnails need PyAV (av), which this ComfyUI is missing. Update ComfyUI.";

// → the server's capability ({video, poster, webm, webmReason, posterReason, pyav}) or null.
export async function fetchVideoCapability() {
  try {
    const response = await fetchLora("/settings");
    if (!response.ok) return null;
    const payload = await response.json();
    return payload?.capability || null;
  } catch {
    return null;
  }
}

function mark(ok) {
  return ok ? "✓" : "✗";
}

function renderStatus(body, capability) {
  body.replaceChildren();
  if (!capability) {
    body.append(el("div", "krc-options-description", { textContent: "Couldn't read the video status from the server." }));
    return;
  }
  if (!capability.video) {
    body.append(el("div", "krc-options-description krc-options-warning", { textContent: NO_VIDEO_MESSAGE }));
    return;
  }
  body.append(el("div", "krc-options-description", {
    textContent: `✓ PyAV ${capability.pyav || ""} · posters ${mark(capability.poster)} · animated loops and video uploads ${mark(capability.webm)}`,
  }));
  if (!capability.webm) {
    body.append(el("div", "krc-options-description krc-options-warning", {
      textContent: "This PyAV build has no VP9 encoder: cards get static posters, and Media can't take video uploads.",
    }));
  }
}

// The Options "Media" cell. `section({ title, body })` is the caller's cell builder
// (krcModalSection in the modal, the page variant on the Portal Options page).
export function videoStatusSection(section) {
  const status = el("div", "krc-video-status");
  status.append(el("div", "krc-options-description", { textContent: "Checking video support…" }));
  fetchVideoCapability().then((capability) => renderStatus(status, capability));
  return section({ title: "Media", body: status });
}
