// Single cache-busting token for the shared CSS files (design_tokens.css,
// themes.css, components.css). Every reference — the ensureStylesheet callers
// here AND the static `@import`s in krc_lora_loadout.css / krc_prompt_vault.css / krc_word_bank.css / krc_model_library.css / krc_config_switcher.css
// (and KRC NodePack Extras' bundles, e.g. its krc_resizer.css)
// — must use this exact string so the browser fetches each shared file once
// instead of once per distinct URL. Bump it whenever a shared CSS file changes;
// keep the hardcoded `?v=` in those @import bundles in sync (check_krc_api.py in the
// dev repo flags an Extras bundle that falls behind).
export const SHARED_STYLE_VERSION = "1.6.68";

export function stylesheetHref(relPath, metaUrl, version = "") {
  const href = new URL(relPath, metaUrl).href;
  return version ? `${href}?v=${version}` : href;
}

// Track even non-awaiting callers so a later ready:true caller shares the real
// load/error completion, rather than treating an existing <link> as loaded CSS.
const stylesheetLoads = new WeakMap();
function stylesheetReady(link) {
  if (stylesheetLoads.has(link)) return stylesheetLoads.get(link);
  const loaded = new Promise(resolve => {
    if (link.sheet) { resolve(link); return; }
    const finish = () => {
      link.removeEventListener("load", finish);
      link.removeEventListener("error", finish);
      resolve(link);
    };
    link.addEventListener("load", finish, { once: true });
    link.addEventListener("error", finish, { once: true });
  });
  stylesheetLoads.set(link, loaded);
  return loaded;
}

export function ensureStylesheet(id, relPath, metaUrl, { version = "", ready = false } = {}) {
  const existing = document.getElementById(id);
  if (existing) return ready ? stylesheetReady(existing) : existing;
  const link = document.createElement("link");
  link.id = id;
  link.rel = "stylesheet";
  link.href = stylesheetHref(relPath, metaUrl, version);
  const loaded = stylesheetReady(link);
  document.head.appendChild(link);
  return ready ? loaded : link;
}

// KRC's three shared sheets (tokens, themes, components) as <link>s, from NodePack's own
// folder whatever it's called (a git clone can use any name; the Registry installs it as
// krc-nodepack), so a pack that can't know NodePack's URL (KRC NodePack Extras) gets the same
// files at the same ?v= as every NodePack bundle. Call it before the pack's own sheet, so
// those come later in the cascade. -> a Promise once all three have loaded.
const SHARED_SHEETS = [
  ["krc-shared-design-tokens", "./design_tokens.css"],
  ["krc-shared-themes", "./themes.css"],
  ["krc-shared-components", "./components.css"],
];

export function ensureSharedStylesheets() {
  return Promise.all(SHARED_SHEETS.map(([id, path]) => (
    ensureStylesheet(id, path, import.meta.url, { version: SHARED_STYLE_VERSION, ready: true })
  )));
}

export function ensureStylesheets(items, metaUrl, options = {}) {
  return items.map((item) => ensureStylesheet(item.id, item.path, metaUrl, { ...options, ...item }));
}

// Hide a just-rendered element until a critical CSS rule is ACTUALLY applied to it,
// then reveal — killing the unstyled-flash where a layout paints before its (chained
// `@import`ed) grid sheet lands. A linked stylesheet's `load` event, and a synthetic
// off-DOM probe, can both report "ready" while the real element in its live context
// (e.g. a detached DOM-widget root) is still `display:block`/full-width. So probe the
// REAL element: if it already matches, do nothing (no flicker on warm renders);
// otherwise set inline `visibility:hidden` (keeps layout/measurement intact) and flip
// it back once the computed property matches. Timeout-reveal guards against a rule
// that never matches (e.g. an unexpected surface) so nothing stays hidden.
export function revealWhenStyled(el, { property = "display", value = "grid", timeoutMs = 1800 } = {}) {
  if (!el) return;
  let already = false;
  try {
    already = getComputedStyle(el)[property] === value;
  } catch {
    return; // can't measure — leave the element visible
  }
  if (already) return;
  el.style.visibility = "hidden";
  const start = performance.now();
  const reveal = () => { el.style.visibility = ""; };
  const check = () => {
    if (!el.isConnected) {
      // DOM widgets can be detached during subgraph navigation and reused later.
      // Stop checking, but release our temporary visibility override first.
      reveal();
      return;
    }
    let ok = false;
    try {
      ok = getComputedStyle(el)[property] === value;
    } catch {
      ok = true;
    }
    if (ok || performance.now() - start > timeoutMs) {
      reveal();
    } else {
      requestAnimationFrame(check);
    }
  };
  requestAnimationFrame(check);
}
