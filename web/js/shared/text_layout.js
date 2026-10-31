export function bindSingleLineFitLimit(input, onInput) {
  let lastValue = input.value || "";
  const fits = () => !input.clientWidth || input.scrollWidth <= input.clientWidth + 1;

  requestAnimationFrame(() => {
    lastValue = input.value || "";
  });

  input.addEventListener("input", () => {
    const next = input.value || "";
    const shortening = next.length < lastValue.length;
    if (!shortening && !fits()) {
      input.value = lastValue;
      return;
    }
    lastValue = next;
    onInput?.(next);
  });
}

export function softHyphenateName(value, { min = 20, chunk = 14 } = {}) {
  return String(value || "").replace(/[^\s-]+/g, (part) => {
    if (part.length < min) return part;
    const pieces = [];
    for (let i = 0; i < part.length; i += chunk) {
      pieces.push(part.slice(i, i + chunk));
    }
    return pieces.join("\u00ad");
  });
}
