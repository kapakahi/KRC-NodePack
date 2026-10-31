"""Per-run usage for LoRAs, models and kit prompt slots, like Prompt Vault's prompts.

Prompt Vault counts each prompt once per queued run from ComfyUI's on_prompt hook. A
LoRA Loadout, Config Switcher or Loadout Kit node can't be read that way: what it loads
can change during the run (a preset trigger), and ComfyUI skips a node whose inputs
didn't change (a cached run), so counting inside the node missed every cached run.

So, per queued run:
- the on_prompt hook counts, for every node in the prompt, what that node emitted the
  last time it executed. That's exactly what a cached run reuses;
- a node that does execute reports what it really emitted (``node_used``), and the run's
  count is corrected: models it no longer uses lose that run's count, new ones gain it.
Each run counts each item once however many nodes use it. The new totals go out on
LIBRARY_USAGE_EVENT (prompts on Prompt Vault's event) so open pages update live.

Node ids and the running prompt come from ComfyUI's executing context. If a run can't
be matched (an older ComfyUI), counting falls back to "per execution", as before, with
one ASCII log line. Every step is best-effort: bookkeeping never fails a run.
"""

import threading
import uuid
from collections import OrderedDict

from .usage_stats import VALID_KINDS, bump_usage, decrement_usage

LIBRARY_USAGE_EVENT = "krc-library-usage"
PROMPT_USAGE_EVENT = "krc-prompt-usage"
_MAX_NODES = 2048
_MAX_RUNS = 256

_lock = threading.Lock()
_last = OrderedDict()   # node id -> {kind: frozenset(ids)}: what it emitted last time
_runs = OrderedDict()   # prompt id -> {"nodes": {node id: {kind: set}}, "counted": {kind: set}}
_fallback = False
_registered = False


def _server():
    try:
        import server

        return server.PromptServer.instance
    except Exception:  # noqa: BLE001 - outside ComfyUI
        return None


def _current_run():
    """-> (prompt id, node id) of the node executing now, or (None, None)."""
    try:
        from comfy_execution.utils import get_executing_context

        context = get_executing_context()
        if context is not None and context.prompt_id is not None and context.node_id is not None:
            return str(context.prompt_id), str(context.node_id)
    except Exception:  # noqa: BLE001 - older ComfyUI
        pass
    instance = _server()
    prompt_id = getattr(instance, "last_prompt_id", None)
    node_id = getattr(instance, "last_node_id", None)
    return (str(prompt_id) if prompt_id else None), (str(node_id) if node_id else None)


def _announce(kind, usage):
    if not usage:
        return
    instance = _server()
    if instance is None:
        return
    try:
        if kind == "prompts":
            instance.send_sync(PROMPT_USAGE_EVENT, {"usage": usage})
        else:
            instance.send_sync(LIBRARY_USAGE_EVENT, {"kind": kind, "usage": usage})
    except Exception:  # noqa: BLE001
        pass


def _clean(used):
    out = {}
    for kind, ids in (used or {}).items():
        if kind in VALID_KINDS:
            out[kind] = {str(item) for item in (ids or []) if str(item or "").strip()}
    return out


def _union(nodes):
    total = {}
    for used in nodes.values():
        for kind, ids in used.items():
            total.setdefault(kind, set()).update(ids)
    return total


def count_run(json_data):
    """on_prompt handler: count what each node emitted last time, once per item. Makes
    sure the run has a prompt id (ComfyUI keeps a given one) so node reports can find
    it. Returns json_data."""
    try:
        if _fallback:
            return json_data
        prompt = json_data.get("prompt") if isinstance(json_data, dict) else None
        if not isinstance(prompt, dict):
            return json_data
        prompt_id = str(json_data.get("prompt_id") or uuid.uuid4())
        json_data["prompt_id"] = prompt_id
        with _lock:
            nodes = {str(node_id): {kind: set(ids) for kind, ids in _last[str(node_id)].items()}
                     for node_id in prompt if str(node_id) in _last}
            counted = _union(nodes)
            _runs[prompt_id] = {"nodes": nodes, "counted": counted}
            while len(_runs) > _MAX_RUNS:
                _runs.popitem(last=False)
        for kind, ids in counted.items():
            _announce(kind, bump_usage(kind, sorted(ids)))
    except Exception:  # noqa: BLE001 - bookkeeping never breaks the queue
        pass
    return json_data


def node_used(used):
    """Called by an executing node with what it really emitted: {"loras" | "models" |
    "prompts": [ids]}. Corrects this run's count (or counts it, when the run is unknown)."""
    global _fallback
    try:
        used = _clean(used)
        prompt_id, node_id = _current_run()
        changes = {}
        with _lock:
            if node_id:
                _last[node_id] = {kind: frozenset(ids) for kind, ids in used.items()}
                _last.move_to_end(node_id)
                while len(_last) > _MAX_NODES:
                    _last.popitem(last=False)
            run = _runs.get(prompt_id) if (prompt_id and node_id and not _fallback) else None
            if run is None:
                if prompt_id and node_id and _runs and not _fallback and _registered:
                    _fallback = True
                    print("[KRC Usage] couldn't match a run to its queued prompt; counting LoRAs and models "
                          "per execution instead")
                changes = {kind: (set(ids), set()) for kind, ids in used.items()}
            else:
                run["nodes"][node_id] = used
                now = _union(run["nodes"])
                before = run["counted"]
                for kind in set(now) | set(before):
                    plus = now.get(kind, set()) - before.get(kind, set())
                    minus = before.get(kind, set()) - now.get(kind, set())
                    if plus or minus:
                        changes[kind] = (plus, minus)
                run["counted"] = now
        for kind, (plus, minus) in changes.items():
            usage = {}
            if plus:
                usage.update(bump_usage(kind, sorted(plus)))
            if minus:
                usage.update(decrement_usage(kind, sorted(minus)))
            _announce(kind, usage)
    except Exception:  # noqa: BLE001
        pass


def register_run_usage():
    """Add the on_prompt hook once (the flag lives on the PromptServer, which outlives a
    module reload). No PromptServer / no on_prompt API = counting per execution."""
    global _registered
    instance = _server()
    if instance is None:
        return False
    if getattr(instance, "_krc_run_usage", False):
        _registered = True
        return True
    adder = getattr(instance, "add_on_prompt_handler", None)
    if not callable(adder):
        return False
    adder(count_run)
    instance._krc_run_usage = True
    _registered = True
    return True


register_run_usage()
