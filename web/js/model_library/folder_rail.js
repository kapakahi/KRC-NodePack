/*
 * KRC Model Library — folder rail: the disk-folder rail: the folder tree with its search
 * match, the in-cell folder config (pin + colour) and the GroupSource seam the shared
 * browser shell reads.
 * Mixed onto the panel prototype (panel.js) right after browserMethods.
 */
import { FOLDER_TREE_HEIGHT, SEARCH_FIELD_ALIASES } from "./constants.js";
import { stopCanvasEvents } from "./helpers.js";
import { folderRowSkeletons } from "../shared/browser_cards.js";
import { pinActionButton } from "../shared/browser_controls.js";
import { cardColorHex, normalizeCardColorId } from "../shared/card_colors.js";
import { buildColorSwatches } from "../shared/color_swatches.js";
import { searchValuesForField } from "../shared/search.js";
import { modelFolderMatch } from "./pure_helpers.js";

export const folderRailMethods = {
  renderFolders() {
    const shell = document.createElement("div");
    shell.className = "krc-folder-shell";

    // Cold start: no folders yet — show skeleton rows so the rail doesn't read as an
    // empty column while the first scan runs (matches the list skeleton timing).
    if ((this.isLoadingLibrary || this._initialLoadPending) && !this.folders.length) {
      const skeleton = document.createElement("div");
      skeleton.className = "krc-folder-tree";
      skeleton.style.height = `${FOLDER_TREE_HEIGHT}px`;
      skeleton.append(folderRowSkeletons(8));
      shell.append(skeleton);
      return shell;
    }

    const tree = document.createElement("div");
    tree.className = "krc-folder-tree";
    tree.style.height = `${FOLDER_TREE_HEIGHT}px`;
    const folderSearchValues = searchValuesForField(this.query, SEARCH_FIELD_ALIASES, "folder");
    const parent = this.activeFolderParent();
    const rows = this.folders.filter((folder) => {
      const folderParent = folder.parent || "__model_home__";
      return folderParent === parent && this.folderMatchesSearch(folder, folderSearchValues);
    }).map((folder) => [
      folder.name,
      folder.label || "",
      folder.count,
      folder.name === this.folder,
      folder.cardColor || "",
      !!folder.pinned,
      !!folder.scope || folder.name === "__model_home__" || folder.name === "__root__",
    ]);

    rows.forEach(([name, displayLabel, count, active, cardColor, pinned, isScopeRow]) => {
      const row = document.createElement("div");
      row.className = `krc-folder-row ${active ? "is-active" : ""} ${pinned ? "is-pinned is-promoted" : ""}`;
      row.dataset.folderName = name;

      const configButton = document.createElement("button");
      configButton.className = "krc-folder-color-button";
      configButton.type = "button";
      configButton.dataset.cardColor = normalizeCardColorId(cardColor);
      const colorHex = cardColorHex(cardColor);
      if (colorHex) {
        configButton.style.setProperty("--krc-folder-color", colorHex);
      }
      if (name === "__model_home__") {
        configButton.classList.add("is-home");
        const homeGlyph = document.createElement("span");
        homeGlyph.className = "krc-folder-home-glyph";
        homeGlyph.textContent = "⌂";
        configButton.append(homeGlyph);
      }
      configButton.disabled = isScopeRow;
      const isOpen = this.folderConfigOpen === name && !isScopeRow;
      if (isScopeRow) {
        configButton.title = name === "__model_home__" ? "Model Library home" : name === "__root__" ? "Root is a browser scope" : "All models is a browser scope";
      } else {
        configButton.classList.toggle("is-open", isOpen);
        configButton.title = `Folder settings for ${name}`;
        configButton.addEventListener("click", (event) => {
          event.stopPropagation();
          this.toggleFolderConfig(name);
        });
      }
      stopCanvasEvents(configButton);

      const label = document.createElement("span");
      label.className = "krc-folder-label";
      const labelText = document.createElement("span");
      labelText.className = "krc-folder-label-text";
      labelText.textContent = displayLabel || (name === "__model_home__" ? "All Models" : name === "__root__" ? "Root" : name);
      label.append(labelText);
      if (pinned && !isScopeRow) {
        const pin = document.createElement("span");
        pin.className = "krc-folder-pin-mark";
        pin.textContent = "📌";
        pin.title = "Pinned to top";
        label.append(pin);
      }

      const badge = document.createElement("span");
      badge.className = "krc-folder-count";
      badge.textContent = count;

      row.addEventListener("click", () => {
        this.setFolder(name);
        this.refreshBrowser({ focusSelection: true });
      });

      row.append(configButton, label, badge);
      tree.append(row);
      if (isOpen) {
        tree.append(this.renderFolderConfigPanel({ name, cardColor, pinned }));
      }
    });

    shell.append(tree);
    return shell;
  },

  folderMatchesSearch(folder, values = []) {
    if (!values.length) {
      return true;
    }
    const name = folder?.name || "";
    const label = `${folder?.label || ""} ${folder?.folder || ""} ${name === "__model_home__" ? "All Models home model library" : name === "__root__" ? "Root root" : name}`;
    return values.every((value) => label.toLowerCase().includes(value));
  },

  activeFolderParent() {
    const current = this.folders.find((folder) => folder.name === this.folder);
    if (current?.parent && current.parent !== "__model_home__") {
      return current.parent;
    }
    if (current?.kind === "type") {
      return current.name;
    }
    return "__model_home__";
  },

  toggleFolderConfig(name) {
    this.folderConfigOpen = this.folderConfigOpen === name ? null : name;
    this.refreshFolderShell({ focusActive: false });
  },

  // Re-render just the folder tree in place (config toggle doesn't touch the list).
  refreshFolderShell({ focusActive = true } = {}) {
    const shell = this.querySurface?.(".krc-folder-shell");
    if (!shell) {
      return;
    }
    const previousFolderScroll = this.folderTreeScrollTop?.();
    shell.replaceWith(this.renderFolders());
    this.restoreFolderTreeScroll?.(previousFolderScroll);
    if (focusActive) {
      this.focusActiveFolder?.();
    }
  },

  // In-cell folder config panel — the KRC-consistent inline equivalent of Prompt
  // Vault's category attributes: a pin toggle + shared color-swatch chips.
  renderFolderConfigPanel(folder) {
    const name = folder.name;
    const panel = document.createElement("div");
    panel.className = "krc-folder-config";
    stopCanvasEvents(panel);

    const pin = pinActionButton({
      active: !!folder.pinned,
      title: folder.pinned ? "Pinned to top" : "Pin to top",
      onClick: () => this.setFolderPin(name, !folder.pinned),
    });

    const swatches = buildColorSwatches({
      selected: normalizeCardColorId(folder.cardColor),
      onSelect: (id) => this.setFolderColor(name, id),
      noneTitle: "No folder color",
    });

    panel.append(pin, swatches);
    return panel;
  },

  // GroupSource seam (Beat 1): the browser shell's single interface to the primary
  // group filter — for Model Library this is the read-only disk-folder rail. The shell
  // renders the rail and reads the active group / group list through this, never
  // through `this.folder` directly. `matches` is ML's model-type/folder predicate
  // (modelFolderMatch) — the one thing that diverged from LL's filter pass, now the
  // seam that lets both share shared/library_filter.js.
  groupSource() {
    if (this._groupSource) return this._groupSource;
    const ctl = this;
    this._groupSource = {
      active: () => ctl.folder,
      setActive: (id) => ctl.setFolder(id),
      groups: () => ctl.folders,
      // Collection mode swaps the disk-folder rail for a collection chip strip and the
      // model-type predicate for a membership check, reusing the whole browser shell.
      render: () => (ctl.collectionModeActive() ? ctl.renderCollectionChips() : ctl.renderFolders()),
      matches: (lora) => (ctl.collectionModeActive()
        ? ctl.collectionMemberMatch(lora)
        : ctl.homeSearchActive() || modelFolderMatch(lora, ctl.folder, ctl.folders)),
    };
    return this._groupSource;
  },
};
