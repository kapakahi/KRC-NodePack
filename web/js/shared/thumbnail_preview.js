import { localImageUrl } from "./dom.js";
// One document-level gesture/overlay for browser cards and embedded node cards.
// Registration is weak: recycled/detached cards do not leave per-card listeners.
const sources = new WeakMap();
let enabled = true;
let animated = true;
let dismiss = () => {};
let installed = false;

export function registerThumbnailPreview(thumb, source) {
  sources.set(thumb, { ...source, url: localImageUrl(source.url),
    imageUrl: localImageUrl(source.imageUrl), videoUrl: localImageUrl(source.videoUrl) });
}

export function setThumbnailPreviewEnabled(value) {
  enabled = !!value;
  if (!enabled) dismiss();
}

export function setThumbnailPreviewAnimated(value) {
  animated = !!value;
  dismiss();
}

export function previewBounds(rect, width, height, viewportWidth, viewportHeight, maxSize = 240, viewport = false) {
  const margin = 12;
  if (viewport) {
    const scale = Math.min(Math.max(1, Math.min(viewportWidth * 0.7, viewportWidth - margin * 2)) / width,
      Math.max(1, Math.min(viewportHeight * 0.75, viewportHeight - margin * 2)) / height);
    const w = width * scale, h = height * scale;
    return { width: w, height: h, left: (viewportWidth - w) / 2, top: (viewportHeight - h) / 2 };
  }
  const limit = Math.min(480, Math.max(1, Number(maxSize) || 240));
  const maxWidth = Math.max(1, Math.min(limit, viewportWidth - margin * 2));
  const maxHeight = Math.max(1, Math.min(limit, viewportHeight - margin * 2));
  // Keep generated thumbnails at native resolution; only shrink to fit the bounds.
  const scale = Math.min(1, maxWidth / width, maxHeight / height);
  const w = width * scale, h = height * scale;
  const preferred = rect.right + margin + w <= viewportWidth - margin
    ? rect.right + margin : rect.left - margin - w;
  return {
    width: w, height: h,
    left: Math.max(margin, Math.min(preferred, viewportWidth - margin - w)),
    top: Math.max(margin, Math.min(rect.top + (rect.height - h) / 2, viewportHeight - margin - h)),
  };
}

export function installThumbnailPreview() {
  if (installed) return;
  installed = true;
  let gesture = null;
  let suppressClick = false;
  let suppressTimer;
  const releaseMedia = (media) => {
    if (media?.tagName !== "VIDEO") return;
    media.onerror = null;
    media.onloadedmetadata = null;
    media.pause();
    media.removeAttribute("src");
    media.load();
  };
  const stop = () => {
    if (!gesture) return;
    clearTimeout(gesture.timer);
    cancelAnimationFrame(gesture.frame);
    releaseMedia(gesture.media);
    const previous = gesture;
    gesture.overlay?.remove();
    gesture = null;
    if (previous.active) previous.source.onClose?.();
  };
  dismiss = stop;
  const visible = (thumb) => thumb.isConnected && thumb.getBoundingClientRect().width > 0
    && thumb.getBoundingClientRect().height > 0 && !thumb.classList.contains("is-nsfw-blurred");
  const open = (g) => {
    if (gesture !== g || !enabled || !visible(g.thumb)) return stop();
    g.active = true;
    g.source.onOpen?.();
    suppressClick = true;
    const overlay = document.createElement("div");
    overlay.className = "krc-thumbnail-preview";
    overlay.setAttribute("aria-hidden", "true");
    // Native top layer escapes transformed canvas nodes and Portal/modal stacking.
    overlay.setAttribute("popover", "manual");
    g.overlay = overlay;
    document.body.append(overlay);
    overlay.showPopover?.();
    const position = (width, height) => {
      if (gesture !== g || !(width > 0 && height > 0)) return;
      const bounds = previewBounds(g.thumb.getBoundingClientRect(), width, height, window.innerWidth, window.innerHeight, g.source.maxSize, g.source.viewport);
      for (const [key, value] of Object.entries(bounds)) overlay.style[key] = `${value}px`;
      overlay.classList.add("is-ready");
    };
    const showImage = (src = g.source.imageUrl || g.source.url) => {
      if (gesture !== g) return;
      releaseMedia(g.media);
      if (!src) return stop();
      const image = document.createElement("img");
      g.media = image;
      image.alt = "";
      image.onload = () => position(image.naturalWidth, image.naturalHeight);
      image.onerror = () => {
        if (gesture !== g) return;
        if (src !== g.source.url && g.source.url) showImage(g.source.url);
        else stop();
      };
      overlay.replaceChildren(image);
      image.src = src;
    };
    let audioBlocked = false;
    if (animated && g.source.videoUrl) {
      const video = document.createElement("video");
      g.media = video;
      video.muted = typeof g.source.muted === "function" ? !!g.source.muted() : true;
      video.loop = true;
      video.playsInline = true;
      video.onloadedmetadata = () => position(video.videoWidth, video.videoHeight);
      video.onerror = () => showImage();
      overlay.append(video);
      video.src = g.source.videoUrl;
      video.play().catch(() => {
        if (gesture !== g) return;
        // A browser may reject sound after the hold delay. Keep playback muted
        // rather than losing the video preview entirely.
        audioBlocked = true;
        video.muted = true;
        video.play().catch(() => showImage());
      });
    } else showImage();
    const watch = () => {
      if (gesture !== g) return;
      if (!visible(g.thumb)) return stop();
      if (g.media?.tagName === "VIDEO" && typeof g.source.muted === "function") {
        const muted = audioBlocked || !!g.source.muted();
        if (g.media.muted !== muted) g.media.muted = muted;
      }
      g.frame = requestAnimationFrame(watch);
    };
    watch();
  };
  window.addEventListener("pointerdown", (event) => {
    stop();
    suppressClick = false;
    clearTimeout(suppressTimer);
    if (!enabled || event.button !== 0 || event.isPrimary === false || event.pointerType === "touch") return;
    const thumb = event.composedPath().find((node) => sources.has(node));
    const source = thumb && sources.get(thumb);
    if (!source || source.blurred || !visible(thumb) || !(source.imageUrl || source.url || (animated && source.videoUrl))) return;
    const g = { thumb, source, pointerId: event.pointerId, x: event.clientX, y: event.clientY };
    gesture = g;
    g.timer = setTimeout(() => open(g), 350);
  }, true);
  window.addEventListener("pointermove", (event) => {
    if (!gesture || event.pointerId !== gesture.pointerId) return;
    if (!(event.buttons & 1) || (!gesture.active && Math.hypot(event.clientX - gesture.x, event.clientY - gesture.y) > 6)) stop();
  }, true);
  const release = (event) => {
    if (gesture && event.pointerId !== gesture.pointerId) return;
    stop();
    // Keep capture suppression through the click generated immediately after up.
    clearTimeout(suppressTimer);
    suppressTimer = setTimeout(() => { suppressClick = false; }, 0);
  };
  window.addEventListener("pointerup", release, true);
  window.addEventListener("pointercancel", release, true);
  window.addEventListener("click", (event) => {
    if (!suppressClick) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    suppressClick = false;
  }, true);
  window.addEventListener("dragstart", (event) => {
    if (gesture?.active) {
      event.preventDefault();
      event.stopImmediatePropagation();
    } else stop();
  }, true);
  window.addEventListener("keydown", (event) => { if (event.key === "Escape") stop(); }, true);
  window.addEventListener("blur", stop);
  window.addEventListener("resize", stop);
  window.addEventListener("scroll", stop, true);
  window.addEventListener("wheel", stop, true);
  document.addEventListener("visibilitychange", stop);
}
