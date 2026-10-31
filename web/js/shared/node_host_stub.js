// NodeHost stub — a minimal fake ComfyUI/LiteGraph node that lets the KRC panel
// classes (Model Library, Prompt Vault) run *detached* from any real graph node,
// so they can be hosted inside the shared library modal (see the universal library
// modal plan). The panels only ever talk to `this.node.*`; because the shared
// widget/markDirty/palette helpers are optional-chaining-safe, a stub that quacks
// like a node is enough — no per-call-site refactor.
//
// Persistence: every hidden-widget value is mirrored into `node.properties[name]`
// by shared/widgets.js (setWidgetValue -> node.setProperty; hiddenWidgetValue reads
// it back), so `properties` is the *entire* persistence substrate — view-prefs AND
// the last selection (selected_lora_sha256 etc.). We persist it to localStorage,
// keyed per provider, so both survive across opens. Content (models, prompts) is
// backend-backed and NOT stored here; only this lightweight per-browser UI state is.

const STORE_PREFIX = "krc-library-modal:";

function loadProps(key) {
  try {
    const raw = globalThis.localStorage?.getItem(STORE_PREFIX + key);
    const parsed = raw ? JSON.parse(raw) : null;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function saveProps(key, props) {
  try {
    globalThis.localStorage?.setItem(STORE_PREFIX + key, JSON.stringify(props));
  } catch {
    // Private mode / storage disabled — persistence silently degrades to in-memory.
  }
}

// Build a detached node stub. `key` names the localStorage bucket (e.g. "models"
// / "prompts"); `size` seeds node.size for the rare reader that consults it.
export function createNodeHostStub({ key, size = [820, 668] } = {}) {
  if (!key) {
    throw new Error("createNodeHostStub requires a persistence key");
  }

  const target = loadProps(key);

  let saveTimer = null;
  const schedulePersist = () => {
    if (saveTimer) return;
    saveTimer = setTimeout(() => {
      saveTimer = null;
      saveProps(key, target);
    }, 200);
  };

  // Persist on ANY mutation — both node.setProperty(name, value) and direct
  // node.properties[x] = y (some panels write properties without setProperty).
  const properties = new Proxy(target, {
    set(obj, prop, value) {
      obj[prop] = value;
      schedulePersist();
      return true;
    },
    deleteProperty(obj, prop) {
      delete obj[prop];
      schedulePersist();
      return true;
    },
  });

  const stub = {
    __krcDetached: true, // markDirty() early-returns on this; also a general detached marker
    id: -1,
    graph: null,
    flags: {},
    size: [size[0], size[1]],
    properties,
    widgets: [],
    widgets_values: [],

    // LiteGraph widget factory used by ensureHiddenWidget() to lazily create a
    // hidden backing widget. Minimal shape: name/value/callback are all the KRC
    // accessors touch.
    addWidget(type, name, value, callback, options) {
      const widget = { type, name, value, callback: callback || (() => {}), options: options || {} };
      stub.widgets.push(widget);
      return widget;
    },

    setProperty(name, value) {
      properties[name] = value; // routes through the Proxy -> schedules persist
    },

    // Canvas/graph affordances the panels may poke — all no-ops off-graph.
    setSize() {},
    setDirtyCanvas() {},
    onRemoved: null,

    // Flush any pending debounced write immediately (call on modal teardown /
    // before unload so the last edits are never lost to the debounce window).
    __krcFlushPersist() {
      if (saveTimer) {
        clearTimeout(saveTimer);
        saveTimer = null;
      }
      saveProps(key, target);
    },
  };

  return stub;
}
