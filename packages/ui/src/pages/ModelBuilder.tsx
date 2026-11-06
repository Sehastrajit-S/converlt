import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent, type PointerEvent as ReactPointerEvent } from "react";
import { Activity, Code, Copy, Database, FileCode, FolderOpen, LoaderCircle, Play, Save, Search, Trash2, Wand2, X } from "lucide-react";
import {
  analyzeGraph,
  datasetSpec,
  defaultParams,
  designDataIssues,
  fitToData,
  templatesFitting,
  TRAIN_MODE_LABEL,
  trainMode,
  fileStem,
  fmtShape,
  generateModelCode,
  LAYER,
  LAYERS,
  moduleNames,
  moduleOf,
  type WeightsEvent,
  TEMPLATES,
  templateGroups,
  type Edge,
  type LayerNode,
  type LayerType,
  type ModelGraph,
  type ParamSpec,
} from "@converge/run-protocol";
import type { AppState, BuilderDesign, DatasetView } from "@converge/core/api";
import { api, errorMessage, useRun, useRuns } from "../api.ts";
import { StatusPill, Switch, useToast } from "../components/ui.tsx";
import { layerWeights, LayerWeightsDetail, NodeWeights } from "../components/WeightsView.tsx";
import { CodeImportDialog } from "../components/CodeImportDialog.tsx";
import { ExamplesStrip } from "../components/ExamplesStrip.tsx";
import { LayerIcon } from "../components/LayerIcon.tsx";
import { formatBytes } from "../format.ts";

const W = 200;
const H = 64;
const GRID = 8;
const DRAG_TYPE = "application/x-converlt-layer";
const snap = (v: number) => Math.max(0, Math.round(v / GRID) * GRID);

let seq = 0;
const newId = () => `n${Date.now().toString(36)}${(seq++).toString(36)}`;

function formatParams(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
  return String(n);
}

/** The settings that matter most, for the node's subtitle. */
function summary(n: LayerNode): string {
  const p = n.params;
  switch (n.type) {
    case "Input":
      return `${p.shape}${p.dtype === "token ids" ? " ids" : ""}`;
    case "Linear":
      return `→ ${p.out_features}`;
    case "Conv1d":
    case "Conv2d":
    case "Conv3d":
      return `${p.out_channels} · k${p.kernel_size} s${p.stride}${Number(p.dilation ?? 1) > 1 ? ` d${p.dilation}` : ""}${Number(p.groups ?? 1) > 1 ? ` g${p.groups}` : ""}`;
    case "ConvTranspose2d":
      return `${p.out_channels} · k${p.kernel_size} ×${p.stride}`;
    case "Upsample":
      return `×${p.scale_factor}`;
    case "MaxPool1d":
    case "MaxPool2d":
    case "MaxPool3d":
    case "AvgPool2d":
      return `k${p.kernel_size} s${p.stride}`;
    case "Reshape":
      return `→ ${p.shape}`;
    case "Permute":
      return `order ${p.order}`;
    case "TransformerEncoderLayer":
      return `${p.nhead} heads · mlp ${p.dim_feedforward}${p.causal ? " · causal" : ""}`;
    case "Output":
      return p.loss && p.loss !== "auto" ? String(p.loss) : "";
    case "Timestep":
      return `${p.dim} · ${p.steps} steps`;
    case "Custom":
      return String(p.what);
    case "Embedding":
      return `${p.num_embeddings} → ${p.embedding_dim}`;
    case "LSTM":
    case "GRU":
      return `${p.hidden_size}${p.bidirectional ? " ×2" : ""} · ${p.num_layers} layer${p.num_layers === 1 ? "" : "s"}`;
    case "MultiheadAttention":
      return `${p.num_heads} heads`;
    case "Dropout":
      return `p ${p.p}`;
    case "SequencePool":
      return String(p.mode);
    default:
      return "";
  }
}

function wire(x1: number, y1: number, x2: number, y2: number): string {
  const dy = Math.max(30, Math.abs(y2 - y1) / 2);
  return `M ${x1} ${y1} C ${x1} ${y1 + dy}, ${x2} ${y2 - dy}, ${x2} ${y2}`;
}

const storageKey = (project: string | undefined) => `converlt:builder:${project ?? "none"}`;

function loadDraft(project: string | undefined): ModelGraph {
  try {
    const raw = localStorage.getItem(storageKey(project));
    if (raw) return JSON.parse(raw) as ModelGraph;
  } catch {
    // no storage, or a corrupt draft
  }
  return TEMPLATES.find((t) => t.id === "cnn")!.make();
}

/** Drag-and-drop model design: layers on a canvas, wired into a graph, saved as PyTorch code. */
export function ModelBuilder({ state, onTrain, onOpenData, importFile }: { state: AppState; onTrain?: (command: string, machineId: string | null) => void; onOpenData?: () => void; importFile?: string | null }) {
  const toast = useToast();
  const project = state.project?.path;
  const [graph, setGraph] = useState<ModelGraph>(() => loadDraft(project));
  const [selected, setSelected] = useState<{ node?: string; edge?: number } | null>(null);
  const [pending, setPending] = useState<{ from: string; x: number; y: number } | null>(null);
  const [showCode, setShowCode] = useState(false);
  const [busy, setBusy] = useState<"save" | "train" | null>(null);
  const [designs, setDesigns] = useState<BuilderDesign[]>([]);
  const [showWeights, setShowWeights] = useState(() => {
    try {
      return localStorage.getItem("converlt:builder:weights") === "1";
    } catch {
      return false;
    }
  });
  const [weightsRun, setWeightsRun] = useState<string | null>(null);
  /** The hand-made design a template replaced, until it's restored or the new one is edited. */
  const [replaced, setReplaced] = useState<ModelGraph | null>(null);
  /** Code → graph dialog; opens by itself when the editor asked to show a file as a graph. */
  const [importing, setImporting] = useState(!!importFile);
  useEffect(() => {
    if (importFile) setImporting(true);
  }, [importFile]);
  /** The template on the canvas, until it's edited. */
  const [activeTemplate, setActiveTemplate] = useState<string | null>(null);
  const [layerQuery, setLayerQuery] = useState("");
  /** Palette filtered by the search box: every word must appear in the name, description, type or group. */
  const paletteLayers = useMemo(() => {
    const words = layerQuery.toLowerCase().split(/\s+/).filter(Boolean);
    const offered = LAYERS.filter((l) => !l.hidden);
    if (!words.length) return offered;
    return offered.filter((l) => {
      const text = `${l.label} ${l.type} ${l.blurb} ${l.group}`.toLowerCase();
      return words.every((w) => text.includes(w));
    });
  }, [layerQuery]);
  const [snapIdx, setSnapIdx] = useState<number | null>(null);
  const canvasRef = useRef<HTMLDivElement>(null);
  const drag = useRef<{ id: string; dx: number; dy: number } | null>(null);

  const analysis = useMemo(() => analyzeGraph(graph), [graph]);
  const code = useMemo(() => {
    try {
      return { text: generateModelCode(graph, analysis), error: null };
    } catch (e) {
      return { text: "", error: errorMessage(e) };
    }
  }, [graph, analysis]);
  const byId = useMemo(() => new Map(graph.nodes.map((n) => [n.id, n])), [graph.nodes]);

  // -------------------------------------------------- the dataset this design trains on
  const [datasets, setDatasets] = useState<DatasetView[]>([]);
  useEffect(() => {
    const list = () => api.dataList().then((d) => setDatasets(d ?? []), () => setDatasets([]));
    void list();
    // Downloads from Datasets & models join the list without a visit to Data.
    api.dataSyncHub().then(
      (added) => {
        if (added.length) void list();
      },
      () => {},
    );
  }, [project]);
  const dataView = graph.dataset ? datasets.find((v) => v.dataset.id === graph.dataset) : undefined;
  const spec = useMemo(() => (dataView ? datasetSpec(dataView.dataset, dataView.profile) : null), [dataView]);
  const dataIssues = useMemo(() => (spec && dataView && analysis.ok ? designDataIssues(graph, analysis, spec, dataView.dataset.name) : spec ? spec.blockers : []), [graph, analysis, spec, dataView]);
  const mode = spec && analysis.ok ? trainMode(graph, analysis, spec) : null;
  /** Templates that train on the chosen dataset as they are, listed first in the template picker. */
  const fitting = useMemo(() => (spec && dataView ? templatesFitting(spec, dataView.dataset.name) : []), [spec, dataView]);

  // -------------------------------------------------- weights from training runs of this design
  const toggleWeights = () => {
    setShowWeights(!showWeights);
    try {
      localStorage.setItem("converlt:builder:weights", showWeights ? "0" : "1");
    } catch {
      // remembered for this session only
    }
  };
  const allRuns = useRuns(showWeights ? project : undefined);
  const stem = fileStem(graph.name);
  const modelRuns = useMemo(() => allRuns.filter((r) => r.command.includes(`train_${stem}.py`)).sort((a, b) => b.createdAt - a.createdAt), [allRuns, stem]);
  const activeRunId = showWeights ? (weightsRun && modelRuns.some((r) => r.runId === weightsRun) ? weightsRun : (modelRuns[0]?.runId ?? null)) : null;
  const run = useRun(activeRunId);
  const snaps = (run && run.manifest.runId === activeRunId ? run.summary.weights : undefined) ?? [];
  const idx = snapIdx == null || snapIdx >= snaps.length ? snaps.length - 1 : snapIdx;
  const modules = useMemo(() => (analysis.ok ? moduleNames(graph, analysis) : {}), [graph, analysis]);
  const weightsOn = showWeights && snaps.length > 0;
  const live = !!run && (run.status === "running" || run.status === "preparing");

  useEffect(() => {
    try {
      localStorage.setItem(storageKey(project), JSON.stringify(graph));
    } catch {
      // storage unavailable: the design lives until the tab closes
    }
  }, [graph, project]);

  const refreshDesigns = useCallback(() => {
    api.builderList().then((d) => setDesigns(d ?? []), () => setDesigns([]));
  }, []);
  useEffect(refreshDesigns, [refreshDesigns, project]);

  const update = (fn: (g: ModelGraph) => ModelGraph) => {
    setGraph((g) => fn(g));
    setReplaced(null);
    setActiveTemplate(null);
  };

  const addLayer = (type: LayerType, x: number, y: number, connectFrom?: string) => {
    const n: LayerNode = { id: newId(), type, params: defaultParams(type), x: snap(x), y: snap(y) };
    update((g) => ({ ...g, nodes: [...g.nodes, n], edges: connectFrom && LAYER[type].inputs !== 0 ? [...g.edges, { from: connectFrom, to: n.id }] : g.edges }));
    setSelected({ node: n.id });
  };

  /** Click a palette item: append it under the selected layer and wire it in. */
  const addAfterSelection = (type: LayerType) => {
    const from = selected?.node ? byId.get(selected.node) : undefined;
    if (from && LAYER[from.type].type !== "Output") addLayer(type, from.x, from.y + H + 28, from.id);
    else addLayer(type, 320, 40 + graph.nodes.length * 20);
  };

  const removeSelected = () => {
    if (!selected) return;
    if (selected.node) {
      const id = selected.node;
      update((g) => ({ ...g, nodes: g.nodes.filter((n) => n.id !== id), edges: g.edges.filter((e) => e.from !== id && e.to !== id) }));
    } else if (selected.edge !== undefined) {
      const i = selected.edge;
      update((g) => ({ ...g, edges: g.edges.filter((_, j) => j !== i) }));
    }
    setSelected(null);
  };

  const connect = (from: string, to: string) => {
    if (from === to) return;
    const target = byId.get(to);
    if (!target || LAYER[target.type].inputs === 0) return;
    update((g) => {
      if (g.edges.some((e) => e.from === from && e.to === to)) return g;
      // A one-input layer gets its input replaced; Add and Concat collect more.
      const edges = LAYER[target.type].inputs === 1 ? g.edges.filter((e) => e.to !== to) : g.edges;
      return { ...g, edges: [...edges, { from, to }] };
    });
  };

  const setParam = (id: string, key: string, value: number | string | boolean) =>
    update((g) => ({ ...g, nodes: g.nodes.map((n) => (n.id === id ? { ...n, params: { ...n.params, [key]: value } } : n)) }));

  // -------------------------------------------------- pointer handling

  const toCanvas = (e: { clientX: number; clientY: number }) => {
    const r = canvasRef.current!.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };

  const onNodeDown = (e: ReactPointerEvent, n: LayerNode) => {
    if ((e.target as HTMLElement).dataset.port) return;
    e.stopPropagation();
    setSelected({ node: n.id });
    const p = toCanvas(e);
    drag.current = { id: n.id, dx: p.x - n.x, dy: p.y - n.y };
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  };
  const onNodeMove = (e: ReactPointerEvent) => {
    const d = drag.current;
    if (!d) return;
    const p = toCanvas(e);
    update((g) => ({ ...g, nodes: g.nodes.map((n) => (n.id === d.id ? { ...n, x: snap(p.x - d.dx), y: snap(p.y - d.dy) } : n)) }));
  };
  const onNodeUp = () => {
    drag.current = null;
  };

  const onPortDown = (e: ReactPointerEvent, n: LayerNode) => {
    e.stopPropagation();
    const p = toCanvas(e);
    setPending({ from: n.id, ...p });
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  };
  const onPortMove = (e: ReactPointerEvent) => {
    if (pending) setPending({ ...pending, ...toCanvas(e) });
  };
  const onPortUp = (e: ReactPointerEvent) => {
    if (!pending) return;
    const el = document.elementFromPoint(e.clientX, e.clientY) as HTMLElement | null;
    const target = el?.closest<HTMLElement>("[data-node]")?.dataset.node;
    if (target) connect(pending.from, target);
    setPending(null);
  };

  const onDrop = (e: DragEvent) => {
    const type = e.dataTransfer.getData(DRAG_TYPE) as LayerType;
    if (!type || !LAYER[type]) return;
    e.preventDefault();
    const p = toCanvas(e);
    // Dropped onto a layer: insert after it and connect.
    const onto = (document.elementFromPoint(e.clientX, e.clientY) as HTMLElement | null)?.closest<HTMLElement>("[data-node]")?.dataset.node;
    const from = onto ? byId.get(onto) : undefined;
    if (from) addLayer(type, from.x, from.y + H + 28, from.id);
    else addLayer(type, p.x - W / 2, p.y - H / 2);
  };

  const onKey = (e: React.KeyboardEvent) => {
    if ((e.key === "Delete" || e.key === "Backspace") && selected) {
      e.preventDefault();
      removeSelected();
    }
  };

  // -------------------------------------------------- actions

  const save = async (train: boolean) => {
    setBusy(train ? "train" : "save");
    try {
      const r = await api.builderSave(graph, train);
      refreshDesigns();
      if (train && r.command) {
        toast("success", `Training script written for ${r.datasetName}`, r.backupPath ? `You had edited ${r.trainPath}; that version is kept as ${r.backupPath}.` : `${r.trainPath} trains on ${r.datasetName} with its loader from Data.`);
        onTrain?.(r.command, r.machineId);
      } else toast("success", "Model saved", r.modelPath);
    } catch (e) {
      toast("error", "Couldn't save", errorMessage(e));
    } finally {
      setBusy(null);
    }
  };

  // Switching templates is instant (browsing them should be quick); the design it replaced can be restored.
  const applyTemplate = (id: string) => {
    const t = TEMPLATES.find((x) => x.id === id);
    if (!t) return;
    if (graph.nodes.length > 2 && !replaced && !activeTemplate) setReplaced(graph);
    // The template keeps the chosen dataset and is fitted to it.
    const made: ModelGraph = { ...t.make(), dataset: graph.dataset };
    setGraph(spec ? fitToData(made, spec).graph : made);
    setActiveTemplate(t.id);
    setSelected(null);
  };

  const chooseDataset = (id: string) => {
    const v = datasets.find((x) => x.dataset.id === id);
    const next: ModelGraph = { ...graph, dataset: id || undefined };
    if (!v) {
      setGraph(next);
      return;
    }
    const s = datasetSpec(v.dataset, v.profile);
    const fitted = fitToData(next, s);
    setGraph(fitted.graph);
    const fits = templatesFitting(s, v.dataset.name);
    if (!analyzeGraph(fitted.graph).ok && fits.length)
      toast("info", `This design can't take ${v.dataset.name} (${s.summary})`, `Pick a template under “Fits ${v.dataset.name}” in the template list, e.g. ${fits.slice(0, 3).map((t) => t.model).join(", ")}.`);
    else if (fitted.changes.length) toast("info", `Fitted to ${v.dataset.name}`, fitted.changes.join(" · "));
  };
  const fitNow = () => {
    if (!spec || !dataView) return;
    const fitted = fitToData(graph, spec);
    update(() => fitted.graph);
    toast(fitted.changes.length ? "info" : "success", fitted.changes.length ? `Fitted to ${dataView.dataset.name}` : "Nothing to change", fitted.changes.join(" · ") || "The Input and last layer already match. What's left needs a change to the layers in between.");
  };
  const undoTemplate = () => {
    if (!replaced) return;
    setGraph(replaced);
    setReplaced(null);
    setActiveTemplate(null);
    setSelected(null);
  };

  const sel = selected?.node ? byId.get(selected.node) : undefined;
  const width = Math.max(1200, ...graph.nodes.map((n) => n.x + W + (weightsOn ? 330 : 200)));
  const height = Math.max(900, ...graph.nodes.map((n) => n.y + H + 200));
  const problems = [...analysis.errors.map((e) => ({ id: null as string | null, text: e })), ...graph.nodes.filter((n) => analysis.nodes[n.id]?.error).map((n) => ({ id: n.id, text: `${LAYER[n.type].label}: ${analysis.nodes[n.id]!.error}` }))];
  const trainBlocker = !project
    ? "Open a project folder first"
    : !analysis.ok
      ? spec && fitting.length && !fitting.some((t) => t.id === activeTemplate)
        ? `This design doesn't fit ${dataView!.dataset.name} (${spec.summary}): pick a template under “Fits ${dataView!.dataset.name}”`
        : `Fix the problems first: ${problems[0]?.text ?? ""}`
      : !graph.dataset
        ? "Choose the dataset to train on first"
        : !dataView
          ? "The chosen dataset was removed from Data"
          : dataIssues.length
            ? dataIssues[0]!
            : null;

  return (
    <div className={`builder ${showWeights ? "with-weights" : ""}`}>
      <div className="builder-bar">
        <input className="input name" value={graph.name} onChange={(e) => update((g) => ({ ...g, name: e.target.value }))} aria-label="Model name" />
        <select className="select" style={{ width: 200 }} value={activeTemplate ?? ""} onChange={(e) => applyTemplate(e.target.value)} aria-label="Start from a template">
          <option value="">Start from a template…</option>
          <option value="blank">Blank</option>
          {fitting.length > 0 && (
            <optgroup label={`Fits ${dataView!.dataset.name} (${spec!.summary})`}>
              {fitting.map((t) => (
                <option key={`fit-${t.id}`} value={t.id}>
                  ✓ {t.model} · {t.label}
                </option>
              ))}
            </optgroup>
          )}
          {templateGroups().map((g) => (
            <optgroup key={g.data} label={g.data}>
              {g.templates.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.model} · {t.label}
                </option>
              ))}
            </optgroup>
          ))}
        </select>
        {replaced && (
          <button className="btn ghost sm" onClick={undoTemplate} title="Bring back the design this template replaced">
            Undo
          </button>
        )}
        <Database size={14} className="faint" aria-hidden />
        <select className={`select ${graph.dataset ? "" : "needs"}`} style={{ width: 200 }} value={graph.dataset ?? ""} onChange={(e) => chooseDataset(e.target.value)} aria-label="Dataset to train on" title={dataView ? `${dataView.dataset.path} on ${dataView.machineName ?? "?"}` : "The data this model trains on"}>
          <option value="">{datasets.length ? "Choose a dataset…" : "No datasets yet"}</option>
          {datasets.map((v) => (
            <option key={v.dataset.id} value={v.dataset.id}>
              {v.dataset.name} · {datasetSpec(v.dataset, v.profile).summary}
            </option>
          ))}
        </select>
        {!datasets.length && onOpenData && (
          <button className="btn sm" onClick={onOpenData}>
            Add in Data
          </button>
        )}
        {dataIssues.length > 0 && spec?.inputShape && (
          <button className="btn sm" onClick={fitNow} title="Set the Input to the dataset's examples and the last layer to its classes or targets">
            <Wand2 size={13} /> Fit to data
          </button>
        )}
        {designs.length > 0 && (
          <select className="select" style={{ width: 180 }} value="" onChange={(e) => { const d = designs.find((x) => x.file === e.target.value); if (d) { setGraph(d.graph); setSelected(null); setActiveTemplate(null); setReplaced(null); } }} aria-label="Open a saved design">
            <option value="">Open saved…</option>
            {designs.map((d) => (
              <option key={d.file} value={d.file}>
                {d.name}
              </option>
            ))}
          </select>
        )}
        <span className={`tag ${analysis.ok ? "ok" : "err"}`}>{analysis.ok ? `${formatParams(analysis.totalParams)} parameters` : `${problems.length} problem${problems.length === 1 ? "" : "s"}`}</span>
        <div className="spacer" />
        <button className={`btn ${showWeights ? "primary" : ""}`} onClick={toggleWeights} aria-pressed={showWeights} title="Show what training did to each layer's weights">
          <Activity size={14} /> Weights
        </button>
        <button className="btn" onClick={() => setImporting(true)} disabled={!project} title="Open a PyTorch model from this project's code as a graph">
          <FileCode size={14} /> From code
        </button>
        <button className={`btn ${showCode ? "primary" : ""}`} onClick={() => setShowCode(!showCode)}>
          <Code size={14} /> Code
        </button>
        <button className="btn" disabled={!analysis.ok || !!busy || !project} onClick={() => void save(false)} title={project ? "Write models/<name>.py into the project" : "Open a project folder first"}>
          {busy === "save" ? <LoaderCircle size={14} className="spin" /> : <Save size={14} />} Save
        </button>
        <button className="btn primary" disabled={!!trainBlocker || !!busy} onClick={() => void save(true)} title={trainBlocker ?? `Save, write a training script for ${dataView?.dataset.name}, and launch it on ${dataView?.machineName ?? "its machine"}`}>
          {busy === "train" ? <LoaderCircle size={14} className="spin" /> : <Play size={13} fill="currentColor" />} Train on GPU
        </button>
      </div>
      {dataView && spec && (
        <div className="suggest-bar">
          <span className="faint">
            Suggested for <b>{dataView.dataset.name}</b> <span className="mono">({spec.summary})</span>:
          </span>
          {fitting.length === 0 ? (
            <span className="faint">{spec.blockers[0] ?? "no template fits this data as it is; build one from the palette."}</span>
          ) : (
            fitting.map((t) => (
              <button key={t.id} className={`suggest ${activeTemplate === t.id ? "on" : ""}`} onClick={() => applyTemplate(t.id)} title={`${t.label}: trains as ${TRAIN_MODE_LABEL[t.mode]}`}>
                {t.model}
                {(t.mode === "reconstruct" || t.mode === "diffusion") && spec.task !== "none" ? <small> · {t.mode === "diffusion" ? "generative" : "unsupervised"}</small> : null}
              </button>
            ))
          )}
        </div>
      )}
      {trainBlocker && project && (
        <div className="train-blocker" role="status">
          <b>Can't train yet:</b> {trainBlocker}
        </div>
      )}

      {showWeights && (
        <div className="weights-bar">
          {modelRuns.length === 0 ? (
            <span className="faint">
              No training runs of this model yet. <b>Train on GPU</b>, and each layer's weights show here as they change. Your own scripts get this from <span className="mono">run.watch(model)</span>.
            </span>
          ) : (
            <>
              <select className="select" style={{ width: 220 }} value={activeRunId ?? ""} onChange={(e) => { setWeightsRun(e.target.value); setSnapIdx(null); }} aria-label="Training run">
                {modelRuns.map((r) => (
                  <option key={r.runId} value={r.runId}>
                    {r.name} · {r.machineName}
                  </option>
                ))}
              </select>
              {run && <StatusPill status={run.status} connection={run.connection} />}
              {run === undefined ? (
                <span className="faint">Loading…</span>
              ) : snaps.length === 0 ? (
                <span className="faint">{live ? "Waiting for the first weight snapshot…" : "This run has no weight snapshots. Runs record them when the script calls run.watch(model)."}</span>
              ) : (
                <>
                  <input className="w-slider" type="range" min={0} max={snaps.length - 1} value={idx} onChange={(e) => { const v = Number(e.target.value); setSnapIdx(v >= snaps.length - 1 ? null : v); }} aria-label="Training step" />
                  <span className="mono">
                    step {snaps[idx]?.step ?? "?"}
                    {snapIdx == null && live ? " · live" : ""}
                  </span>
                  <span className="faint">
                    {idx + 1}/{snaps.length} snapshots
                  </span>
                </>
              )}
            </>
          )}
        </div>
      )}

      {showWeights && run?.summary.examples && (
        <ExamplesStrip
          examples={run.summary.examples}
          predictions={snaps[idx]?.predictions}
          step={snaps[idx]?.step ?? null}
          binary={(analysis.ok && spec ? trainMode(graph, analysis, spec) : null) === "binary"}
        />
      )}

      <div className={`builder-main ${showCode ? "with-code" : ""}`}>
        <div className="palette">
          <div className="palette-search">
            <Search size={13} />
            <input
              value={layerQuery}
              onChange={(e) => setLayerQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Escape") setLayerQuery("");
                if (e.key === "Enter" && paletteLayers[0]) {
                  addAfterSelection(paletteLayers[0].type);
                  setLayerQuery("");
                }
              }}
              placeholder="Search layers"
              aria-label="Search layers"
              spellCheck={false}
            />
            {layerQuery && (
              <button className="palette-clear" onClick={() => setLayerQuery("")} aria-label="Clear search">
                <X size={12} />
              </button>
            )}
          </div>
          {paletteLayers.length === 0 && <div className="faint palette-empty">No layer matches “{layerQuery}”.</div>}
          {[...new Set(paletteLayers.map((l) => l.group))].map((group) => (
            <div key={group}>
              <div className="palette-group">{group}</div>
              {paletteLayers.filter((l) => l.group === group).map((l) => (
                <button
                  key={l.type}
                  className="palette-item"
                  draggable
                  onDragStart={(e) => {
                    e.dataTransfer.setData(DRAG_TYPE, l.type);
                    e.dataTransfer.effectAllowed = "copy";
                  }}
                  onClick={() => addAfterSelection(l.type)}
                  title="Drag onto the canvas, or click to add it after the selected layer"
                >
                  <LayerIcon type={l.type} size={14} />
                  <span className="palette-text">
                    {l.label}
                    <small>{l.blurb}</small>
                  </span>
                </button>
              ))}
            </div>
          ))}
        </div>

        <div className="canvas-wrap" tabIndex={0} onKeyDown={onKey} onDragOver={(e) => { if (e.dataTransfer.types.includes(DRAG_TYPE)) { e.preventDefault(); e.dataTransfer.dropEffect = "copy"; } }} onDrop={onDrop} onPointerDown={() => setSelected(null)}>
          <div className="canvas" ref={canvasRef} style={{ width, height }}>
            <svg width={width} height={height}>
              {graph.edges.map((e: Edge, i) => {
                const a = byId.get(e.from);
                const b = byId.get(e.to);
                if (!a || !b) return null;
                const d = wire(a.x + W / 2, a.y + H, b.x + W / 2, b.y);
                const label = fmtShape(analysis.nodes[a.id]?.shape ?? null).replace("B, ", "");
                const mx = (a.x + b.x) / 2 + W / 2;
                const my = (a.y + H + b.y) / 2;
                const on = selected?.edge === i;
                return (
                  <g key={`${e.from}-${e.to}`}>
                    <path className="wire-hit" d={d} onPointerDown={(ev) => { ev.stopPropagation(); setSelected({ edge: i }); }} />
                    <path className={`wire ${on ? "selected" : ""}`} d={d} />
                    {label !== "?" && b.y - (a.y + H) > 22 && (
                      <>
                        <rect className="wire-label-bg" x={mx + 6} y={my - 8} width={label.length * 6.4 + 6} height={15} rx={3} />
                        <text className="wire-label" x={mx + 9} y={my + 3}>
                          {label}
                        </text>
                      </>
                    )}
                  </g>
                );
              })}
              {pending && byId.get(pending.from) && <path className="wire pending" d={wire(byId.get(pending.from)!.x + W / 2, byId.get(pending.from)!.y + H, pending.x, pending.y)} />}
            </svg>
            {graph.nodes.map((n) => {
              const info = analysis.nodes[n.id];
              const spec = LAYER[n.type];
              const lw = weightsOn && modules[n.id] ? layerWeights(snaps, idx, modules[n.id]!) : null;
              return (
                <div
                  key={n.id}
                  data-node={n.id}
                  className={`layer-node ${selected?.node === n.id ? "selected" : ""} ${info?.error ? "bad" : ""} ${n.type === "Input" || n.type === "Output" ? "io" : ""} ${n.type === "Custom" ? "custom" : ""} ${lw ? `w-${lw.health}` : ""}`}
                  style={{ left: n.x, top: n.y }}
                  onPointerDown={(e) => onNodeDown(e, n)}
                  onPointerMove={onNodeMove}
                  onPointerUp={onNodeUp}
                  title={info?.error ?? undefined}
                >
                  {spec.inputs !== 0 && <div className={`port in ${pending ? "hot" : ""}`} data-port="in" data-node={n.id} />}
                  <div className="title">
                    <LayerIcon type={n.type} size={12} />
                    {spec.label}
                    <small>{summary(n)}</small>
                  </div>
                  {info?.error ? (
                    <div className="meta err">{info.error}</div>
                  ) : (
                    <div className="meta">
                      <span>{info?.shape ? fmtShape(info.shape) : "…"}</span>
                      {info && info.params > 0 && <span>{formatParams(info.params)}</span>}
                    </div>
                  )}
                  {n.type !== "Output" && <div className="port out" data-port="out" onPointerDown={(e) => onPortDown(e, n)} onPointerMove={onPortMove} onPointerUp={onPortUp} />}
                </div>
              );
            })}
            {weightsOn &&
              graph.nodes.map((n) => {
                const lw = modules[n.id] ? layerWeights(snaps, idx, modules[n.id]!) : null;
                return lw ? <NodeWeights key={`w-${n.id}`} lw={lw} x={n.x + W + 10} y={n.y + 2} /> : null;
              })}
          </div>
          {graph.nodes.length <= 2 && <div className="canvas-hint">Drag layers from the left onto the canvas, then drag from a layer's bottom dot to the next layer's top dot to connect them.</div>}
        </div>

        <div className="inspector">
          {sel && weightsOn ? (
            <>
              <h3>{LAYER[sel.type].label} weights</h3>
              <div className="faint" style={{ marginBottom: 12 }}>
                <span className="mono">{modules[sel.id] ?? "no parameters"}</span> at step {snaps[idx]?.step ?? "?"}
              </div>
              {modules[sel.id] ? <LayerWeightsDetail module={modules[sel.id]!} snapshots={snaps} index={idx} /> : <div className="faint">This layer has no weights.</div>}
            </>
          ) : !sel && weightsOn ? (
            <WeightsOverview snaps={snaps} idx={idx} graph={graph} modules={modules} onSelect={(id) => setSelected({ node: id })} />
          ) : sel ? (
            <Inspector node={sel} info={analysis.nodes[sel.id]} inputs={graph.edges.filter((e) => e.to === sel.id).map((e) => analysis.nodes[e.from]?.shape ?? null)} onParam={(k, v) => setParam(sel.id, k, v)} onDelete={removeSelected} />
          ) : (
            <>
              <h3>{graph.name || "Model"}</h3>
              <dl className="kv" style={{ marginBottom: 14 }}>
                <dt>Layers</dt>
                <dd>{graph.nodes.filter((n) => n.type !== "Input" && n.type !== "Output").length}</dd>
                <dt>Parameters</dt>
                <dd className="mono">{analysis.totalParams.toLocaleString()}</dd>
                <dt>Weights</dt>
                <dd className="mono">{formatBytes(analysis.totalParams * 4)} in fp32</dd>
                <dt>Training memory</dt>
                <dd className="mono" title="Weights, gradients and Adam state; activations come on top and grow with the batch size">≈ {formatBytes(analysis.totalParams * 16)} + activations</dd>
                <dt>Trains on</dt>
                <dd>{dataView ? `${dataView.dataset.name} (${spec?.summary}) on ${dataView.machineName ?? "?"}` : <span className="faint">no dataset chosen</span>}</dd>
                {mode && (
                  <>
                    <dt>Objective</dt>
                    <dd>{TRAIN_MODE_LABEL[mode]}</dd>
                  </>
                )}
              </dl>
              {dataIssues.length > 0 && (
                <>
                  <div className="label" style={{ marginBottom: 6 }}>
                    Data
                  </div>
                  {dataIssues.map((t, i) => (
                    <button key={i} className="problem warn" onClick={spec?.inputShape ? fitNow : undefined}>
                      {t}
                    </button>
                  ))}
                </>
              )}
              {!graph.dataset && (
                <div className="callout info" style={{ marginBottom: 12 }}>
                  Choose a dataset in the top bar to train this model. {datasets.length ? "The Input and last layer are fitted to it." : "Add one in Data first: a table, an image folder, or arrays in .npz / .pt."}
                </div>
              )}
              {problems.length > 0 ? (
                <>
                  <div className="label" style={{ marginBottom: 6 }}>
                    Problems
                  </div>
                  {problems.map((p, i) => (
                    <button key={i} className="problem" onClick={() => p.id && setSelected({ node: p.id })}>
                      {p.text}
                    </button>
                  ))}
                </>
              ) : (
                <div className="faint">
                  Select a layer to edit it. Delete removes the selected layer or connection. <b>Train on GPU</b> saves <span className="mono">models/{graph.name ? graph.name.toLowerCase().replace(/[^a-z0-9]+/g, "_") : "model"}.py</span> and a training script that reads the chosen dataset, then opens the launch dialog on the dataset's machine.
                </div>
              )}
              {designs.length > 0 && (
                <>
                  <div className="label" style={{ margin: "16px 0 6px" }}>
                    Saved in this project
                  </div>
                  {designs.map((d) => (
                    <button key={d.file} className="btn ghost sm" style={{ display: "flex", width: "100%" }} onClick={() => { setGraph(d.graph); setSelected(null); setActiveTemplate(null); setReplaced(null); }}>
                      <FolderOpen size={13} /> {d.name}
                    </button>
                  ))}
                </>
              )}
            </>
          )}
        </div>

        {showCode && (
          <div className="code-pane">
            <div className="row" style={{ marginBottom: 8 }}>
              <b>models/{graph.name.toLowerCase().replace(/[^a-z0-9]+/g, "_") || "model"}.py</b>
              <div className="spacer" />
              <button className="btn sm" disabled={!code.text} onClick={() => void navigator.clipboard.writeText(code.text).then(() => toast("success", "Copied"))}>
                <Copy size={13} /> Copy
              </button>
            </div>
            {code.error ? <div className="callout err">{code.error}</div> : <pre>{code.text}</pre>}
          </div>
        )}
      </div>
      {importing && (
        <CodeImportDialog
          state={state}
          initialFile={importFile}
          defaultShape={spec?.inputShape ?? null}
          defaultDtype={spec?.inputDtype}
          defaultMachine={dataView?.dataset.machineId ?? null}
          onClose={() => setImporting(false)}
          onImported={(s, notes) => {
            if (graph.nodes.length > 2 && !replaced) setReplaced(graph);
            setGraph({ ...s.graph, dataset: graph.dataset });
            setActiveTemplate(null);
            setSelected(null);
            const match = s.torchParams === s.graphParams;
            const lines = [
              `${s.graph.nodes.length} layers · ${s.graphParams.toLocaleString()} parameters${s.torchParams == null ? "" : match ? " (matches PyTorch)" : ` (PyTorch counts ${s.torchParams.toLocaleString()})`}.`,
              s.custom.length ? `${s.custom.length} block${s.custom.length === 1 ? "" : "s"} kept as "From your code": ${s.custom.slice(0, 3).join(", ")}${s.custom.length > 3 ? "…" : ""}.` : "Every layer became a builder layer, so it can be edited, saved and trained here.",
              ...notes,
              ...(s.ok ? [] : [s.errors[0] ?? ""]),
            ];
            toast(s.custom.length || !s.ok ? "info" : "success", `Opened ${s.graph.name} from code`, lines.filter(Boolean).join(" "));
          }}
        />
      )}
    </div>
  );
}

/** Weights view with nothing selected: the layers that look wrong, worst first. */
function WeightsOverview({ snaps, idx, graph, modules, onSelect }: { snaps: WeightsEvent[]; idx: number; graph: ModelGraph; modules: Record<string, string>; onSelect: (id: string) => void }) {
  const layers = graph.nodes.flatMap((n) => {
    const lw = modules[n.id] ? layerWeights(snaps, idx, modules[n.id]!) : null;
    return lw ? [{ node: n, lw }] : [];
  });
  const flagged = layers.filter((l) => l.lw.health !== "ok").sort((a, b) => (a.lw.health === b.lw.health ? 0 : a.lw.health === "error" ? -1 : 1));
  const known = new Set(Object.values(modules));
  const unmatched = [...new Set((snaps[idx]?.tensors ?? []).map((t) => moduleOf(t.name)).filter((m) => !known.has(m)))];
  return (
    <>
      <h3>Weights at step {snaps[idx]?.step ?? "?"}</h3>
      <div className="faint" style={{ marginBottom: 12 }}>
        Next to each layer: how its weights are distributed, their spread (σ) and gradient size (∇). Select a layer for its histogram, weight matrix and how it changed over training.
      </div>
      {flagged.length === 0 ? (
        <div className="callout info">All {layers.length} layers with weights look healthy: finite, spread out, and getting gradients.</div>
      ) : (
        flagged.map(({ node, lw }) => (
          <button key={node.id} className={`problem ${lw.health === "warning" ? "warn" : ""}`} onClick={() => onSelect(node.id)}>
            <b>{LAYER[node.type].label}</b> <span className="mono faint">{modules[node.id]}</span>
            <br />
            {lw.issues[0]!.message}
            {lw.issues.length > 1 ? ` (+${lw.issues.length - 1} more)` : ""}
          </button>
        ))
      )}
      {unmatched.length > 0 && (
        <div className="faint" style={{ marginTop: 12, fontSize: 12 }}>
          The run also has weights for {unmatched.slice(0, 4).join(", ")}
          {unmatched.length > 4 ? "…" : ""}, which aren't in this design. It was changed after the run started.
        </div>
      )}
    </>
  );
}

function Inspector({ node, info, inputs, onParam, onDelete }: { node: LayerNode; info: ReturnType<typeof analyzeGraph>["nodes"][string] | undefined; inputs: (number[] | null)[]; onParam: (key: string, v: number | string | boolean) => void; onDelete: () => void }) {
  const spec = LAYER[node.type];
  if (node.type === "Custom")
    return (
      <>
        <h3>From your code</h3>
        <div className="mono" style={{ marginBottom: 8 }}>
          {String(node.params.what)}
        </div>
        <div className="faint" style={{ marginBottom: 12 }}>
          Imported as is: no builder layer expresses it exactly. Its shape and parameters were measured by running your code. Replace it with builder layers to save or train this design from the builder; your original code still trains as it is.
        </div>
        <dl className="kv" style={{ margin: "12px 0" }}>
          <dt>In</dt>
          <dd className="mono">{inputs.length ? inputs.map(fmtShape).join(", ") : "—"}</dd>
          <dt>Out</dt>
          <dd className="mono">{fmtShape(info?.shape ?? null)}</dd>
          <dt>Parameters</dt>
          <dd className="mono">{(info?.params ?? 0).toLocaleString()}</dd>
        </dl>
        <button className="btn danger sm" onClick={onDelete}>
          <Trash2 size={13} /> Delete block
        </button>
      </>
    );
  return (
    <>
      <h3 className="row" style={{ gap: 8 }}>
        <LayerIcon type={node.type} size={14} />
        {spec.label}
      </h3>
      <div className="faint" style={{ marginBottom: 12 }}>
        {spec.blurb}
      </div>
      {spec.params.map((p) => (
        <ParamField key={p.key} spec={p} value={node.params[p.key] ?? p.default} onChange={(v) => onParam(p.key, v)} />
      ))}
      <dl className="kv" style={{ margin: "12px 0" }}>
        {spec.inputs !== 0 && (
          <>
            <dt>In</dt>
            <dd className="mono">{inputs.length ? inputs.map(fmtShape).join(", ") : "not connected"}</dd>
          </>
        )}
        <dt>Out</dt>
        <dd className="mono">{fmtShape(info?.shape ?? null)}</dd>
        <dt>Parameters</dt>
        <dd className="mono">{(info?.params ?? 0).toLocaleString()}</dd>
      </dl>
      {info?.error && <div className="callout err" style={{ marginBottom: 12 }}>{info.error}</div>}
      <button className="btn danger sm" onClick={onDelete}>
        <Trash2 size={13} /> Delete layer
      </button>
    </>
  );
}

function ParamField({ spec, value, onChange }: { spec: ParamSpec; value: number | string | boolean; onChange: (v: number | string | boolean) => void }) {
  return (
    <div className="field">
      <label>{spec.label}</label>
      {spec.kind === "bool" ? (
        <Switch on={!!value} onChange={onChange} label={spec.label} />
      ) : spec.kind === "choice" ? (
        <select className="select" value={String(value)} onChange={(e) => onChange(e.target.value)}>
          {spec.choices!.map((c) => (
            <option key={c}>{c}</option>
          ))}
        </select>
      ) : spec.kind === "shape" ? (
        <input className="input mono" value={String(value)} onChange={(e) => onChange(e.target.value)} />
      ) : (
        <input
          className="input mono"
          type="number"
          step={spec.kind === "float" ? "any" : 1}
          min={spec.min}
          value={String(value)}
          onChange={(e) => onChange(e.target.value === "" ? "" : spec.kind === "int" ? Math.round(Number(e.target.value)) : Number(e.target.value))}
        />
      )}
      {spec.hint && <span className="hint">{spec.hint}</span>}
    </div>
  );
}
