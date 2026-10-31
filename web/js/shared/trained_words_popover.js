import { copyText } from "./clipboard.js";
import { armConfirmButton } from "./confirm_action.js";
import { stopCanvasEvents } from "./dom.js";
import { modalPaletteIdForNode } from "./node_palette.js";

function clampPopoverPosition({ popover, anchor, root, close }) {
  if (!anchor?.isConnected) {
    close(false);
    return;
  }
  const rootRect = root.getBoundingClientRect();
  const anchorRect = anchor.getBoundingClientRect();
  const width = 260;
  const height = popover.offsetHeight || 76;
  const margin = 8;
  const scaleX = rootRect.width / (root.offsetWidth || rootRect.width || 1);
  const scaleY = rootRect.height / (root.offsetHeight || rootRect.height || 1);
  const rootWidth = root.clientWidth || rootRect.width / scaleX;
  const rootHeight = root.clientHeight || rootRect.height / scaleY;
  const anchorLeft = (anchorRect.left - rootRect.left) / scaleX;
  const anchorTop = (anchorRect.top - rootRect.top) / scaleY;
  const anchorBottom = (anchorRect.bottom - rootRect.top) / scaleY;
  const left = Math.min(Math.max(margin, anchorLeft), Math.max(margin, rootWidth - width - margin));
  const belowTop = anchorBottom + 6;
  const aboveTop = anchorTop - height - 6;
  const top = belowTop + height <= rootHeight - margin ? belowTop : Math.max(margin, aboveTop);
  popover.style.left = `${left}px`;
  popover.style.top = `${top}px`;
}

export function openTrainedWordPopover({
  root,
  node,
  anchor,
  value = "",
  title = "Trained Word",
  canDelete = false,
  onCommit = () => {},
  onDelete = () => {},
  onClose = () => {},
} = {}) {
  let closed = false;
  let confirmClear = null;

  const popover = document.createElement("div");
  popover.className = "krc-trained-word-popover";
  popover.setAttribute("role", "dialog");
  popover.setAttribute("aria-label", title);
  const themeId = modalPaletteIdForNode(node);
  if (themeId) popover.dataset.krcTheme = themeId;
  stopCanvasEvents(popover);

  const titleEl = document.createElement("div");
  titleEl.className = "krc-trained-word-popover-title";
  titleEl.textContent = title;

  const row = document.createElement("div");
  row.className = "krc-trained-word-popover-row";

  const input = document.createElement("input");
  input.className = "krc-trained-word-input";
  input.type = "text";
  input.value = String(value || "");
  input.setAttribute("aria-label", title);
  stopCanvasEvents(input);

  const copy = document.createElement("button");
  copy.className = "krc-trained-word-action krc-trained-word-copy";
  copy.type = "button";
  copy.textContent = "COPY";
  copy.title = "Copy trained word";
  copy.addEventListener("click", (event) => {
    event.stopPropagation();
    copyText(input.value);
    input.focus();
    input.select();
  });

  const clear = document.createElement("button");
  clear.className = "krc-trained-word-action krc-trained-word-clear";
  clear.type = "button";
  clear.textContent = "X";
  clear.title = canDelete ? "Clear trained word" : "Clear text";

  const close = (confirm = true) => {
    if (closed) return;
    closed = true;
    confirmClear?.dispose?.();
    document.removeEventListener("pointerdown", onDocumentPointerDown, true);
    document.removeEventListener("keydown", onDocumentKeyDown, true);
    window.removeEventListener("resize", positionPopover);
    if (confirm) onCommit(input.value.trim());
    popover.remove();
    onClose({ popover });
  };

  const deleteAndClose = () => {
    if (closed) return;
    closed = true;
    confirmClear?.dispose?.();
    document.removeEventListener("pointerdown", onDocumentPointerDown, true);
    document.removeEventListener("keydown", onDocumentKeyDown, true);
    window.removeEventListener("resize", positionPopover);
    onDelete();
    popover.remove();
    onClose({ popover });
  };

  confirmClear = armConfirmButton(clear, {
    armedText: "Clear?",
    armedTitle: canDelete ? "Confirm trained word removal" : "Confirm clear",
    restoreText: "X",
    restoreTitle: clear.title,
    stopPropagation: true,
    shouldArm: () => canDelete || !!input.value.trim(),
    onConfirm: () => {
      if (canDelete) deleteAndClose();
      else {
        input.value = "";
        input.focus();
      }
    },
  });

  row.append(input, copy, clear);
  popover.append(titleEl, row);

  const onDocumentPointerDown = (event) => {
    if (popover.contains(event.target) || event.target === anchor) return;
    close(true);
  };
  const onDocumentKeyDown = (event) => {
    if (event.key === "Enter" && popover.contains(event.target)) {
      event.preventDefault();
      close(true);
    } else if (event.key === "Escape") {
      event.preventDefault();
      close(false);
    }
  };
  const positionPopover = () => clampPopoverPosition({ popover, anchor, root, close });

  root.append(popover);
  positionPopover();
  window.addEventListener("resize", positionPopover);
  setTimeout(() => {
    if (closed) return;
    document.addEventListener("pointerdown", onDocumentPointerDown, true);
    document.addEventListener("keydown", onDocumentKeyDown, true);
  }, 0);
  input.focus();
  input.select();

  return { popover, close, input };
}
