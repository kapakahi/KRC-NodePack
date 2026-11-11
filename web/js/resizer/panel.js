import { app } from "../../../scripts/app.js";
import { NODE_CLASS } from "./constants.js";
import { installResizerNode } from "./lifecycle.js";

app.registerExtension({
    name: "KRC.Resizer",
    async beforeRegisterNodeDef(nodeType, nodeData) {
        if (nodeData.name !== NODE_CLASS) return;
        installResizerNode(nodeType);
    },
});
