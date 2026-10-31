import { stopCanvasEvents } from "./dom.js";

function clampPopoverPosition({ popover, anchor, root, close }) {
  if (!anchor.isConnected) {
    close(false);
    return;
  }
  const rootRect = root.getBoundingClientRect();
  const anchorRect = anchor.getBoundingClientRect();
  const width = 238;
  const height = popover.offsetHeight || 74;
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

export function openNumericPopover({
  root,
  anchor,
  initialValue,
  classes,
  ariaLabel,
  title = "",
  inputMode = "decimal",
  inputAriaLabel,
  slider,
  nudge,
  themeId = "",
  formatValue = (value) => String(value),
  sanitizeInput = (value) => String(value ?? ""),
  isPartialInput = (value) => !value,
  normalizeValue = (value) => value,
  formatChangedInput = true,
  onDraft = () => {},
  onCommit = () => {},
  onCancel = () => {},
  onClose = () => {},
}) {
  let draftValue = normalizeValue(initialValue);
  let closed = false;

  const popover = document.createElement("div");
  popover.className = classes.popover;
  Object.assign(popover.style, {
    width: "min(238px, calc(100% - 16px))",
    minWidth: "0",
    maxWidth: "calc(100% - 16px)",
    height: "auto",
    minHeight: "0",
    background: "var(--krc-popup-bg, var(--krc-bg-deep))",
  });
  popover.setAttribute("role", "dialog");
  popover.setAttribute("aria-label", ariaLabel);
  if (themeId) popover.dataset.krcTheme = themeId;
  stopCanvasEvents(popover);

  let titleEl = null;
  if (title) {
    titleEl = document.createElement("div");
    titleEl.className = classes.title || "";
    titleEl.textContent = title;
    stopCanvasEvents(titleEl);
  }

  const valueInput = document.createElement("input");
  valueInput.className = classes.input;
  valueInput.type = "text";
  valueInput.inputMode = inputMode;
  valueInput.value = formatValue(draftValue);
  valueInput.setAttribute("aria-label", inputAriaLabel);
  stopCanvasEvents(valueInput);

  const sliderInput = document.createElement("input");
  // `krc-range` (components.css) draws the KRC track + thumb; never the browser's slider.
  sliderInput.className = `krc-range${classes.slider ? ` ${classes.slider}` : ""}`;
  sliderInput.type = "range";
  sliderInput.min = String(slider.min);
  sliderInput.max = String(slider.max);
  sliderInput.step = String(slider.step);
  sliderInput.value = String(slider.value(draftValue));
  sliderInput.setAttribute("aria-label", slider.ariaLabel);
  stopCanvasEvents(sliderInput);
  // The filled part of the track (left of the thumb), as a 0..100% custom property.
  const syncSliderFill = () => {
    const min = Number(sliderInput.min), max = Number(sliderInput.max), value = Number(sliderInput.value);
    const fill = max > min ? ((value - min) / (max - min)) * 100 : 0;
    sliderInput.style.setProperty("--krc-range-fill", `${Math.max(0, Math.min(100, fill))}%`);
  };
  syncSliderFill();

  const stepDown = document.createElement("button");
  stepDown.className = classes.nudge;
  stepDown.type = "button";
  stepDown.textContent = "‹";
  stepDown.title = nudge.downTitle;
  if (nudge.downAriaLabel) stepDown.setAttribute("aria-label", nudge.downAriaLabel);
  stopCanvasEvents(stepDown);

  const stepUp = document.createElement("button");
  stepUp.className = classes.nudge;
  stepUp.type = "button";
  stepUp.textContent = "›";
  stepUp.title = nudge.upTitle;
  if (nudge.upAriaLabel) stepUp.setAttribute("aria-label", nudge.upAriaLabel);
  stopCanvasEvents(stepUp);

  const setDraft = (value, { formatInput = true } = {}) => {
    draftValue = normalizeValue(value);
    sliderInput.value = String(slider.value(draftValue));
    syncSliderFill();
    if (formatInput) valueInput.value = formatValue(draftValue);
    onDraft(draftValue);
  };

  const close = (confirm = true) => {
    if (closed) return;
    closed = true;
    document.removeEventListener("pointerdown", onDocumentPointerDown, true);
    document.removeEventListener("keydown", onDocumentKeyDown, true);
    window.removeEventListener("resize", positionPopover);
    if (confirm) {
      const sanitized = sanitizeInput(valueInput.value).trim();
      if (!isPartialInput(sanitized)) {
        const typed = Number(sanitized);
        if (Number.isFinite(typed)) draftValue = normalizeValue(typed);
      }
      onCommit(draftValue, { valueInput, popover });
    } else {
      onCancel({ valueInput, popover });
    }
    popover.remove();
    onClose({ popover });
  };

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

  sliderInput.addEventListener("input", () => setDraft(Number(sliderInput.value)));
  valueInput.addEventListener("input", () => {
    const sanitized = sanitizeInput(valueInput.value);
    if (sanitized !== valueInput.value) valueInput.value = sanitized;
    if (isPartialInput(sanitized)) return;
    const typed = Number(sanitized);
    if (Number.isFinite(typed)) {
      const normalized = normalizeValue(typed);
      setDraft(normalized, { formatInput: formatChangedInput && normalized !== typed });
    }
  });
  valueInput.addEventListener("change", () => {
    const sanitized = sanitizeInput(valueInput.value).trim();
    if (!isPartialInput(sanitized)) setDraft(Number(sanitized));
    else valueInput.value = formatValue(draftValue);
  });
  stepDown.addEventListener("click", (event) => {
    event.stopPropagation();
    setDraft(draftValue - nudge.step);
    valueInput.focus();
    valueInput.select();
  });
  stepUp.addEventListener("click", (event) => {
    event.stopPropagation();
    setDraft(draftValue + nudge.step);
    valueInput.focus();
    valueInput.select();
  });

  const sliderRow = document.createElement("div");
  sliderRow.className = classes.sliderRow;
  sliderRow.append(sliderInput, stepDown, stepUp);
  if (titleEl) popover.append(titleEl);
  popover.append(valueInput, sliderRow);
  root.append(popover);
  positionPopover();
  window.addEventListener("resize", positionPopover);
  setTimeout(() => {
    if (closed) return;
    document.addEventListener("pointerdown", onDocumentPointerDown, true);
    document.addEventListener("keydown", onDocumentKeyDown, true);
  }, 0);
  valueInput.focus();
  valueInput.select();

  return { popover, close, valueInput, slider: sliderInput, setDraft };
}
