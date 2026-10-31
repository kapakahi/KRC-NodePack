// One adapter for Media cards, preset thumbnails and loader previews.
import {
  NSFW_DISPLAY_MODE_DEFAULT, NSFW_DISPLAY_MODE_SETTING_ID,
  SHOW_NSFW_DEFAULT, SHOW_NSFW_SETTING_ID, nsfwDisplayState, readGlobalSetting,
} from "./krc.js";

// "Show NSFW by default" only seeds an eye (2026-10-29, as in LL / ML / PV).
export const globalShowsNsfw = () => Boolean(readGlobalSetting(SHOW_NSFW_SETTING_ID, SHOW_NSFW_DEFAULT));

// `showNsfw`: the Media tab's own eye, which alone decides. Surfaces without an eye (the
// Loader and Output nodes) leave it out and follow the global option, like the Loadout Kits.
export function mediaDisplayState(item, showNsfw) {
  return nsfwDisplayState(item, {
    showNsfw: typeof showNsfw === "boolean" ? showNsfw : globalShowsNsfw(),
    displayMode: readGlobalSetting(NSFW_DISPLAY_MODE_SETTING_ID, NSFW_DISPLAY_MODE_DEFAULT),
  });
}
