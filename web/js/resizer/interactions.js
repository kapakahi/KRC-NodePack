import {
  openKrcModal,
  buildNodePaletteField,
  applyNodePalette,
} from "./krc.js";
import { wireFrameControls } from "./frame_controls.js";
import { wireMaskControls } from "./mask_controls.js";
import { wireTransformControls } from "./transform_controls.js";
import { wireCropControls } from "./crop_controls.js";
import { wireOutputControls } from "./output_controls.js";
import { wirePadControls } from "./pad_controls.js";

export function wireInteractions(st, dom, widgets, node, nodeId) {
    // Options (⚙): the Resizer has no export/import, so its dialog is just the
    // shared per-node palette picker. Restore any saved palette on (re)load.
    applyNodePalette(node, dom.root);
    dom.optionsBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        openKrcModal({
            node,
            title: "Resizer options",
            body: [buildNodePaletteField({ node, root: dom.root })],
        });
    });

    const { stopPlayback } = wireFrameControls(st, dom, widgets, node, nodeId);

    wireCropControls(st, dom, widgets, node);

    wireOutputControls(st, dom, widgets, node);

    wireTransformControls(st, dom, widgets, node, { stopPlayback });

    wireMaskControls(st, dom, widgets, node);

    wirePadControls(st, dom, widgets, node);
}
