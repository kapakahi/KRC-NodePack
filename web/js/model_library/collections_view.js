/*
 * KRC Model Library — collections view: the read-only Collections viewer (chip strip +
 * member grid) and its chip editor.
 * Mixed onto the panel prototype (panel.js) right after browserMethods.
 */
import { FOLDER_TREE_HEIGHT } from "./constants.js";
import { pinActionButton } from "../shared/browser_controls.js";
import { CARD_COLOR_NONE } from "../shared/card_colors.js";
import { buildColorSwatches } from "../shared/color_swatches.js";
import { el, scheduleFrame } from "../shared/dom.js";
import { chipEditor, chipStripShell, plainChip, splitChip } from "../shared/chip_strip.js";
import {
  collectionById,
  collectionsCache,
  deleteCollection,
  loadCollections,
  renameCollection,
  setCollectionColor,
  setCollectionPinned,
} from "../shared/collections_client.js";

export const collectionsViewMethods = {
  // --- Collections viewer (COLLECTIONS_GAMEPLAN.md step 5) ---------------------------------
  // A read-only browse of the shared Collections store, hosted inside the existing model
  // browser: `this.folder === "__collections__"` is a transient "special folder" (like the
  // home menu) that shows a collection chip strip in the rail slot and the selected
  // collection's members in the grid. Not persisted — a reload returns to a real folder.
  collectionModeActive() {
    return this.folder === "__collections__";
  },

  enterCollectionMode() {
    if (!this.collectionModeActive()) {
      this._returnFolder = this.folder || "__model_home__";
    }
    this.folder = "__collections__";
    this.collectionEditor = null;
    this.invalidateVisibleLoras?.();
    const pick = () => {
      const { collections } = collectionsCache();
      if (!this.activeCollectionId || !collections.some((c) => c.id === this.activeCollectionId)) {
        this.activeCollectionId = collections[0]?.id || "";
      }
    };
    pick();
    this.refreshBrowser?.({ focusSelection: false });
    loadCollections({ force: true }).then(() => {
      if (!this.collectionModeActive()) return;
      pick();
      this.invalidateVisibleLoras?.();
      this.refreshBrowser?.({ focusSelection: false });
    });
  },

  exitCollectionMode() {
    this.collectionEditor = null;
    this.invalidateVisibleLoras?.();
    this.setFolder(this._returnFolder || "__model_home__");
    this.refreshBrowser?.({ focusSelection: false });
  },

  setActiveCollection(id) {
    this.activeCollectionId = String(id || "");
    this._browserSelectionUI?.refresh();
    this.invalidateVisibleLoras?.();
    this.refreshBrowser?.({ focusSelection: false });
  },

  // Jump into the collection viewer focused on a specific collection (the InfoPanel notch's
  // "View" action). Defined only here — LL has no viewer, so its notch omits View until the
  // Portal lands.
  viewCollection(id) {
    this.activeCollectionId = String(id || "");
    this.enterCollectionMode();
  },

  activeCollection() {
    return this.activeCollectionId ? collectionById(this.activeCollectionId) : null;
  },

  collectionMemberMatch(lora) {
    const members = this.activeCollection()?.members || [];
    return members.includes(lora?.sha256);
  },

  renderCollectionChips() {
    const { shell, bg, scroll } = chipStripShell();
    shell.classList.add("krc-collection-strip");
    shell.style.height = `${FOLDER_TREE_HEIGHT}px`;

    // Editing one collection replaces the whole strip with the shared chip editor — same layout
    // as PV's category editor, minus prompt-specific actions.
    if (this.collectionEditor) {
      scroll.classList.add("is-editing");
      scroll.append(this.renderCollectionEditor());
      shell.append(bg, scroll);
      return shell;
    }

    const exit = plainChip({
      label: "‹ FOLDERS",
      value: "__exit__",
      title: "Back to the folder library",
      onSelect: () => this.exitCollectionMode(),
    });
    exit.classList.add("krc-collection-exit-chip");
    scroll.append(exit);

    const { collections } = collectionsCache();
    if (!collections.length) {
      const note = el("div", "krc-collection-empty-note", {
        textContent: "No collections yet — add one from a model's + COLLECTION.",
      });
      scroll.append(note);
    } else {
      for (const collection of collections) {
        const count = (collection.members || []).length;
        scroll.append(splitChip({
          label: collection.name || "Untitled",
          value: collection.id,
          active: collection.id === this.activeCollectionId,
          pinned: !!collection.pinned,
          color: collection.cardColor || "",
          title: `Show ${collection.name || "collection"} · ${count} model${count === 1 ? "" : "s"}`,
          notchTitle: "Collection actions",
          onSelect: (id) => this.setActiveCollection(id),
          onOpenEditor: (id) => this.beginCollectionEdit(id),
        }));
      }
    }
    shell.append(bg, scroll);
    return shell;
  },

  // --- Collection chip editor -------------------------------------------------------------
  // The shared chipEditor (chip_strip.js) — the exact PV category-editor layout, carried over
  // minus the prompt-specific actions/attributes: Collections keep pin + color + rename + delete.
  beginCollectionEdit(id) {
    const collection = collectionById(id);
    if (!collection) return;
    this.collectionEditor = { id, name: collection.name || "" };
    this.refreshBrowser?.({ focusSelection: false });
  },

  cancelCollectionEdit() {
    this.collectionEditor = null;
    this.refreshBrowser?.({ focusSelection: false });
  },

  renderCollectionEditor() {
    const state = this.collectionEditor;
    return chipEditor({
      inputValue: state.name,
      inputTitle: "Collection name",
      attributes: this.renderCollectionAttributes(state),
      actions: [
        { label: "SAVE", title: "Rename collection", className: "is-save", onClick: () => this.commitCollectionRename() },
        { label: state.deleteArm ? "SURE?" : "DELETE", title: "Delete this collection (its models are untouched)", className: "is-danger", confirming: !!state.deleteArm, onClick: () => this.deleteActiveCollection() },
        { label: "EXIT", title: "Close", className: "is-exit", onClick: () => this.cancelCollectionEdit() },
      ],
      onInput: (value) => { state.name = value; state.deleteArm = false; },
      onEnter: () => this.commitCollectionRename(),
      onEscape: () => this.cancelCollectionEdit(),
      onMount: (input) => scheduleFrame(this, "_collectionEditorFocusFrame", () => {
        if (input.isConnected) input.focus();
      }),
    });
  },

  // Attributes row: a pin toggle + the shared color swatches (no NSFW — that is PV-specific).
  renderCollectionAttributes(state) {
    const collection = collectionById(state.id);
    const source = this.metadataSyncSource?.();
    const row = el("div", "krc-chip-editor-attrs");
    const toggles = el("div", "krc-chip-editor-attr-toggles");
    const pin = pinActionButton({
      active: !!collection?.pinned,
      title: collection?.pinned ? "Pinned to top" : "Pin to top",
      onClick: () => {
        // Own-echo of COLLECTIONS_CHANGED is skipped here, so re-render the editor ourselves to
        // reflect the new state (state.name survives — it is bound live via onInput).
        setCollectionPinned(state.id, !collection?.pinned, { source })
          .then(() => { if (this.collectionEditor) this.refreshBrowser?.({ focusSelection: false }); })
          .catch(() => {});
      },
    });
    const swatches = buildColorSwatches({
      selected: collection?.cardColor || CARD_COLOR_NONE,
      onSelect: (id) => {
        setCollectionColor(state.id, id, { source })
          .then(() => { if (this.collectionEditor) this.refreshBrowser?.({ focusSelection: false }); })
          .catch(() => {});
      },
      noneTitle: "No collection color",
      className: "krc-chip-editor-swatches",
    });
    toggles.append(pin);
    row.append(toggles, swatches);
    return row;
  },

  commitCollectionRename() {
    const state = this.collectionEditor;
    if (!state) return;
    const name = String(state.name || "").trim();
    const source = this.metadataSyncSource?.();
    this.collectionEditor = null;
    const done = () => this.refreshBrowser?.({ focusSelection: false });
    // Refresh AFTER the mutation resolves — the store echoes with our own source, so the
    // COLLECTIONS_CHANGED handler skips it and this is the only repaint that runs.
    if (name && name !== (collectionById(state.id)?.name || "")) {
      renameCollection(state.id, name, { source }).then(done, done);
    } else {
      done();
    }
  },

  deleteActiveCollection() {
    const state = this.collectionEditor;
    if (!state) return;
    // First click arms (button shows SURE?); second click deletes. Mirrors PV's staged delete.
    if (!state.deleteArm) {
      state.deleteArm = true;
      this.refreshBrowser?.({ focusSelection: false });
      return;
    }
    const source = this.metadataSyncSource?.();
    deleteCollection(state.id, { source }).then(() => {
      this.collectionEditor = null;
      // The active collection may have been the deleted one — re-pick from the fresh cache.
      const { collections } = collectionsCache();
      if (this.activeCollectionId && !collections.some((c) => c.id === this.activeCollectionId)) {
        this.activeCollectionId = collections[0]?.id || "";
      }
      this.invalidateVisibleLoras?.();
      this.refreshBrowser?.({ focusSelection: false });
    }).catch(() => {});
  },

  // A sibling changed the store (COLLECTIONS_CHANGED) — if we're viewing collections, rebuild
  // the chip strip + member grid (the active collection may have been renamed/emptied/deleted).
  refreshCollectionsView() {
    if (!this.collectionModeActive()) return;
    const { collections } = collectionsCache();
    if (this.activeCollectionId && !collections.some((c) => c.id === this.activeCollectionId)) {
      this.activeCollectionId = collections[0]?.id || "";
    }
    this.invalidateVisibleLoras?.();
    this.refreshBrowser?.({ focusSelection: false });
  },
};
