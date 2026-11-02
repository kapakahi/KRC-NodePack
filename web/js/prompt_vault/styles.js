/*
 * KRC Prompt Vault — stylesheet loader.
 * Links the Prompt Vault CSS bundle as a real <link> rather than injecting a JS
 * <style> string. The bundle mirrors LoRA Loadout: shared sheets first, then
 * split Prompt Vault sheets under prompt_vault/styles/.
 */
import { ensureStylesheet } from "../shared/stylesheets.js";

const STYLE_VERSION = "1.4.5-ui70-shared-1671";

export function injectStyle() {
  return ensureStylesheet("krc-pm-style", "../krc_prompt_vault.css", import.meta.url, { version: STYLE_VERSION, ready: true });
}
