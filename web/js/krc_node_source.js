import { app } from "../../scripts/app.js";

// Keeps KRC nodes pasteable. ComfyUI stamps each node's pack in `properties.aux_id`,
// taken from the pack folder's git remote, and the frontend refuses to paste a node whose
// aux_id isn't "github-user/repo-name" (a ZodError). A pack cloned from a non-GitHub
// server gets just "KRC-NodePack.git"; workflows also keep the value from when the
// node was made (e.g. a value from an older pack name). An invalid aux_id is dropped
// from KRC nodes (NodePack and Extras: every "KRC …" type) when they load and whenever
// they're serialized (copy, save); it's optional, so dropping it passes the check. A
// valid one (a GitHub install) is kept.

// The shape the frontend accepts: "user/repo".
const VALID_AUX_ID = /^[a-zA-Z0-9-_]+\/[a-zA-Z0-9-_.]+$/;

function cleanAuxId(properties) {
  if (!properties || typeof properties !== "object" || !("aux_id" in properties)) return;
  if (!VALID_AUX_ID.test(String(properties.aux_id ?? ""))) delete properties.aux_id;
}

function isKrcNode(nodeData) {
  return String(nodeData?.name || "").startsWith("KRC ");
}

app.registerExtension({
  name: "KRC.NodeSource",
  beforeRegisterNodeDef(nodeType, nodeData) {
    if (!isKrcNode(nodeData)) return;
    const onSerialize = nodeType.prototype.onSerialize;
    nodeType.prototype.onSerialize = function (data, ...rest) {
      const result = onSerialize?.apply(this, [data, ...rest]);
      cleanAuxId(data?.properties);
      cleanAuxId(this.properties);
      return result;
    };
    const onConfigure = nodeType.prototype.onConfigure;
    nodeType.prototype.onConfigure = function (...args) {
      const result = onConfigure?.apply(this, args);
      cleanAuxId(this.properties);
      return result;
    };
  },
  nodeCreated(node) {
    if (String(node?.type || node?.comfyClass || "").startsWith("KRC ")) cleanAuxId(node.properties);
  },
});
