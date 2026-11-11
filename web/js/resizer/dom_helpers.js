export function mkEl(tag, css, extra) {
    const el = document.createElement(tag);
    if (css) el.style.cssText = css;
    if (extra) Object.assign(el, extra);
    return el;
}

export function mkBtn(label, css) {
    const b = mkEl("button", `padding:2px 7px;font-size:10px;border:1px solid #444;border-radius:4px;background:#2a2a2a;color:#bbb;cursor:pointer;${css || ""}`);
    b.className = "krc-rz-button krc-rz-small-button";
    b.textContent = label;
    return b;
}
