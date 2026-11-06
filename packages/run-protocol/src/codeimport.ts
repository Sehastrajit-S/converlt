// Code → graph: what the importer (converge_import.py, torch.fx on the machine) returns, turned
// into a Model Builder graph: layer settings completed with defaults and laid out by depth.
import { analyzeGraph, defaultParams, LAYER, type LayerType, type ModelGraph, type ParamValue } from "./modelgraph.ts";

export interface ImportedNode {
  id: string;
  type: string;
  params: Record<string, ParamValue>;
  /** The torch.fx node it came from, e.g. "encoder_layers_0". */
  fx?: string;
  /** Module path in the original model, e.g. "encoder.layers.0". */
  label?: string | null;
}

export interface ImportedGraph {
  name: string;
  nodes: ImportedNode[];
  edges: { from: string; to: string }[];
}

export interface ImportSummary {
  graph: ModelGraph;
  /** Parameter count PyTorch reported and the graph's own count; equal when every layer was understood. */
  torchParams: number | null;
  graphParams: number;
  /** Blocks kept as "From your code". */
  custom: string[];
  ok: boolean;
  errors: string[];
}

/** Lays an imported graph out top to bottom by depth, branches side by side. */
export function importedToGraph(raw: ImportedGraph, torchParams: number | null, custom: string[] = []): ImportSummary {
  const known = new Set(Object.keys(LAYER));
  const nodes = raw.nodes.map((n) => {
    const type = (known.has(n.type) ? n.type : "Custom") as LayerType;
    return { id: n.id, type, params: { ...defaultParams(type), ...n.params }, x: 0, y: 0 };
  });
  const ins = new Map(nodes.map((n) => [n.id, raw.edges.filter((e) => e.to === n.id).map((e) => e.from)]));
  const depth = new Map<string, number>();
  const visit = (id: string, seen = new Set<string>()): number => {
    if (depth.has(id)) return depth.get(id)!;
    if (seen.has(id)) return 0;
    seen.add(id);
    const d = Math.max(-1, ...(ins.get(id) ?? []).map((i) => visit(i, seen))) + 1;
    depth.set(id, d);
    return d;
  };
  const perRow = new Map<number, number>();
  for (const n of nodes) {
    const d = visit(n.id);
    const col = perRow.get(d) ?? 0;
    perRow.set(d, col + 1);
    n.x = 80 + col * 250;
    n.y = 40 + d * 92;
  }
  const graph: ModelGraph = { name: raw.name.replace(/([a-z0-9])([A-Z])/g, "$1 $2").toLowerCase(), nodes, edges: raw.edges };
  const a = analyzeGraph(graph);
  return {
    graph,
    torchParams,
    graphParams: a.totalParams,
    custom,
    ok: a.ok,
    errors: [...a.errors, ...nodes.filter((n) => a.nodes[n.id]?.error).map((n) => `${LAYER[n.type].label}: ${a.nodes[n.id]!.error}`)],
  };
}
