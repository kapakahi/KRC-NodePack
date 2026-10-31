import { app } from "../../scripts/app.js";
import { installCivitaiBatchBridge } from "./shared/civitai_batch_client.js";

// Installs the Civitai batch-fetch websocket bridge on every page at load: the batch
// job is server-wide, so a run started from any browser must still reconverge this
// page's LoRA Loadout / Model Library nodes (id promotions mid-run, one library
// refresh when it finishes) — not only on pages that opened the Portal's Civitai
// Fetch page. Listening costs nothing until a run emits events.
app.registerExtension({
  name: "KRC.CivitaiBatchBridge",
  setup() {
    installCivitaiBatchBridge();
  },
});
