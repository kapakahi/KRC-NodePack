// Resizer DISABLE: ComfyUI's Mute (LiteGraph mode "Never", Ctrl+M) as a MODE chip. A
// disabled Resizer is left out of the run, so whatever only fed it drops out too, and the
// nodes after it get no image (fine for an optional input, an error for a required one).
// The node's mode is the only state: the chip and the dimmed "Disabled" overlay follow it,
// so Ctrl+M, the right-click Mode menu and the chip always agree (checked twice a second).
// Bypass isn't offered: PASSTHROUGH covers "as is".
import { setControlActive } from "./controls.js";

const ALWAYS_MODE = 0;
const NEVER_MODE = 2;
const POLL_MS = 500;
const TITLE_OFF = "Disable: leave this node out of the run (ComfyUI's Mute, Ctrl+M). Nodes after it get no image: fine for an optional input, an error for a required one.";
const TITLE_ON = "Disabled (muted, Ctrl+M): left out of the run. Click to enable.";

/** Wire the DISABLE chip to the node's mode. -> cleanup(). */
export function wireDisable(node, dom) {
    const button = dom.disableBtn;
    let shown = null;
    const sync = () => {
        const disabled = node.mode === NEVER_MODE;
        if (disabled === shown) return;
        shown = disabled;
        setControlActive(button, disabled);
        button.setAttribute("aria-pressed", String(disabled));
        button.title = disabled ? TITLE_ON : TITLE_OFF;
        dom.root.classList.toggle("is-node-disabled", disabled);
    };
    const onClick = (event) => {
        event.stopPropagation();
        node.mode = node.mode === NEVER_MODE ? ALWAYS_MODE : NEVER_MODE;
        node.setDirtyCanvas?.(true, true);
        node.graph?.change?.();
        sync();
    };
    button.addEventListener("click", onClick);
    sync();
    const timer = setInterval(sync, POLL_MS);
    return () => {
        clearInterval(timer);
        button.removeEventListener("click", onClick);
    };
}
