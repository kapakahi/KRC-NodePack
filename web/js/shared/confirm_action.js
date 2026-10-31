export function armConfirmButton(button, {
  armedText = "Confirm?",
  armedTitle = null,
  restoreText = button.textContent,
  restoreTitle = button.title,
  timeout = 2500,
  className = "is-confirming",
  stopPropagation = false,
  shouldArm = () => true,
  renderText = null,
  onConfirm = () => {},
} = {}) {
  let armed = false;
  let timer = null;
  const setText = (text) => {
    if (renderText) renderText(button, text);
    else button.textContent = text;
  };

  const reset = () => {
    armed = false;
    setText(restoreText);
    if (restoreTitle != null) button.title = restoreTitle;
    button.classList.remove(className);
    clearTimeout(timer);
    timer = null;
  };

  const arm = () => {
    armed = true;
    setText(armedText);
    if (armedTitle != null) button.title = armedTitle;
    button.classList.add(className);
    clearTimeout(timer);
    timer = setTimeout(reset, timeout);
  };

  const handler = (event) => {
    if (stopPropagation) event.stopPropagation();
    if (!shouldArm(event)) {
      reset();
      return;
    }
    if (!armed) {
      arm();
      return;
    }
    reset();
    onConfirm(event);
  };

  button.addEventListener("click", handler);
  return {
    reset,
    dispose() {
      clearTimeout(timer);
      button.removeEventListener("click", handler);
    },
  };
}
