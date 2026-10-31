/*
 * KRC shared InfoPanel shell (Layer 3) — the detail-panel chrome shared by the
 * library nodes' info panels. Third layer of the browser trilogy, after
 * shared/model_card.js (L1) and shared/library_browser.js (L2). See
 * INFOPANEL_COMPONENT_GAMEPLAN.md.
 *
 * Mirrors the browser's shell + descriptor split: `renderInfoPanel(source, record)`
 * owns the panel / header / ▲▼ nav / title and the fixed vertical layout
 * (name, subline, grid[left|right], footer); the node supplies a PanelSource
 * descriptor that renders each kind-specific region. The `kind` field
 * (lora | model | prompt | ...) generalizes Model Library's old `isGenericModel`
 * boolean — one shell, pluggable body, flagged by purpose.
 *
 * PanelSource:
 *   kind           -> "lora" | "model" | "prompt" | ...  (informational; body
 *                     dispatch is via the render* methods below)
 *   title          -> header title text (default "Info Panel")
 *   cycleLabels    -> { prev, next } title/aria text for the ▲▼ nav buttons
 *   onCycle(delta) -> move selection by delta (-1 / +1); omit to hide the nav
 *   renderActions(record) -> action-button row node placed right of the title
 *   renderName(record)    -> editable name-field node
 *   renderSubline(record) -> optional sub-header node (filename / version / date)
 *   renderLeft(record)    -> left grid column (thumbnail + compact meta)
 *   renderRight(record)   -> right grid column (editable fields)
 *   renderFooter(record)  -> optional footer node (identity / hash)
 *   panelClass     -> root panel class (default "krc-panel krc-info")
 */

import { thumbnailBox } from "./browser_cards.js";
import { armConfirmButton } from "./confirm_action.js";

function cycleButton(glyph, label, onClick) {
  const button = document.createElement("button");
  button.className = "krc-icon-button krc-info-cycle";
  button.type = "button";
  button.textContent = glyph;
  button.title = label;
  button.setAttribute("aria-label", label);
  button.addEventListener("click", onClick);
  return button;
}

export function renderInfoPanel(source, record) {
  const panel = document.createElement("section");
  panel.className = source.panelClass || "krc-panel krc-info";

  const header = document.createElement("div");
  header.className = "krc-panel-header";

  const nav = document.createElement("div");
  nav.className = "krc-info-nav";
  if (source.onCycle) {
    const labels = source.cycleLabels || {};
    nav.append(
      cycleButton("▲", labels.prev || "Previous", () => source.onCycle(-1)),
      cycleButton("▼", labels.next || "Next", () => source.onCycle(1)),
    );
  }
  const title = document.createElement("span");
  title.className = "krc-info-title";
  title.textContent = source.title || "Info Panel";
  nav.append(title);

  header.append(nav);
  const actions = source.renderActions?.(record);
  if (actions) {
    header.append(actions);
  }
  panel.append(header);

  const name = source.renderName?.(record);
  if (name) {
    panel.append(name);
  }
  const subline = source.renderSubline?.(record);
  if (subline) {
    panel.append(subline);
  }

  const grid = document.createElement("div");
  grid.className = "krc-info-grid";
  grid.append(source.renderLeft(record), source.renderRight(record));
  panel.append(grid);

  const footer = source.renderFooter?.(record);
  if (footer) {
    panel.append(footer);
  }
  return panel;
}

/*
 * Tombstone kind — the "missing / last-known record" panel shown when a selected
 * item no longer resolves on disk. Shared by LoRA Loadout + Model Library (their
 * renderMissingInfo was byte-identical). `id` is the selected id, `info` the
 * last-known payload (null while loading). The one genuinely node-specific bit is
 * the missing-thumbnail route (each node's own api prefix), which is the
 * `thumbnailUrl` seam; the LoRA-flavored strings are defaults, overridable.
 *
 * TombstoneSource:
 *   title              -> header text (default "⚠ Missing LoRA")
 *   loadingText        -> shown while `info` is null
 *   unknownNote        -> shown when info.known is false
 *   purgeTitle         -> the danger-button tooltip
 *   webmEnabled / webmAutoplay -> animated-thumbnail gating (node state)
 *   thumbnailUrl(id, { animated, poster }) -> the missing-thumbnail URL (node route)
 *   onCopy(text)       -> copy the last-known path
 *   onPurge(id)        -> purge the record's saved metadata
 */
export function renderTombstonePanel(source, id, info) {
  const panel = document.createElement("section");
  panel.className = "krc-panel krc-info krc-info-missing";

  const header = document.createElement("div");
  header.className = "krc-panel-header";
  const title = document.createElement("span");
  title.className = "krc-info-title";
  title.textContent = source.title || "⚠ Missing LoRA";
  header.append(title);
  panel.append(header);

  const body = document.createElement("div");
  body.className = "krc-missing-body";

  if (!info) {
    const loading = document.createElement("div");
    loading.className = "krc-missing-note";
    loading.textContent = source.loadingText || "Looking up last-known details…";
    body.append(loading);
    panel.append(body);
    return panel;
  }

  if (info.known) {
    // Thumbnail (same size as the live info panel) with a read-only,
    // scrollable description box locked to the thumbnail's height beside it.
    const hero = document.createElement("div");
    hero.className = "krc-missing-hero";
    const isVideoThumb = info.thumbnailType === "video";
    const useAnimatedThumb = isVideoThumb && source.webmEnabled;
    const thumb = thumbnailBox({
      className: "krc-info-thumb",
      url: info.hasThumbnail
        ? source.thumbnailUrl(id, { animated: useAnimatedThumb, poster: !useAnimatedThumb && isVideoThumb && info.thumbnailHasPoster })
        : "",
      alt: "Last-known thumbnail",
      mediaType: useAnimatedThumb ? "video" : "image",
      playOnHover: useAnimatedThumb,
      playOnce: useAnimatedThumb && source.webmAutoplay,
      posterUrl: useAnimatedThumb && info.thumbnailHasPoster ? source.thumbnailUrl(id, { poster: true }) : "",
      placeholderKind: info.previewWithheld && !info.hasThumbnail
        ? "nsfw"
        : (isVideoThumb ? "video" : "image"),
    });
    const descCell = document.createElement("div");
    descCell.className = "krc-missing-desc-cell";
    const desc = document.createElement("div");
    desc.className = "krc-missing-desc";
    desc.textContent = info.description || "No description.";
    if (!info.description) {
      desc.classList.add("is-empty");
    }
    descCell.append(desc);
    hero.append(thumb, descCell);
    body.append(hero);
  }

  const name = document.createElement("div");
  name.className = "krc-missing-name";
  name.textContent = info.name || "(unknown name)";
  body.append(name);

  const pathRow = document.createElement("div");
  pathRow.className = "krc-missing-path";
  pathRow.textContent = info.path || info.file || "(no last-known path recorded)";
  pathRow.title = info.path || info.file || "";
  body.append(pathRow);

  const meta = [info.baseModel, info.category].filter(Boolean).join(" · ");
  if (meta) {
    const metaRow = document.createElement("div");
    metaRow.className = "krc-missing-meta";
    metaRow.textContent = meta;
    body.append(metaRow);
  }

  const idRow = document.createElement("div");
  idRow.className = "krc-missing-id";
  idRow.textContent = `id: ${id}`;
  body.append(idRow);

  if (!info.known) {
    const note = document.createElement("div");
    note.className = "krc-missing-note";
    note.textContent = source.unknownNote || "No saved details for this LoRA — only its id is known.";
    body.append(note);
  }

  const actions = document.createElement("div");
  actions.className = "krc-missing-actions";

  const copy = document.createElement("button");
  copy.className = "krc-action-button";
  copy.type = "button";
  copy.textContent = "Copy path";
  copy.disabled = !(info.path || info.file);
  copy.addEventListener("click", () => source.onCopy(info.path || info.file || ""));
  actions.append(copy);

  const purge = document.createElement("button");
  purge.className = "krc-action-button is-danger";
  purge.type = "button";
  purge.title = source.purgeTitle || "Delete this LoRA's saved metadata + thumbnail from the library. Does not touch the preset — remove the stack slot yourself if you want.";
  armConfirmButton(purge, {
    restoreText: "Purge from library",
    onConfirm: () => source.onPurge(id),
  });
  purge.textContent = "Purge from library";
  actions.append(purge);

  panel.append(body, actions);
  return panel;
}
