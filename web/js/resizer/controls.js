export function setControlActive(el, active) {
    el.classList.toggle("is-control-active", !!active);
    if (active) {
        const greenMode = el.classList.contains("krc-rz-toggle") && !!el.closest(".krc-rz-mode-row");
        el.style.setProperty("border-color", greenMode ? "transparent" : "rgba(var(--krc-accent-purple-a-rgb), 0.9)", "important");
        el.style.setProperty("color", "var(--krc-text-primary)", "important");
        el.style.setProperty("background", greenMode ? "var(--krc-accent-green)" : "rgba(var(--krc-bg-deeper-rgb), 0.72)", "important");
        if (greenMode) el.style.setProperty("box-shadow", "none", "important");
    } else {
        el.style.removeProperty("border-color");
        el.style.removeProperty("color");
        el.style.removeProperty("background");
        el.style.removeProperty("box-shadow");
    }
}
