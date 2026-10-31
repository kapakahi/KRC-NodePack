// Server -> page sync events (public API 1.11; utils/server_sync.py). The server's
// `krc-sync` message carries { event, payload, lane }; this republishes it on the sync bus
// as if a page had published it: `source: "server"` (never a node's own echo) and
// `refetch: true` (the server's store changed; no page has a fresh copy). Installed once,
// when NodePack's public API loads. Names that don't start with `krc-` are dropped, so a
// server message can only ever raise a KRC event.
import { api } from "../../../scripts/api.js";
import { forgetInFlight } from "./api.js";
import { publishKrcSync } from "./sync_bus.js";
import { PAGE_SYNC_ID } from "./sync_origin.js";

export const SERVER_SYNC_MESSAGE = "krc-sync";
export const SERVER_SOURCE = "server";
const EVENT_RE = /^krc-[a-z0-9][a-z0-9-]{0,62}$/;

let installed = false;

export function republishServerSync(detail) {
  const name = String(detail?.event || "");
  if (!EVENT_RE.test(name)) {
    console.warn(`[KRC Sync] dropped a server event with a bad name: ${name.slice(0, 80)}`);
    return false;
  }
  const payload = detail?.payload && typeof detail.payload === "object" && !Array.isArray(detail.payload) ? detail.payload : {};
  if (payload.originPage === PAGE_SYNC_ID) return false;
  // Receivers re-read the server's store; none may join a read from before the change.
  forgetInFlight();
  publishKrcSync(name, { ...payload, source: SERVER_SOURCE, refetch: true, lane: detail?.lane });
  return true;
}

export function installServerSync() {
  if (installed) return;
  installed = true;
  api.addEventListener(SERVER_SYNC_MESSAGE, (event) => republishServerSync(event?.detail));
}

installServerSync();
