// A short message at the bottom of the page. `action` = { label, onClick } adds one button
// (e.g. an import's Undo): clicking it runs onClick and dismisses the toast.
export function showToast(msg, {
  duration = 2600,
  className = "krc-toast",
  style = "",
  action = null,
} = {}) {
  const toast = document.createElement("div");
  toast.className = className;
  if (style) toast.style.cssText = style;
  if (action?.label) {
    toast.classList.add("has-action");
    const text = document.createElement("span");
    text.textContent = msg;
    const button = document.createElement("button");
    button.type = "button";
    button.className = "krc-toast-action";
    button.textContent = action.label;
    button.addEventListener("click", () => {
      toast.remove();
      action.onClick?.();
    });
    toast.append(text, button);
  } else {
    toast.textContent = msg;
  }
  document.body.append(toast);
  setTimeout(() => toast.remove(), duration);
  return toast;
}
