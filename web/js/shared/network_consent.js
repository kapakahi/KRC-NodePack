import { app } from "../../../scripts/app.js";
import { showToast } from "./toast.js";

// Single global master switch gating ALL outbound network access from KRC nodes
// (e.g. fetching LoRA metadata from Civitai). Default ON; turning it off makes KRC
// do zero external calls. Registered as a ComfyUI
// setting in web/js/krc_theme.js; read here so every network-capable control shares
// one source of truth and one setting id.
export const NETWORK_CONSENT_SETTING_ID = "KRC.Network.AllowInternet";
export const NETWORK_CONSENT_DEFAULT = true;

export function isNetworkAllowed() {
  const modern = app.extensionManager?.setting;
  if (modern?.get) {
    const value = modern.get(NETWORK_CONSENT_SETTING_ID);
    return value === undefined ? NETWORK_CONSENT_DEFAULT : !!value;
  }
  const legacy = app.ui?.settings?.getSettingValue?.(
    NETWORK_CONSENT_SETTING_ID,
    NETWORK_CONSENT_DEFAULT,
  );
  return legacy === undefined ? NETWORK_CONSENT_DEFAULT : !!legacy;
}

// The self-dismissing "it's off" notice, shown when a network action is attempted
// while consent is disabled. No request is made — this resolves entirely
// client-side; the server-side guard (added with the fetch wiring) is the backstop.
export function notifyNetworkDisabled() {
  return showToast(
    "External fetch is disabled. Enable it in KRC Portal → Options → Network.",
    { duration: 3200 },
  );
}
