/*
 * Library heal push (PATH_HEALING_GAMEPLAN.md step 3).
 *
 * When the server rescans because files were moved, added or removed outside KRC (a
 * folder change on browse, or a run-time heal), it sends one "krc-library-healed"
 * websocket event to every open page. This installs the page's single listener and
 * re-publishes the event on the in-page sync bus (KRC_SYNC_EVENTS.LIBRARY_HEALED), where
 * LoRA Loadout, Model Library / the Portal and Config Switcher pick it up.
 */
import { api } from "../../../scripts/api.js";
import { KRC_SYNC_EVENTS, KRC_SYNC_LANES, publishKrcSync } from "./sync_bus.js";

const SERVER_EVENT = "krc-library-healed";
export const LIBRARY_HEAL_SOURCE = "krc-server-heal";
let installed = false;

export function installLibraryHealBridge() {
  if (installed) return;
  installed = true;
  api.addEventListener(SERVER_EVENT, (event) => {
    const heal = event?.detail;
    if (!heal || typeof heal !== "object" || !heal.lineage) return;
    publishKrcSync(KRC_SYNC_EVENTS.LIBRARY_HEALED, {
      source: LIBRARY_HEAL_SOURCE,
      lane: KRC_SYNC_LANES.STRUCTURE,
      heal,
    });
  });
}
