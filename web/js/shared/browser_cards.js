import { registerThumbnailPreview } from "./thumbnail_preview.js";
import { bindInfoThumbnailSize } from "./thumbnail_presentation.js";
import { el, localImageUrl } from "./dom.js";
import { browserViewClass } from "./browser_views.js";

export function browserCountText(visible, total) {
  return `${visible} visible · ${total} total`;
}

export function browserEmptyNote(text, className = "krc-empty-note") {
  return el("div", `${className} krc-browser-empty-note`, { textContent: text });
}

// Cold-start placeholder grid (Perceived Loading gameplan, Stage 3): shown in
// place of the empty note while the very first scan runs with no snapshot to
// paint. A self-contained shell with its own grid so it never fights the virtual
// list geometry; sized via the same card-height CSS vars as real cards, and
// matched to the active view (grid / list / thumb-list) so there's no layout
// jump when real cards replace it. Purely decorative — aria-hidden throughout.
// How many skeleton cards to draw for a cold start. A count hint (last known
// library size) caps it so a small library doesn't flash 6 skeletons then
// collapse to 2 real cards; with no hint, a fixed handful fills the viewport.
// Never more than the viewport-fill max — extra skeletons are wasted jank.
const SKELETON_FALLBACK = 6;
const SKELETON_MAX = 8;

export function skeletonCount(hint) {
  const known = Math.floor(Number(hint) || 0);
  return known > 0 ? Math.min(known, SKELETON_MAX) : SKELETON_FALLBACK;
}

// Cold-start skeleton rows for the folder rail (LL/ML) — a handful of shimmer bars
// while folders are still loading, so the rail doesn't read as an empty column. The
// caller appends these into its own .krc-folder-tree (keeping the tree height stable).
export function folderRowSkeletons(count = 6) {
  const frag = document.createDocumentFragment();
  const total = Math.max(1, Math.floor(Number(count) || 0) || 1);
  for (let i = 0; i < total; i += 1) {
    const row = el("div", "krc-folder-skeleton-row");
    row.setAttribute("aria-hidden", "true");
    row.append(el("div", "krc-folder-skeleton-bar"));
    frag.append(row);
  }
  return frag;
}

// Cold-start skeleton chips for the facet strip (PV categories) — varied widths so the
// row reads as pending filters rather than an empty bar. Appended after the fixed chips.
const CHIP_SKELETON_WIDTHS = [52, 68, 44, 60, 76, 48];
export function chipSkeletons(count = 6) {
  const frag = document.createDocumentFragment();
  const total = Math.max(1, Math.floor(Number(count) || 0) || 1);
  for (let i = 0; i < total; i += 1) {
    const chip = el("div", "krc-chip-skeleton");
    chip.setAttribute("aria-hidden", "true");
    chip.style.width = `${CHIP_SKELETON_WIDTHS[i % CHIP_SKELETON_WIDTHS.length]}px`;
    frag.append(chip);
  }
  return frag;
}

export function browserSkeletonShell(view, count) {
  const shell = el("div", `krc-skeleton-shell ${browserViewClass(view)}`);
  shell.setAttribute("aria-hidden", "true");
  const total = Math.max(1, Math.floor(Number(count) || 0) || 1);
  for (let i = 0; i < total; i += 1) {
    const card = el("div", "krc-skeleton-card");
    card.append(el("div", "krc-skeleton-thumb"));
    const lines = el("div", "krc-skeleton-lines");
    lines.append(el("div", "krc-skeleton-line is-wide"), el("div", "krc-skeleton-line"));
    card.append(lines);
    shell.append(card);
  }
  return shell;
}

export function pinnedGlyph({ title = "Pinned" } = {}) {
  const pin = el("span", "krc-card-pin", { title });
  pin.append(el("span", "krc-pin-glyph"));
  return pin;
}

// Themed, currentColor-based placeholder glyphs (styled via CSS to inherit the
// active palette) so they read correctly under any theme, no baked-in colors.
const THUMBNAIL_GLYPHS = {
  image: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="8.5" cy="9" r="1.5"/><path d="M21 15l-5-5-4 4-2-2-4 4"/></svg>',
  video: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="5" width="18" height="14" rx="2"/><path d="M10.5 9l4 3-4 3z" fill="currentColor" stroke="none"/></svg>',
  // Eye-off: a mature preview withheld from the public/anonymous Civitai fetch.
  nsfw: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 3l18 18"/><path d="M10.6 5.1A9.8 9.8 0 0 1 12 5c5 0 9 4.5 10 7-.5 1.2-1.6 2.9-3.3 4.2"/><path d="M6.2 6.7C3.9 8.2 2.5 10.4 2 12c1 2.5 5 7 10 7 1.6 0 3-.4 4.2-1"/><path d="M9.5 9.6a3 3 0 0 0 4.2 4.2"/></svg>',
};

export function placeholderGlyph(kind = "image") {
  const glyph = el("span", `krc-thumb-glyph krc-thumb-glyph-${kind in THUMBNAIL_GLYPHS ? kind : "image"}`);
  glyph.innerHTML = THUMBNAIL_GLYPHS[kind] || THUMBNAIL_GLYPHS.image;
  return glyph;
}

// Release the decoder for any <video> in a subtree before it's detached from the
// DOM. Detaching alone leaves a recently-playing media element holding a decoder
// until GC — and WebKit is the slowest to release it, so arrow-keying through a
// library can pile up live decoders. pause + drop src + load() frees it eagerly.
// Call this on the OUTGOING node right before replaceWith/innerHTML swaps it out.
export function teardownMedia(root) {
  if (!root) {
    return;
  }
  const videos = root.matches?.("video")
    ? [root]
    : Array.from(root.querySelectorAll?.("video") || []);
  for (const video of videos) {
    try { video._krcDisposeMedia?.(); } catch (_) { /* Consumer cleanup cannot block decoder release. */ }
    try {
      video.pause();
      video.removeAttribute("src");
      video.load();
    } catch (_) {
      // A detached/exotic element can throw on load(); releasing is best-effort.
    }
  }
}

export function thumbnailBox({
  className = "krc-lora-thumb",
  url = "",
  lazy = false,
  draggable = null,
  alt = "",
  mediaType = "image",
  playOnHover = false,
  playOnce = false,
  posterUrl = "",
  placeholderKind = "image",
  blurred = false,
  previewVideoUrl = "",
  previewImageUrl = "",
  previewMaxSize = 240,
} = {}) {
  // Only this server's (or the page's own blob / data) images: card data can come from a
  // shared workflow or an imported bundle.
  url = localImageUrl(url);
  posterUrl = localImageUrl(posterUrl);
  const thumb = el("div", className);
  if (!thumb.classList.contains("krc-info-thumb")) {
    registerThumbnailPreview(thumb, { url, videoUrl: localImageUrl(previewVideoUrl), imageUrl: localImageUrl(previewImageUrl), maxSize: previewMaxSize, blurred });
  }
  thumb.classList.toggle("is-nsfw-blurred", !!blurred);
  // Over a blurred thumbnail, overlay the same ⊘ glyph the NSFW button uses
  // (built via CSS pseudo-elements) instead of a "NSFW" text label.
  const appendBlurGlyph = () => {
    if (blurred) thumb.append(el("span", "krc-nsfw-glyph krc-nsfw-blur-glyph"));
  };
  const showPlaceholder = () => {
    thumb.style.removeProperty("--krc-info-thumbnail-width");
    thumb.style.removeProperty("--krc-info-thumbnail-ratio");
    thumb.textContent = "";
    thumb.append(placeholderGlyph(placeholderKind));
    appendBlurGlyph();
  };
  if (!url) {
    showPlaceholder();
    return thumb;
  }

  if (mediaType === "video") {
    if (blurred) {
      if (posterUrl) {
        return thumbnailBox({
          className,
          url: posterUrl,
          lazy,
          draggable,
          alt,
          mediaType: "image",
          placeholderKind,
          blurred,
        });
      }
      showPlaceholder();
      return thumb;
    }
    if (!playOnHover && !playOnce) {
      if (posterUrl) {
        return thumbnailBox({
          className,
          url: posterUrl,
          lazy,
          draggable,
          alt,
          mediaType: "image",
          placeholderKind,
          blurred,
        });
      }
      showPlaceholder();
      return thumb;
    }
    const video = el("video");
    bindInfoThumbnailSize(thumb, video, posterUrl);
    video.muted = true;
    video.playsInline = true;
    video.preload = "metadata";
    video.controls = false;
    if (draggable != null) {
      video.draggable = draggable;
    }
    if (posterUrl) {
      video.poster = posterUrl;
    }
    let sourceAttached = false;
    const attachSource = () => {
      if (sourceAttached) {
        return;
      }
      sourceAttached = true;
      video.src = url;
    };
    const showPoster = () => {
      if (!posterUrl || !sourceAttached) {
        return;
      }
      try {
        video.pause();
        video.removeAttribute("src");
        video.load();
        sourceAttached = false;
      } catch (_) {
        // Media teardown is best-effort; a failed reset should not break cards.
      }
    };
    video.onerror = () => {
      video.remove();
      if (posterUrl) {
        const image = el("img");
        bindInfoThumbnailSize(thumb, image);
        image.alt = alt;
        if (lazy) {
          image.loading = "lazy";
          image.decoding = "async";
        }
        if (draggable != null) {
          image.draggable = draggable;
        }
        image.onerror = () => {
          image.remove();
          showPlaceholder();
        };
        image.src = posterUrl;
        thumb.append(image);
        return;
      }
      showPlaceholder();
    };
    let hovering = false;
    let suspended = false;
    let playedOnce = false;
    const playVideo = () => {
      if (suspended || !thumb.isConnected) return;
      attachSource();
      if (video.readyState < 2) {
        video.addEventListener("canplay", () => {
          if (!suspended && thumb.isConnected) video.play().catch(() => {});
        }, { once: true });
        return;
      }
      video.play().catch(() => {});
    };
    const playSingleLoop = () => {
      if (!playOnce || playedOnce || hovering || suspended || !thumb.isConnected) {
        return;
      }
      playedOnce = true;
      video.loop = false;
      video.currentTime = 0;
      playVideo();
    };
    video._krcSuspendThumbnail = () => {
      suspended = true;
      hovering = false;
      video.loop = false;
      if (posterUrl && sourceAttached) showPoster();
      else video.pause();
    };
    video._krcResumeThumbnail = () => {
      suspended = false;
      playSingleLoop();
    };
    video.addEventListener("mouseenter", () => {
      suspended = false;
      hovering = true;
      video.loop = true;
      if (sourceAttached) {
        video.currentTime = 0;
      }
      playVideo();
    });
    video.addEventListener("mouseleave", () => {
      hovering = false;
      video.loop = false;
      showPoster();
    });
    video.addEventListener("ended", () => {
      if (!hovering) {
        video.loop = false;
        showPoster();
      }
    });
    video.addEventListener("loadedmetadata", playSingleLoop, { once: true });
    if (playOnce || !posterUrl) {
      attachSource();
    }
    thumb.append(video);
    return thumb;
  }

  const image = el("img");
  bindInfoThumbnailSize(thumb, image);
  image.alt = alt;
  if (lazy) {
    image.loading = "lazy";
    image.decoding = "async";
  }
  if (draggable != null) {
    image.draggable = draggable;
  }
  image.onerror = () => {
    image.remove();
    showPlaceholder();
  };
  image.src = url;
  thumb.append(image);
  appendBlurGlyph();
  return thumb;
}

export function refreshBrowserCard({
  key,
  findCard,
  findItem,
  renderCard,
  updateCard,
  cache,
  replace = false,
} = {}) {
  const card = findCard?.(key);
  const item = findItem?.(key);
  if (!card || !item) return false;

  if (replace) {
    const next = renderCard(item);
    card.replaceWith(next);
    cache?.set?.(key, next);
    return true;
  }

  updateCard?.(card, item);
  return true;
}
