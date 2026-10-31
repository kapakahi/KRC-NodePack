// The 1:1 media preview the Presets page and the KRC Media Loader share: fit to the box; a
// still is the image, a video its poster that plays while hovered (NodePack's thumbnailBox,
// as the Model Library / Prompt Vault InfoPanels do). `full` shows a still at full size
// (the Media); otherwise the 384px card thumbnail (a node on the canvas).
// Also the items cache the nodes read (kind and name per id; the Media reloads its own).
import { registerThumbnailPreview, subscribeKrcSync, thumbnailBox } from "./krc.js";
import { watchPreviewVisibility } from "./preview_visibility.js";
import { mediaDisplayState } from "./display.js";
import { MEDIA_EVENT, mediaApi } from "./api.js";

const el = (tag, className = "", props = {}) => Object.assign(document.createElement(tag), className ? { className } : {}, props);

// Sound on hover (the previews' speaker toggle; off by default, remembered in this browser).
const SOUND_KEY = "krc-media.preview-sound";
export function previewSound() {
  try {
    return localStorage.getItem(SOUND_KEY) === "1";
  } catch {
    return false;
  }
}
function setPreviewSound(on) {
  try {
    localStorage.setItem(SOUND_KEY, on ? "1" : "0");
  } catch {
    // not remembered
  }
}

// Shared node-only corner marker; reuse NodePack's image/video glyphs without a new icon set.
export function addMediaTypeIndicator(box, kind, dimensions = {}) {
  const indicator = thumbnailBox({ className: "krc-mio-media-type", placeholderKind: kind === "video" ? "video" : "image" });
  indicator.setAttribute("role", "img");
  indicator.setAttribute("aria-label", kind === "video" ? "Video" : "Image");
  const resolution = el("span", "krc-mio-media-resolution");
  resolution.hidden = true;
  const showResolution = (width, height) => {
    if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return;
    resolution.textContent = `${Math.round(width)} × ${Math.round(height)}`;
    resolution.setAttribute("aria-label", `Resolution: ${Math.round(width)} by ${Math.round(height)}`);
    resolution.hidden = false;
  };
  showResolution(dimensions.width, dimensions.height);
  // Pending local uploads have no server record yet. Capture intrinsic dimensions
  // once decoded; never replace known source dimensions with a fallback poster's.
  const decoded = event => {
    if (!resolution.hidden) return;
    const media = event.target;
    showResolution(media.videoWidth || media.naturalWidth, media.videoHeight || media.naturalHeight);
  };
  box.addEventListener("load", decoded, true);
  box.addEventListener("loadedmetadata", decoded, true);
  box.append(resolution, indicator);
  return indicator;
}

// `playOnce`: a video plays once when shown, then rests, and loops while hovered (as the
// Model Library / Prompt Vault thumbnails); otherwise it only plays while hovered.
// `sound`: a speaker toggle, handed back as `box.soundToggle` for the page to place outside
// the box (a video with sound only); with it on, the sound plays only while the box is
// hovered. A browser that won't start sound from a hover (Safari can refuse) keeps it
// playing muted.
export function mediaPreview(item, { full = false, empty = "Empty", className = "", playOnce = false, sound = false, showNsfw = undefined, typeIndicator = false, muted = null, autoplay = null, holdPreview = false } = {}) {
  const box = el("div", `krc-mio-preview${className ? ` ${className}` : ""}`);
  if (!item?.id) {
    box.append(el("span", "krc-mio-preview-label", { textContent: empty }));
    return box;
  }
  if (typeIndicator) addMediaTypeIndicator(box, item.kind, item);
  const visibility = mediaDisplayState(item, showNsfw);
  if (visibility.hidden || visibility.blurred) {
    box.append(thumbnailBox({ className: "krc-mio-preview-thumb", url: visibility.hidden ? "" : mediaApi.thumbUrl(item.id), blurred: visibility.blurred, placeholderKind: "nsfw" }));
    return box;
  }
  let holding = false;
  if (item.kind === "video") {
    let visible = false;
    let disposed = false;
    let stopWatching = null;
    let visibleChanged = () => {};
    const cleanups = [];
    const timers = new Set();
    const listen = (target, type, handler, options) => {
      target?.addEventListener?.(type, handler, options);
      cleanups.push(() => target?.removeEventListener?.(type, handler, options));
    };
    const later = (handler, delay) => {
      const id = setTimeout(() => { timers.delete(id); if (!disposed && visible) handler(); }, delay);
      timers.add(id);
    };
    const cancelTimers = () => { for (const id of timers) clearTimeout(id); timers.clear(); };
    const dispose = () => {
      if (disposed) return;
      disposed = true; visible = false;
      stopWatching?.(); cancelTimers();
      for (const cleanup of cleanups) cleanup();
      const media = box.querySelector("video");
      if (media) { media.muted = true; media.pause(); }
    };
    if (full) {
      // The card poster is only 384px. Node/Info previews display the original
      // video's first decoded frame at rest, with no second encode or poster resize.
      const automatic = () => typeof autoplay === "function" && autoplay();
      const media = el("video", "krc-mio-preview-media", {
        muted: true, autoplay: false, loop: false, playsInline: true, preload: "metadata", controls: false,
      });
      let hovering = false;
      let once = playOnce && typeof autoplay !== "function";
      let sourceAttached = false;
      const play = () => { if (!disposed && visible && !holding) media.play?.()?.catch?.(() => {}); };
      const suspend = () => { media.autoplay = false; media.preload = "metadata"; media.muted = true; media.pause(); };
      const rest = () => {
        media.pause();
        media.loop = false;
        try { media.currentTime = 0; } catch { /* The first frame may not be decoded yet. */ }
      };
      box.syncPreviewPlayback = ({ reset = true } = {}) => {
        if (disposed || !visible || holding) { suspend(); return; }
        media.autoplay = automatic();
        if (automatic() || hovering || once) { media.loop = automatic() || hovering; play(); }
        else if (reset) rest();
      };
      visibleChanged = shown => {
        if (!shown) { hovering = false; suspend(); return; }
        // Keep the original source and position after the first visible load.
        media.preload = "auto";
        if (!sourceAttached) {
          sourceAttached = true;
          media.src = mediaApi.fileUrl(item.id);
        }
        hovering = box.matches(":hover");
        box.syncPreviewPlayback({ reset: false });
      };
      listen(box, "mouseenter", () => { hovering = true; once = false; box.syncPreviewPlayback(); });
      listen(box, "mouseleave", () => {
        hovering = false;
        media.muted = true;
        box.syncPreviewPlayback();
      });
      listen(media, "ended", () => { once = false; box.syncPreviewPlayback(); });
      listen(media, "loadeddata", () => box.syncPreviewPlayback({ reset: false }));
      // A pending play promise/readiness event must not restart a hidden preview.
      for (const type of ["play", "playing"]) listen(media, type, () => { if (!visible || disposed || holding) suspend(); });
      listen(media, "error", () => {
        dispose();
        media.removeAttribute("src"); media.load?.(); media.remove();
        box.append(el("img", "krc-mio-preview-media", { src: mediaApi.thumbUrl(item.id), alt: "", draggable: false }));
      }, { once: true });
      box.append(media);
    } else {
      box.append(thumbnailBox({
        className: "krc-mio-preview-thumb",
        url: mediaApi.fileUrl(item.id),
        mediaType: "video",
        playOnHover: true,
        playOnce,
        posterUrl: mediaApi.thumbUrl(item.id),
        placeholderKind: "video",
      }));
    }
    if ((sound || typeof muted === "function") && item.audio !== false) {
      const audible = () => typeof muted === "function" ? !muted() : previewSound();
      const video = () => box.querySelector("video");
      const allowed = () => !disposed && !holding && visible && audible() && box.isConnected && box.matches(":hover")
        && document.visibilityState !== "hidden" && document.hasFocus?.() !== false;
      const gate = () => { const media = video(); if (media && !allowed() && !media.muted) media.muted = true; };
      // Autoplay never grants sound. Recheck the hover gate on playback/volume changes.
      for (const type of ["play", "playing", "volumechange"]) listen(video(), type, gate);
      // The shared thumbnail begins playback on hover. Respect autoplay restrictions:
      // if sound is refused, retain muted playback instead of stopping the preview.
      const unmute = () => later(() => {
        const media = video();
        if (!media || !allowed()) { gate(); return; }
        media.muted = false;
        later(() => {
          if (allowed() && media.paused) {
            media.muted = true;
            media.play?.()?.catch?.(() => {});
          }
        }, 150);
      }, 60);
      box.syncPreviewSound = () => {
        const media = video();
        if (media && !allowed()) media.muted = true;
        else if (allowed()) unmute();
      };
      listen(box, "mouseenter", unmute);
      listen(box, "mouseleave", () => { const media = video(); if (media) media.muted = true; });
      if (sound) {
        const toggle = el("button", "krc-icon-button krc-mio-sound", { type: "button" });
        toggle.append(el("span", "krc-mio-speaker-glyph"));
        const show = () => {
          const on = previewSound();
          toggle.classList.toggle("is-on", on);
          toggle.title = on ? "Sound on hover: on (click to mute)" : "Sound on hover: off (click to hear it while hovering the preview)";
        };
        show();
        toggle.addEventListener("click", event => {
          event.stopPropagation();
          setPreviewSound(!previewSound());
          show();
          box.syncPreviewSound();
        });
        box.soundToggle = toggle;
      }
    }
    const player = box.querySelector("video");
    if (player) {
      player._krcDisposeMedia = dispose;
      if (!full) {
        // Keep play-once unconsumed until the thumbnail is actually visible.
        player._krcSuspendThumbnail?.();
        visibleChanged = shown => {
          if (shown) player._krcResumeThumbnail?.();
          else { player.muted = true; player.pause(); player._krcSuspendThumbnail?.(); }
        };
        for (const type of ["play", "playing"]) listen(player, type, () => { if (!visible || disposed || holding) player.pause(); });
      }
      stopWatching = watchPreviewVisibility(box, (shown, reason) => {
        if (disposed) return;
        if (reason === "blur") { cancelTimers(); player.muted = true; return; }
        visible = shown;
        if (!shown) { cancelTimers(); player.muted = true; }
        visibleChanged(shown);
      });
    }
  } else {
    box.append(el("img", "krc-mio-preview-media", {
      src: full ? mediaApi.fileUrl(item.id) : mediaApi.thumbUrl(item.id), alt: "", loading: "lazy", draggable: false,
    }));
  }
  if (holdPreview) {
    registerThumbnailPreview(box, {
      url: mediaApi.thumbUrl(item.id),
      imageUrl: item.kind === "video" ? "" : mediaApi.fileUrl(item.id),
      videoUrl: item.kind === "video" ? mediaApi.fileUrl(item.id) : "",
      viewport: true,
      muted: () => item.audio === false || !(typeof muted === "function" ? !muted() : sound && previewSound())
        || !box.matches(":hover") || document.visibilityState === "hidden" || document.hasFocus?.() === false,
      onOpen: () => {
        holding = true;
        const player = box.querySelector("video");
        if (player) { player.muted = true; player.pause(); }
      },
      onClose: () => {
        holding = false;
        if (!box.isConnected) return;
        box.syncPreviewPlayback?.({ reset: false });
        box.syncPreviewSound?.();
      },
    });
  }
  return box;
}

// { id: item } of the Media, fetched once and again after any Media change; `onChange`
// listeners re-render when a fetch lands with something new.
let cache = null;
let loading = null;
const listeners = new Set();

let drawnJson = null;
function fetchItems() {
  // A read already in flight may predate the change that asked for this one: queue one more.
  if (loading) return loading.then(() => (loading ? loading : fetchItems()));
  loading = mediaApi.list()
    .then((payload) => {
      cache = Object.fromEntries((payload.items || []).map((item) => [item.id, item]));
      return true;
    })
    .catch((error) => {
      console.warn(`[KRC Media] couldn't read Media: ${error?.message || error}`);
      cache ||= {};
      return false;
    })
    .finally(() => {
      loading = null;
      // Listeners hear only about a real change (an echo of our own edit redraws nothing).
      const json = JSON.stringify(cache);
      if (json === drawnJson) return;
      drawnJson = json;
      for (const listener of listeners) listener();
    });
  return loading;
}

subscribeKrcSync(MEDIA_EVENT, () => fetchItems());
window.addEventListener("krc-global-nsfw-default-changed", () => { for (const listener of listeners) listener(); });

// The item for `id` (null when unknown or still loading; the first call starts the fetch).
// An id the cache doesn't know re-reads once (at most every 2 s): an upload's item can be put
// into a slot just before the Media's own change event arrives.
let lastMiss = 0;
export function mediaItem(id) {
  if (!cache && !loading) fetchItems();
  const item = (id && cache?.[id]) || null;
  if (id && cache && !item && !loading && Date.now() - lastMiss > 2000) {
    lastMiss = Date.now();
    fetchItems();
  }
  return item;
}

// Every item (empty while the first read is in flight).
export function mediaItems() {
  if (!cache && !loading) fetchItems();
  return Object.values(cache || {});
}

// Whether the items have been read once (so an unknown id means deleted, not loading).
export const mediaLoaded = () => cache !== null;

export function onMediaItems(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

// Explicit refresh after an execution response, before discarding provisional records.
export const refreshMediaItems = fetchItems;
