import { closeFloatingMenu, toggleFloatingMenu } from "./floating_menu.js";
import { LOCAL_STATUS } from "./local_status.js";

// The Modified badge for surfaces that don't run the status engine. Discardable (Prompt
// Vault's info panel, the metadata panels and their More Info modal): the shared status
// badge (localStatusBadge: one implementation and size), plus the .krc-modified-badge
// class those slots style it by. Not discardable: the small pill on browser cards.
export function modifiedBadge({
  discardable = false,
  className = "",
  title = discardable ? "Discard unsaved changes" : "",
  onDiscard = null,
} = {}) {
  if (!discardable) {
    const pill = document.createElement("span");
    pill.className = ["krc-modified-badge", className].filter(Boolean).join(" ");
    pill.textContent = "Modified";
    return pill;
  }
  return localStatusBadge({
    copy: { status: LOCAL_STATUS.MODIFIED, badge: { label: "Modified", title, badgeClass: "is-modified" } },
    onDiscard: onDiscard || (() => {}),
    className: ["krc-modified-badge", className].filter(Boolean).join(" "),
  });
}

function badgeText(className, textContent) {
  const span = document.createElement("span");
  span.className = className;
  span.textContent = textContent;
  return span;
}

/**
 * Render a local-status badge (Modified / Stale / Draft) from a localStatusCopy()
 * result (web/js/shared/local_status.js). Returns the badge element, or null when
 * there is nothing to show (a clean surface, or copy.badge === null). Shares the
 * .is-default / .is-hover swap of modifiedBadge, so hovering a discardable badge
 * reveals the discard affordance; the per-status color comes from the badgeClass
 * (is-modified / is-stale / is-draft) the copy carries.
 *
 *   copy       - a localStatusCopy(status, profile) result.
 *   onDiscard  - click handler (badge click discards this node's local values and
 *                returns to the global version). Omit for a static, non-clickable
 *                badge.
 *   discardLabel - hover label for the discard affordance (default "Discard").
 *   className  - extra class(es) for placement (e.g. a slot-specific hook).
 */
export function localStatusBadge({ copy, onDiscard = null, onKeep = null, discardLabel = "Discard", className = "" } = {}) {
  const badgeCopy = copy && copy.badge;
  if (!badgeCopy) return null;

  // Conflict (STATUS_CONFLICT_GAMEPLAN.md): a click asks which to keep (onKeep saves this
  // node's version, onDiscard loads the saved one) instead of discarding; no red hover.
  if (copy.status === LOCAL_STATUS.CONFLICT && typeof onKeep === "function" && typeof onDiscard === "function") {
    const badge = document.createElement("button");
    badge.type = "button";
    badge.className = ["krc-status-badge", badgeCopy.badgeClass, "is-choice", className].filter(Boolean).join(" ");
    badge.textContent = badgeCopy.label;
    if (badgeCopy.title) badge.title = badgeCopy.title;
    badge.setAttribute("aria-haspopup", "menu");
    badge.addEventListener("click", (event) => {
      event.stopPropagation();
      openConflictChoice(badge, { onKeep, onDiscard });
    });
    return badge;
  }

  const discardable = typeof onDiscard === "function";
  const badge = document.createElement(discardable ? "button" : "span");
  badge.className = ["krc-status-badge", badgeCopy.badgeClass, className].filter(Boolean).join(" ");

  if (!discardable) {
    badge.textContent = badgeCopy.label;
    if (badgeCopy.title) badge.title = badgeCopy.title;
    return badge;
  }

  badge.type = "button";
  if (badgeCopy.title) badge.title = badgeCopy.title;
  badge.append(
    badgeText("is-default", badgeCopy.label),
    badgeText("is-hover", discardLabel),
  );
  badge.addEventListener("click", (event) => {
    event.stopPropagation();
    onDiscard(event);
  });
  return badge;
}


// The Conflict badge's popover: Keep my changes / Discard my changes, under the badge.
export function openConflictChoice(anchor, { onKeep, onDiscard } = {}) {
  const menu = document.createElement("div");
  menu.className = "krc-menu-select-menu krc-conflict-choice";
  menu.setAttribute("role", "menu");
  menu.hidden = true;
  const option = (label, title, run) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "krc-menu-select-option";
    button.setAttribute("role", "menuitem");
    button.textContent = label;
    button.title = title;
    button.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      closeFloatingMenu();
      run?.();
    });
    return button;
  };
  menu.append(
    option("Keep my changes", "Save this node's version over the newer saved one.", onKeep),
    option("Discard my changes", "Load the newer saved version into this node.", onDiscard),
  );
  return toggleFloatingMenu(anchor, menu, { align: "right" });
}
