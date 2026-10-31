// "Where KRC may connect" on the KRC Portal's Options ▸ Network section (public API 1.12):
// NodePack's two lookups, then every loaded KRC pack that declared hosts in its
// krc_pack.json, each with what they're for (GET /krc/network/hosts). Read-only: the
// master switch above it turns all of them off.
import { el } from "./dom.js";
import { api } from "../../../scripts/api.js";

async function loadHosts() {
  try {
    const response = await api.fetchApi("/krc/network/hosts", { cache: "no-store" });
    return response.ok ? (await response.json())?.hosts || [] : null;
  } catch {
    return null;
  }
}

export function networkHostsRow() {
  const wrap = el("div", "krc-setting-row krc-network-hosts");
  wrap.dataset.setting = "KRC.NetworkHosts";
  const head = el("div", "krc-setting-head");
  head.append(el("span", "krc-setting-label", { textContent: "Where KRC may connect" }));
  const list = el("div", "krc-network-host-list");
  list.append(el("div", "krc-options-description krc-setting-desc", { textContent: "Loading…" }));
  wrap.append(head, list);
  loadHosts().then((hosts) => {
    list.replaceChildren();
    if (!hosts) {
      list.append(el("div", "krc-options-description krc-setting-desc", { textContent: "Couldn't load the list." }));
      return;
    }
    for (const entry of hosts) {
      const line = el("div", "krc-network-host");
      line.append(
        el("span", "krc-network-host-owner", { textContent: String(entry.owner || "") }),
        el("span", "krc-network-host-names", { textContent: (entry.hosts || []).join(", ") }),
        el("div", "krc-options-description krc-setting-desc", { textContent: String(entry.why || "") }),
      );
      list.append(line);
    }
  });
  return wrap;
}
