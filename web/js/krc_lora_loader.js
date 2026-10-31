import { app } from "../../scripts/app.js";
import { installCanvasDragSelectionGuard } from "./shared/dom.js";

// KRC LoRA Loadout Loader is a plain canvas node. Its computed default width
// can clip the full title, so nudge freshly-created nodes a little wider. Saved
// workflow sizes and manual resizes are preserved.
const NODE_TYPE = "KRC LoRA Loadout Loader";
const DEFAULT_W = 260;

app.registerExtension({
  name: "KRC.LoraLoadoutLoader",
  setup() {
    installCanvasDragSelectionGuard();
  },
  nodeCreated(node) {
    if ((node.comfyClass ?? node.type) !== NODE_TYPE) return;
    const h = node.size?.[1] ?? node.computeSize()[1];
    if ((node.size?.[0] ?? 0) < DEFAULT_W) node.setSize([DEFAULT_W, h]);
  },
});
