"""The external API's workflow preparation (KRC_EXTERNAL_API.md "Standby branches",
capability "workflows.standby"): turn KRC Resizer branches on and off in an API-format
workflow, the way ComfyUI's Mute (the Resizer's DISABLE) does, for a client's queued copy.

Stateless and read-only: the client sends a workflow and gets one back. Nothing is stored,
queued, executed or written; the supplied workflow isn't changed (a deep copy is).

Mute, as ComfyUI does it (ComfyUI_frontend executionUtil.ts graphToPrompt): a muted node is
left out of the prompt, then every input that points at a node that isn't in the prompt is
deleted, in one pass. Nodes after it stay (they lose that input: fine when it's optional, a
"Required input is missing" from ComfyUI when it's required, as on the canvas). Nodes that
only fed it stay too, and ComfyUI doesn't run them: it validates and runs only output nodes
and what feeds them. So what a disabled branch alone needs is skipped and anything shared
keeps running, without this module deciding which is which.

Turning a branch back on needs what the export left out: the standby record a NodePack-made
export carries in one node's ``_meta.krc_standby`` (web/js/shared/standby_export.js): the
muted Resizers' entries, the muted nodes feeding them, and the links ComfyUI deleted. An
export without it lists only the Resizers it holds (they can still be turned off).

Enabling a Resizer also enables the standby nodes that feed it (a muted loader before it),
or it would run without its images. Disabling mutes the Resizer only, exactly as DISABLE.
PASSTHROUGH is an input of the Resizer and is never touched here.
"""
import copy
import json

STANDBY_META_KEY = "krc_standby"
STANDBY_VERSION = 1
ANCHOR_CLASSES = ("KRC Resizer",)
MAX_PROMPT_BYTES = 16 * 1024 * 1024
MAX_NODES = 10000


class WorkflowError(ValueError):
    """A workflow or a choice this can't use: ``status`` and ``code`` for the answer."""

    def __init__(self, status, code, message):
        super().__init__(message)
        self.status, self.code = status, code


def _bad(message):
    return WorkflowError(400, "bad_request", message)


def _is_link(value):
    return isinstance(value, list) and len(value) == 2 and isinstance(value[0], str)


def _id_key(node_id):
    parts = str(node_id).split(":")
    try:
        return (0, tuple(int(part) for part in parts))
    except ValueError:
        return (1, str(node_id))


def _check_entry(node_id, entry, where):
    if not isinstance(node_id, str) or not node_id:
        raise _bad(f"{where}: node ids must be strings")
    if not isinstance(entry, dict) or not isinstance(entry.get("class_type"), str) or not entry["class_type"]:
        raise _bad(f"{where}: node {node_id} must be an object with a class_type")
    if not isinstance(entry.get("inputs", {}), dict):
        raise _bad(f"{where}: node {node_id}'s inputs must be an object")
    meta = entry.get("_meta", {})
    if not isinstance(meta, dict):
        raise _bad(f"{where}: node {node_id}'s _meta must be an object")


def _check_prompt(prompt):
    """An API-format workflow ({id: {class_type, inputs, _meta?}}): checked, deep-copied."""
    if not isinstance(prompt, dict) or not prompt:
        raise _bad("workflow must be an API-format workflow: {\"<node id>\": {\"class_type\", \"inputs\"}, ...}")
    if len(prompt) > MAX_NODES:
        raise WorkflowError(413, "too_large", f"At most {MAX_NODES} nodes")
    if len(json.dumps(prompt)) > MAX_PROMPT_BYTES:
        raise WorkflowError(413, "too_large", "That workflow is too large")
    for node_id, entry in prompt.items():
        _check_entry(node_id, entry, "workflow")
    return copy.deepcopy(prompt)


def _take_record(prompt):
    """The standby record, removed from its carrier (at most one), checked."""
    found = [(node_id, entry["_meta"][STANDBY_META_KEY]) for node_id, entry in prompt.items()
             if isinstance(entry.get("_meta"), dict) and STANDBY_META_KEY in entry["_meta"]]
    if len(found) > 1:
        raise _bad("The workflow has more than one standby record (_meta.krc_standby): use the export as KRC made it")
    if not found:
        return None
    carrier, record = found[0]
    del prompt[carrier]["_meta"][STANDBY_META_KEY]
    if not isinstance(record, dict) or record.get("version") != STANDBY_VERSION:
        raise _bad("The standby record (_meta.krc_standby) is from another NodePack: export the workflow again")
    nodes, inputs = record.get("nodes"), record.get("inputs")
    if not isinstance(nodes, dict) or not isinstance(inputs, dict):
        raise _bad("The standby record (_meta.krc_standby) is damaged: export the workflow again")
    for node_id, entry in nodes.items():
        _check_entry(node_id, entry, "standby record")
    for node_id, links in inputs.items():
        if not isinstance(links, dict) or not all(isinstance(name, str) and _is_link(value) for name, value in links.items()):
            raise _bad("The standby record (_meta.krc_standby) is damaged: export the workflow again")
    return {"nodes": copy.deepcopy(nodes), "inputs": copy.deepcopy(inputs)}


def _full_graph(prompt):
    """(full graph, ids present in the workflow, standby ids): the workflow with the standby
    nodes and the links ComfyUI deleted put back, as it would be with nothing muted."""
    present = _check_prompt(prompt)
    record = _take_record(present)
    full = copy.deepcopy(present)
    standby = []
    if record:
        for node_id, entry in record["nodes"].items():
            if node_id not in full:          # a present node always wins
                full[node_id] = entry
                standby.append(node_id)
        for node_id, links in record["inputs"].items():
            target = full.get(node_id)
            if target is None:
                continue
            for name, value in links.items():
                target.setdefault("inputs", {}).setdefault(name, value)
    return full, set(present), set(standby), record is not None


def _ancestors(full, start, within):
    """Nodes in ``within`` that feed ``start`` (through links), transitively."""
    seen, stack = set(), [start]
    while stack:
        node_id = stack.pop()
        for value in (full.get(node_id, {}).get("inputs") or {}).values():
            if _is_link(value) and value[0] in within and value[0] not in seen:
                seen.add(value[0])
                stack.append(value[0])
    return seen


def serialize(full, muted):
    """ComfyUI's graphToPrompt, on an API graph: the muted nodes left out, then every input
    pointing at a node that isn't there deleted (one pass)."""
    out = {node_id: copy.deepcopy(entry) for node_id, entry in full.items() if node_id not in muted}
    for entry in out.values():
        inputs = entry.get("inputs") or {}
        for name in [name for name, value in inputs.items() if _is_link(value) and value[0] not in out]:
            del inputs[name]
    return out


def make_record(out, full):
    """The standby record for a serialized prompt (what standby_export.js computeStandby
    writes): the muted anchors and the muted nodes feeding them, and the deleted links."""
    absent = {node_id for node_id in full if node_id not in out}
    anchors = [node_id for node_id in absent if full[node_id]["class_type"] in ANCHOR_CLASSES]
    if not anchors:
        return None
    standby = set(anchors)
    for anchor in anchors:
        standby |= _ancestors(full, anchor, absent)
    nodes = {}
    for node_id in sorted(standby, key=_id_key):
        entry = copy.deepcopy(full[node_id])
        if isinstance(entry.get("_meta"), dict):
            entry["_meta"].pop(STANDBY_META_KEY, None)
        nodes[node_id] = entry
    inputs = {}
    for node_id in sorted(out, key=_id_key):
        for name, value in (full[node_id].get("inputs") or {}).items():
            if _is_link(value) and value[0] in standby and name not in (out[node_id].get("inputs") or {}):
                inputs.setdefault(node_id, {})[name] = value
    return {"version": STANDBY_VERSION, "classes": list(ANCHOR_CLASSES), "nodes": nodes, "inputs": inputs}


def _with_record(out, full):
    record = make_record(out, full)
    if record and out:
        carrier = sorted(out, key=_id_key)[0]
        out[carrier]["_meta"] = {**(out[carrier].get("_meta") or {}), STANDBY_META_KEY: record}
    return out


# ---- the two operations ---------------------------------------------------------------

def branches(payload):
    """POST /krc/ext/v1/workflows/branches {workflow}: every KRC Resizer, on (in the
    workflow) or standby (disabled when exported), with what feeds it and what it feeds."""
    if not isinstance(payload, dict) or set(payload) - {"workflow"}:
        raise _bad('The body is {"workflow": <API-format workflow>}')
    full, present, standby, has_record = _full_graph(payload.get("workflow"))
    out = []
    for node_id in sorted(full, key=_id_key):
        entry = full[node_id]
        if entry["class_type"] not in ANCHOR_CLASSES:
            continue
        inputs = entry.get("inputs") or {}
        images = inputs.get("images")
        source = None
        if _is_link(images) and images[0] in full:
            origin = full[images[0]]
            source = {"id": images[0], "classType": origin["class_type"], "title": (origin.get("_meta") or {}).get("title", ""),
                      "inWorkflow": images[0] in present}
        consumers = [{"id": other_id, "input": name}
                     for other_id in sorted(full, key=_id_key)
                     for name, value in (full[other_id].get("inputs") or {}).items()
                     if _is_link(value) and value[0] == node_id]
        problems = []
        if source is None:
            problems.append("no_source")       # its images input isn't connected to anything in the export
        out.append({
            "id": node_id, "title": (entry.get("_meta") or {}).get("title", ""),
            "enabled": node_id in present, "passthrough": str(inputs.get("passthrough", "0")) == "1",
            "source": source,
            "enables": sorted(_ancestors(full, node_id, standby), key=_id_key),
            "consumers": consumers, "problems": problems,
        })
    return {"standbyRecord": has_record, "resizers": out}


def prepare(payload):
    """POST /krc/ext/v1/workflows/prepare {workflow, enabled: {resizer id: bool}}: the
    workflow with those Resizers on or off (as DISABLE / ComfyUI's Mute), ready to queue, and
    carrying its own standby record so it can be prepared again."""
    if not isinstance(payload, dict) or set(payload) - {"workflow", "enabled"}:
        raise _bad('The body is {"workflow": <API-format workflow>, "enabled": {"<resizer id>": true|false}}')
    choices = payload.get("enabled", {})
    if not isinstance(choices, dict) or not all(isinstance(key, str) and isinstance(value, bool) for key, value in choices.items()):
        raise _bad('enabled must be {"<resizer id>": true | false}')
    full, present, standby, _has_record = _full_graph(payload.get("workflow"))
    for node_id in choices:
        if node_id not in full:
            raise WorkflowError(404, "unknown_node", f"No node {node_id} in the workflow or its standby record "
                                                     "(a disabled branch needs an export with standby branches)")
        if full[node_id]["class_type"] not in ANCHOR_CLASSES:
            raise WorkflowError(400, "not_a_branch", f"Node {node_id} is a {full[node_id]['class_type']}: only KRC Resizer "
                                                     "branches can be turned on and off here")
    disabled = {node_id for node_id, on in choices.items() if not on}
    muted = set(standby) | disabled
    for node_id, on in choices.items():
        if on:
            # What feeds it comes back with it, except a Resizer the client turned off.
            needed = (_ancestors(full, node_id, standby) - disabled) | {node_id}
            muted -= needed
            images = (full[node_id].get("inputs") or {}).get("images")
            if not (_is_link(images) and images[0] in full and images[0] not in muted):
                raise WorkflowError(422, "branch_incomplete", f"KRC Resizer {node_id} has no source for its images in this "
                                                              "export; enable it in ComfyUI and export again")
    out = serialize(full, muted)
    _with_record(out, full)
    state = {node_id: node_id in out for node_id in sorted(full, key=_id_key) if full[node_id]["class_type"] in ANCHOR_CLASSES}
    return {"workflow": out, "resizers": state}
