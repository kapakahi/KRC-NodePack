// KRC Word Bank — stylesheet loader.
// Links the WordBank CSS bundle as a real <link> rather than injecting a JS
// <style> string. The bundle mirrors LoRA Loadout / Prompt Vault: shared sheets
// first, then split WordBank sheets under word_bank/styles/.
import { ensureStylesheet } from "../shared/stylesheets.js";

const STYLE_VERSION = "1.6.6-shared-1668";

export function injectStyle() {
  return ensureStylesheet("krc-word-bank-style", "../krc_word_bank.css", import.meta.url, { version: STYLE_VERSION, ready: true });
}
