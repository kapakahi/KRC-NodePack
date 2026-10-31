// Walking the ComfyUI graph across reroutes and subgraphs (PRESET_SYNC_GAMEPLAN.md
// step 1). Moved here from Config Switcher Link (which follows its `config` input back to
// a Config Switcher) so Prompt Vault can follow its `preset` output forward to the
// loadouts it drives.
//
// No `app` import: callers pass the root graph (`app.graph`), so this runs in tests.
// Handles both LiteGraph shapes this frontend has used: `graph._nodes` / `graph.nodes`,
// `graph.links` as an object, array or Map, and `output.links` / `output.linkIds`.

export function graphNodes(graph) {
  return graph?._nodes || graph?.nodes || [];
}

export function getGraphNodeById(graph, id) {
  return graph?.getNodeById?.(id) || graph?._nodes_by_id?.[id] || graphNodes(graph).find((node) => node.id === id) || null;
}

export function getGraphLink(graph, id) {
  return graph?.links?.[id] || graph?.links?.get?.(id) || graph?.links?.find?.((link) => link?.id === id) || null;
}

export function nodeClassName(node) {
  return node?.comfyClass ?? node?.type;
}

export function linkIdsForOutput(output) {
  const ids = new Set();
  for (const id of output?.links || []) ids.add(id);
  for (const id of output?.linkIds || []) ids.add(id);
  return [...ids].filter((id) => id != null);
}

// The inner graph a subgraph instance node wraps, however this build exposes it.
export function subgraphInnerGraph(node) {
  const sub = node?.subgraph || node?._subgraph;
  if (sub?.graph && (sub.graph._nodes || sub.graph.nodes)) return sub.graph;
  if (sub && (sub._nodes || sub.nodes)) return sub;
  return null;
}

// Every graph in the workflow (root + nested subgraphs).
export function allGraphs(root) {
  const out = [];
  const seen = new Set();
  const walk = (graph) => {
    if (!graph || seen.has(graph)) return;
    seen.add(graph);
    out.push(graph);
    for (const node of graphNodes(graph)) {
      const inner = subgraphInnerGraph(node);
      if (inner) walk(inner);
    }
  };
  walk(root);
  return out;
}

// The subgraph *instance node* that owns `graph`. Prefers exact inner-graph identity,
// then an instance whose type is the inner graph's id (a subgraph instance's type IS its
// definition uuid). null on zero or MORE THAN ONE match, so callers never bind to the
// wrong node.
export function findParentSubgraphNode(graph, root) {
  for (const key of ["_subgraph_node", "subgraphNode", "ownerNode", "_ownerNode", "_parentNode"]) {
    const cand = graph?.[key];
    if (cand && typeof cand === "object" && cand.inputs) return cand;
  }
  const graphs = allGraphs(root);
  const byIdentity = [];
  for (const g of graphs) {
    for (const node of graphNodes(g)) {
      if (subgraphInnerGraph(node) === graph) byIdentity.push(node);
    }
  }
  if (byIdentity.length === 1) return byIdentity[0];
  if (byIdentity.length > 1) return null;

  const subgraphId = graph?.id ?? graph?._id;
  if (subgraphId == null) return null;
  const byType = [];
  for (const g of graphs) {
    for (const node of graphNodes(g)) {
      if (nodeClassName(node) === String(subgraphId)) byType.push(node);
    }
  }
  return byType.length === 1 ? byType[0] : null;
}

// The graph a node lives in: the node's own, or the given fallback.
export function graphOf(node, fallback) {
  return node?.graph || fallback || null;
}

function isLegacyReroute(node) {
  return nodeClassName(node) === "Reroute";
}

const ownsLink = (slot, linkId) =>
  slot?.link === linkId || (Array.isArray(slot?.linkIds) && slot.linkIds.some((id) => String(id) === String(linkId)));

// The walk under downstreamNodes / downstreamInputs: from `node`'s output `outputName` (or
// index), following links, legacy Reroute nodes and subgraph boundaries (into a subgraph
// through its input, out through its output). Native reroutes are link-level (the link
// still joins origin and target), so they need nothing. `visit(graph, target, slot)` gets
// every other node input reached, once per node + slot; `stopAt(target)` true ends the walk
// at a Reroute or subgraph instance instead of passing through. Cycles end.
function walkDownstream(node, outputName, visit, { root = null, graph = null, stopAt = () => false } = {}) {
  const seenTargets = new Set();
  const seenLinks = new Set();
  const startGraph = graphOf(node, graph || root);
  const slotIndex = typeof outputName === "number"
    ? outputName
    : (node?.outputs || []).findIndex((output) => output?.name === outputName);
  if (!startGraph || slotIndex < 0) return;

  const visitTarget = (g, target, slot) => {
    if (!target) return;
    if (isLegacyReroute(target) && !stopAt(target)) {
      if (seenTargets.has(target)) return;
      seenTargets.add(target);
      followOutput(g, target, 0);
      return;
    }
    const key = `${g?.id ?? ""}:${target.id}:${slot}`;
    if (seenTargets.has(key)) return;
    seenTargets.add(key);
    visit(g, target, slot);
  };

  // Into a subgraph: the instance node's input `slot` continues from the inner graph's
  // boundary input of the same name (or position).
  const enterSubgraph = (instance, slot) => {
    const inner = subgraphInnerGraph(instance);
    if (!inner) return;
    const inputs = inner.inputs || inner._inputs || [];
    const name = instance.inputs?.[slot]?.name;
    let boundary = inputs.findIndex((input) => input?.name === name);
    if (boundary < 0) boundary = slot;
    for (const linkId of linkIdsForOutput(inputs[boundary])) followLink(inner, linkId);
  };

  // Out of a subgraph: a link into the inner graph's boundary output continues from the
  // instance node's output of the same name (or position), in the parent graph.
  const leaveSubgraph = (inner, linkId) => {
    const outputs = inner.outputs || inner._outputs || [];
    const boundary = outputs.findIndex((output) => ownsLink(output, linkId));
    if (boundary < 0) return;
    const instance = findParentSubgraphNode(inner, root);
    if (!instance) return;
    let slot = (instance.outputs || []).findIndex((output) => output?.name === outputs[boundary]?.name);
    if (slot < 0) slot = boundary;
    followOutput(graphOf(instance, root), instance, slot);
  };

  const followLink = (g, linkId) => {
    const key = `${g?.id ?? ""}:${linkId}`;
    if (seenLinks.has(key)) return;
    seenLinks.add(key);
    const link = getGraphLink(g, linkId);
    if (!link) return;
    const target = getGraphNodeById(g, link.target_id);
    if (!target) {
      leaveSubgraph(g, link.id ?? linkId);
      return;
    }
    if (subgraphInnerGraph(target) && !stopAt(target)) {
      enterSubgraph(target, link.target_slot);
      return;
    }
    visitTarget(g, target, link.target_slot);
  };

  function followOutput(g, from, slot) {
    for (const linkId of linkIdsForOutput(from?.outputs?.[slot])) followLink(g, linkId);
  }

  followOutput(startGraph, node, slotIndex);
}

// Every node `accept` takes that is reached from `node`'s output `outputName` (or index)
// (walkDownstream). Any other node ends that branch: the walk never looks through a node
// that might change the value. Graph order, de-duplicated.
//   options.root   the workflow's root graph (app.graph), for leaving subgraphs
//   options.graph  `node`'s graph when it isn't `node.graph`
export function downstreamNodes(node, outputName, accept, { root = null, graph = null } = {}) {
  const found = [];
  walkDownstream(node, outputName, (_g, target) => {
    if (!found.includes(target) && accept(target)) found.push(target);
  }, { root, graph, stopAt: accept });
  return found;
}

// Every node input reached from `node`'s output `outputName` (or index), through legacy
// Reroutes and subgraph boundaries: [{node, slot, graph}], graph order, one per input.
export function downstreamInputs(node, outputName, { root = null, graph = null } = {}) {
  const found = [];
  walkDownstream(node, outputName, (g, target, slot) => found.push({ node: target, slot, graph: g }), { root, graph });
  return found;
}

// The node `accept` takes that feeds `node`'s input `inputName` (or index), followed back
// through links, legacy Reroutes and subgraph boundaries (out through the instance's input
// when the link starts at a subgraph's boundary input, into the inner graph when it starts
// at a subgraph instance's output). Any other node ends the walk; null when nothing
// matches. The mirror of downstreamNodes (PRESET_LINK_GAMEPLAN.md step 5: a loadout finds
// the Prompt Vault driving it).
export function upstreamNode(node, inputName, accept, { root = null, graph = null } = {}) {
  const seen = new Set();
  const slotIndex = typeof inputName === "number"
    ? inputName
    : (node?.inputs || []).findIndex((input) => input?.name === inputName);
  if (slotIndex < 0) return null;

  const fromInput = (g, target, slot) => {
    const linkId = target?.inputs?.[slot]?.link;
    return linkId == null ? null : fromLink(g, linkId);
  };

  // A link that starts at the inner graph's boundary input continues from the instance
  // node's input of the same name (or position), in the parent graph.
  const leaveSubgraph = (inner, linkId) => {
    const inputs = inner?.inputs || inner?._inputs || [];
    const boundary = inputs.findIndex((input) => ownsLink(input, linkId));
    if (boundary < 0) return null;
    const instance = findParentSubgraphNode(inner, root);
    if (!instance) return null;
    let slot = (instance.inputs || []).findIndex((input) => input?.name === inputs[boundary]?.name);
    if (slot < 0) slot = boundary;
    return fromInput(graphOf(instance, root), instance, slot);
  };

  // A link from a subgraph instance's output continues from whatever feeds the inner
  // graph's boundary output of the same name (or position).
  const enterSubgraph = (instance, slot) => {
    const inner = subgraphInnerGraph(instance);
    if (!inner) return null;
    const outputs = inner.outputs || inner._outputs || [];
    const name = instance.outputs?.[slot]?.name;
    let boundary = outputs.findIndex((output) => output?.name === name);
    if (boundary < 0) boundary = slot;
    const output = outputs[boundary];
    const ids = [...(output?.linkIds || []), ...(output?.link != null ? [output.link] : [])];
    for (const linkId of ids) {
      const found = fromLink(inner, linkId);
      if (found) return found;
    }
    return null;
  };

  function fromLink(g, linkId) {
    const key = `${g?.id ?? ""}:${linkId}`;
    if (seen.has(key)) return null;
    seen.add(key);
    const link = getGraphLink(g, linkId);
    if (!link) return null;
    const origin = getGraphNodeById(g, link.origin_id);
    if (!origin) return leaveSubgraph(g, link.id ?? linkId);
    if (accept(origin)) return origin;
    if (isLegacyReroute(origin)) return fromInput(graphOf(origin, g), origin, 0);
    if (subgraphInnerGraph(origin)) return enterSubgraph(origin, link.origin_slot);
    return null;
  }

  return fromInput(graphOf(node, graph || root), node, slotIndex);
}

// Every node `accept` takes, in every graph of the workflow (root first).
export function workflowNodes(accept, root) {
  return allGraphs(root).flatMap((graph) => graphNodes(graph).filter((node) => accept(node)));
}
