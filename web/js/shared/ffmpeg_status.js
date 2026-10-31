/*
 * ffmpeg status — the "Media" cell in KRC's Options (ML node modal + Portal Options
 * page) and the ONE "not found" wording every KRC surface uses.
 * FFMPEG_DETECTION_GAMEPLAN.md §6.
 *
 * The cell shows what the server found (version, capability, path + source, why the
 * automatic pick skipped one, a broken Settings location). "Detect again" asks the
 * server to look afresh without a restart; a saved "ffmpeg location" setting
 * re-detects too and publishes the result here (publishFfmpegCapability).
 */
import { el } from "./dom.js";
import { makeNodeApi } from "./api.js";

const { fetchLora } = makeNodeApi("/krc/lora-loadout");

export const FFMPEG_DOWNLOAD_URL = "https://ffmpeg.org/download.html";
// Same text as NOT_FOUND_MESSAGE in utils/krc_video.py.
export const FFMPEG_NOT_FOUND_MESSAGE =
  "ffmpeg not found. Install it (it must be on PATH), or set its location in KRC Portal ▸ Options ▸ Media.";

const CAPABILITY_EVENT = "krc:ffmpeg-capability";

// → the server's capability ({ffmpeg, poster, webm, …, detection}) or null.
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

// POST the detect route → the fresh capability, or null.
export async function detectFfmpegAgain() {
  try {
    const response = await fetchLora("/ffmpeg/detect", { method: "POST" });
    if (!response.ok) return null;
    const payload = await response.json();
    return payload?.capability || null;
  } catch {
    return null;
  }
}

// A re-detect happened elsewhere (the Settings location was saved) → every open
// Media cell re-renders with it.
export function publishFfmpegCapability(capability) {
  if (capability) window.dispatchEvent(new CustomEvent(CAPABILITY_EVENT, { detail: capability }));
}

// "via imageio-ffmpeg" — empty for plain PATH (the unsurprising case).
export function ffmpegSourceLabel(capability) {
  const source = capability?.detection?.source || "";
  return source && source !== "PATH" ? `via ${source}` : "";
}

function mark(ok) {
  return ok ? "✓" : "✗";
}

function renderStatus(body, capability) {
  body.replaceChildren();
  if (!capability) {
    body.append(el("div", "krc-options-description", { textContent: "Couldn't read the ffmpeg status from the server." }));
    return;
  }
  const detection = capability.detection || null;
  if (detection?.warning) {
    body.append(el("div", "krc-options-description krc-options-warning", { textContent: detection.warning }));
  }
  if (!capability.ffmpeg) {
    const link = el("a", "", { href: FFMPEG_DOWNLOAD_URL, target: "_blank", rel: "noopener noreferrer", textContent: "Get ffmpeg" });
    const note = el("div", "krc-options-description krc-options-warning", { textContent: `${FFMPEG_NOT_FOUND_MESSAGE} ` });
    note.append(link);
    body.append(note);
    return;
  }
  const version = detection?.version ? ` ${detection.version}` : "";
  body.append(el("div", "krc-options-description", {
    textContent: `✓ ffmpeg${version} · posters ${mark(capability.poster)} · animated loops ${mark(capability.webm)}`,
  }));
  if (detection?.path) {
    const source = detection.source ? ` (${detection.source})` : "";
    body.append(el("div", "krc-options-description", { textContent: `${detection.path}${source}` }));
  }
  if (detection?.note) {
    body.append(el("div", "krc-options-description", { textContent: `(${detection.note})` }));
  }
}

// The Options "Media" cell. `section({ title, body })` is the caller's cell builder
// (krcModalSection in the modal, the page variant on the Portal Options page).
export function ffmpegStatusSection(section) {
  const body = el("div", "krc-options-stack-output");
  const status = el("div", "krc-ffmpeg-status");
  status.append(el("div", "krc-options-description", { textContent: "Checking ffmpeg…" }));
  const detect = el("button", "krc-options-reset", {
    type: "button",
    textContent: "Detect again",
    title: "Look for ffmpeg again without restarting ComfyUI",
  });
  detect.addEventListener("click", async () => {
    detect.disabled = true;
    detect.textContent = "Detecting…";
    const capability = await detectFfmpegAgain();
    detect.disabled = false;
    detect.textContent = "Detect again";
    renderStatus(status, capability);
  });
  body.append(status, detect);

  // Listen only while the cell is on screen; drop the listener once it's gone.
  const onPublished = (event) => {
    if (!status.isConnected) {
      window.removeEventListener(CAPABILITY_EVENT, onPublished);
      return;
    }
    renderStatus(status, event.detail);
  };
  window.addEventListener(CAPABILITY_EVENT, onPublished);

  fetchVideoCapability().then((capability) => renderStatus(status, capability));
  return section({ title: "Media", body });
}
