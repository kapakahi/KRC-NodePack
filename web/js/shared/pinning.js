/*
 * Shared pin cap for the LoRA Loadout and Prompt Vault browsers.
 *
 * Both nodes cap pinned items at this count and BLOCK (with a toast) once the
 * cap is reached — the user unpins something to make room. Pins are deliberate,
 * so silently evicting the oldest at a high cap would be invisible data loss.
 *
 * SINGLE SOURCE OF TRUTH: the Prompt Vault server reads this number back out
 * of this file (see read_max_pinned() in utils/krc_paths.py), so change it here
 * only. Keep the `MAX_PINNED = <int>` assignment shape below parseable.
 */
export const MAX_PINNED = 50;
