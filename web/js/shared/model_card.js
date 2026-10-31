import { el } from "./dom.js";
import { pinnedGlyph, thumbnailBox } from "./browser_cards.js";
import { applyCardColorStyle } from "./card_colors.js";
import { createCardNotchButton } from "./card_context_menu.js";
import { softHyphenateName } from "./text_layout.js";

// ── Layer 1: the card primitive ──────────────────────────────────────────────
// Assembles ONE whole card (thumb + name + badges + subtitle) from the shared
// browser fragments, driven entirely by an ItemSource descriptor. It knows nothing
// about browsers, folders, search, virtualization, or any node's panel god-object,
// so the same card renders in a browser grid, a popover, a dropdown, or a drag ghost.
//
// All three view forms (grid / thumb-list / list) share this ONE card DOM; the view
// mode is a container class on the list, not a branch in the card. `opts.viewMode`
// is carried for the caller/CSS but does not fork assembly here.
//
// Canonical structure (Prompt Vault's, chosen 2026-08-21):
//   article.krc-lora-card > [ thumbnailBox, .krc-lora-body > [ .krc-lora-name,
//     .krc-card-meta > [ .krc-badge-row?, .krc-lora-sub ] ], pinnedGlyph? ]
//
// The card is composed of three REGIONS — thumb, body, trailing — each with a browser
// default and an optional whole-region override seam. The browser consumers (PV, LL,
// ML) define none of the override seams, so they get the default assembly byte-for-byte;
// a card with a different shape entirely (Config Switcher's dropdown `ddp-model-card`:
// initials thumb, title-row-with-favourite, notch/remove affordance, no badges) supplies
// its own region seams and reuses nothing it must fight.
//
// ItemSource card seams — only the fields real consumers genuinely diverge on. Each seam
// receives the RAW item; a consumer that overlays a live draft (e.g. PV's unsaved edits)
// merges it INSIDE the seam that needs it, because the draft affects only colour + badges,
// never the name/thumb/subtitle. Passing a pre-merged item down would be wrong for those.
//
// Identity + state:
//   keyOf(item)                   -> identity string (PV: category␟name; LL/ML: sha256)
//   setCardKey(card, item, key)   -> stamp the node's dataset attr (data-pm-key / data-lora-sha)
//   isSelected(item)              -> bool (falls back to opts.selected for stateless callers)
//   isModified(item)              -> bool
//   cardColor(item, modified)     -> colour id/hex ("" = none)
// Root:
//   cardClass(item, opts)         -> root element class (default "krc-lora-card")
//   decorateCard(card, item, opts)-> extra attrs/classes/handlers on the root
// Region — leading (default: none):
//   renderLeading(item, opts)     -> optional left-edge node placed before the
//                                    thumb/body (e.g. a preset slot's enable
//                                    checkbox). Undefined for browser sources.
// Region — thumb (default: shared thumbnailBox from resolveThumbnail):
//   resolveThumbnail(item)        -> { url, previewVideoUrl?, previewImageUrl?, previewMaxSize?, placeholderKind?, blurred?, lazy? }
//   renderThumb(item, opts)       -> override: return the whole thumb node
// Region — body (default: name + meta[badges? + sub]):
//   nameText(item)                -> display label
//   subtitleText(item)            -> meta subtitle line
//   fillBadgeRow(row, item, mod)  -> count of badges appended (0 hides the row)
//   renderBody(item, opts)        -> override: return the whole body node
// Region — trailing (default: pinnedGlyph when isPinned):
//   isPinned(item)                -> bool
//   renderTrailing(item, opts)    -> override: return a trailing node (or null)
// Context menu:
//   hasNotch(item, key, opts)     -> optional per-card notch suppression gate.
//                                    DEFAULT (hook absent): the notch shows on
//                                    every card that has a notchMenu. Return
//                                    false to suppress it for a specific card
//                                    (e.g. drafts, empty/missing slots). Do NOT
//                                    add `() => true` in a caller — that is the
//                                    default; only override to opt out.
//   notchMenu(item, key, context) -> optional menu config, built fresh on open
// Interaction:
//   installInteractions(card, item, key, opts) -> wire click / drag (opts carries
//                                    any per-render context the caller passed)
//
// opts.missing (CARD_MISSING_STATUS_GAMEPLAN.md): the one MISSING look for every source.
// The root gets `is-missing` (red dashed border, components.css) and no card colour, and
// the default body leads its badge row with a red MISSING card badge. A source that
// overrides renderBody adds the badge itself (missingCardBadge).
export function renderModelCard(item, source, opts = {}) {
  const key = source.keyOf(item);
  const selected = source.isSelected?.(item) ?? opts.selected ?? false;
  const modified = source.isModified?.(item) ?? false;
  const missing = Boolean(opts.missing);

  const card = el("div", source.cardClass?.(item, opts) || "krc-lora-card");
  source.setCardKey?.(card, item, key);
  // A browser's shared selection UI uses the source key; drafts are never eligible.
  if (!item.__draft) card.dataset.krcSelectionKey = String(key);
  // A missing card shows the missing look, not its colour.
  applyCardColorStyle(card, missing ? "" : source.cardColor?.(item, modified) || "", { selected });
  if (missing) card.classList.add("is-missing");
  source.decorateCard?.(card, item, opts);

  const leading = source.renderLeading?.(item, opts);
  const thumb = source.renderThumb ? source.renderThumb(item, opts) : defaultThumb(item, source);
  const body = source.renderBody ? source.renderBody(item, opts) : defaultBody(item, source, modified, missing);
  thumb.classList.add("krc-card-thumbnail");
  if (leading) card.append(leading);
  card.append(thumb, body);

  const pinned = !source.renderTrailing && Boolean(source.isPinned?.(item));
  const trailing = source.renderTrailing ? source.renderTrailing(item, opts) : (pinned ? pinnedGlyph() : null);
  if (trailing) card.append(trailing);
  // The pin sits over the card's corner; has-card-pin keeps the text clear of it.
  if (pinned) card.classList.add("has-card-pin");

  const notch = createCardNotchButton({ item, key, source, opts, card });
  if (notch) {
    card.classList.add("krc-card-has-notch");
    card.append(notch);
  }

  source.installInteractions?.(card, item, key, opts);
  return card;
}

function defaultThumb(item, source) {
  const spec = source.resolveThumbnail(item) || {};
  return thumbnailBox({
    url: spec.url || "",
    previewVideoUrl: spec.previewVideoUrl || "",
    previewImageUrl: spec.previewImageUrl || "",
    previewMaxSize: spec.previewMaxSize,
    lazy: spec.lazy !== false,
    placeholderKind: spec.placeholderKind || "image",
    blurred: Boolean(spec.blurred),
  });
}

// The red MISSING card badge (same pill as the card MODIFIED badge).
export function missingCardBadge() {
  return el("span", "krc-card-badge is-missing", {
    textContent: "Missing",
    title: "Not in this machine's library: a run won't find it",
  });
}

function defaultBody(item, source, modified, missing = false) {
  const body = el("div", "krc-lora-body");
  const name = el("div", "krc-lora-name");
  const displayName = source.nameText(item);
  name.textContent = softHyphenateName(displayName);
  name.title = displayName;

  const badges = el("div", "krc-badge-row krc-browser-badges");
  if (missing) badges.append(missingCardBadge());
  const badgeCount = (missing ? 1 : 0) + (source.fillBadgeRow?.(badges, item, modified) || 0);
  const subText = source.subtitleText?.(item) || "";
  const meta = el("div", "krc-card-meta");
  if (badgeCount) meta.append(badges);
  // A source that returns no subtitle (e.g. badges-only preset slots) gets no
  // subtitle row.
  if (subText) meta.append(el("div", "krc-lora-sub", { textContent: subText }));

  body.append(name);
  body.append(meta);
  return body;
}
