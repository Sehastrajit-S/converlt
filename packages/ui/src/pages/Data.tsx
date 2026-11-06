import { Fragment, useEffect, useMemo, useState, type ReactNode } from "react";
import { ArrowDown, ArrowUp, ChevronRight, Database, FileCode, Folder, FolderOpen, LoaderCircle, Play, Plus, RefreshCw, Sparkles, Table2, Trash2, Wand2, X } from "lucide-react";
import {
  dataInsights,
  defaultStep,
  describeStep,
  generateLoaderCode,
  IMAGE_OPS,
  STEP_LABEL,
  type ColumnProfile,
  type DataInsight,
  type DataProfile,
  type DatasetRef,
  type PreprocessStep,
  type StepOp,
  type TensorProfile,
} from "@converge/run-protocol";
import type { AppState, BrowseResult, DatasetView, PreprocessPreview } from "@converge/core/api";
import { api, errorMessage, ask } from "../api.ts";
import { Dialog, Empty, Switch, useToast } from "../components/ui.tsx";
import { formatBytes, formatDate, formatNumber } from "../format.ts";

type Tab = "explore" | "preprocess" | "load";

/** Data loading, EDA and preprocessing for the project's datasets, which live on GPU machines. */
export function Data({ state, onOpenRun }: { state: AppState; onOpenRun?: (runId: string) => void }) {
  const toast = useToast();
  const [views, setViews] = useState<DatasetView[] | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [tab, setTab] = useState<Tab>("explore");

  const reload = async (select?: string) => {
    try {
      const list = await api.dataList();
      setViews(list);
      setSelectedId((cur) => select ?? (cur && list.some((v) => v.dataset.id === cur) ? cur : (list[0]?.dataset.id ?? null)));
    } catch (e) {
      toast("error", "Couldn't load datasets", errorMessage(e));
      setViews([]);
    }
  };
  const [syncing, setSyncing] = useState(false);
  useEffect(() => {
    void reload();
    // Datasets downloaded from Datasets & models show up here without adding them by hand.
    if (!state.project) return;
    setSyncing(true);
    api
      .dataSyncHub()
      .then(async (added) => {
        if (!added.length) return;
        await reload();
        toast("success", `Added ${added.length} downloaded dataset${added.length === 1 ? "" : "s"}`, added.map((v) => v.dataset.name).join(", ") + ". Profile them to explore and train on them.");
      })
      .catch(() => {})
      .finally(() => setSyncing(false));
  }, [state.project?.path]); // eslint-disable-line react-hooks/exhaustive-deps

  const view = views?.find((v) => v.dataset.id === selectedId) ?? null;
  const replace = (v: DatasetView) => setViews((vs) => (vs ?? []).map((x) => (x.dataset.id === v.dataset.id ? v : x)));

  if (!state.project)
    return (
      <div className="page">
        <Empty icon={<Database size={22} />} title="Open a project folder">
          Datasets are registered per project, next to its code and runs.
        </Empty>
      </div>
    );

  return (
    <div className="page data-page">
      <div className="page-header">
        <div>
          <h1 className="page-title">Data</h1>
          <div className="page-sub">Load a dataset where it lives, explore it, and build the preprocessing and DataLoaders your training script uses.</div>
        </div>
        <div className="spacer" />
        {syncing && (
          <span className="faint row" style={{ gap: 6, fontSize: 12 }}>
            <LoaderCircle size={13} className="spin" /> Checking downloads…
          </span>
        )}
        <button className="btn primary" onClick={() => setAdding(true)} disabled={!state.machines.length} title={state.machines.length ? undefined : "Add a GPU machine first"}>
          <Plus size={14} /> Add dataset
        </button>
      </div>

      {views === null ? (
        <div className="empty">
          <LoaderCircle className="spin" />
        </div>
      ) : views.length === 0 ? (
        <div className="card">
          <Empty icon={<Database size={22} />} title="No datasets yet" action={<button className="btn primary" onClick={() => setAdding(true)} disabled={!state.machines.length}><Plus size={14} /> Add dataset</button>}>
            Point Converlt at a CSV, Parquet or JSON-lines file, a folder of class sub-folders of images, or .npz / .pt arrays, on any of your machines. It's profiled there; nothing is copied to this computer. Datasets you download in Datasets &amp; models appear here by themselves.
          </Empty>
        </div>
      ) : (
        <div className="data-layout">
          <div className="data-list">
            {views.map((v) => (
              <button key={v.dataset.id} className={`data-item ${v.dataset.id === selectedId ? "on" : ""}`} onClick={() => setSelectedId(v.dataset.id)}>
                <b className="truncate">{v.dataset.name}</b>
                <span className="faint truncate">
                  {v.dataset.source ? `${v.dataset.source.hub === "huggingface" ? "Hugging Face" : "Kaggle"} · ` : ""}
                  {v.dataset.format === "unknown" ? "not profiled" : v.dataset.format} · {v.machineName ?? "machine removed"}
                </span>
              </button>
            ))}
          </div>
          {view && (
            <div style={{ minWidth: 0 }}>
              <DatasetHeader view={view} onRemoved={() => void reload()} />
              <div className="tabs">
                {(
                  [
                    ["explore", "Explore", <Sparkles key="e" size={13} />],
                    ["preprocess", "Preprocess", <Wand2 key="p" size={13} />],
                    ["load", "Load for training", <FileCode key="l" size={13} />],
                  ] as [Tab, string, ReactNode][]
                ).map(([id, label, icon]) => (
                  <button key={id} className={`tab ${tab === id ? "on" : ""}`} onClick={() => setTab(id)}>
                    {icon} {label}
                    {id === "preprocess" && view.dataset.steps.length > 0 && <span className="badge">{view.dataset.steps.length}</span>}
                  </button>
                ))}
              </div>
              {tab === "explore" && <Explore view={view} onChanged={replace} onGoPreprocess={() => setTab("preprocess")} />}
              {tab === "preprocess" &&
                (view.dataset.format === "tensors" ? (
                  <div className="callout info">Array files are used as saved: there are no preprocessing steps. Scale, encode or window the data before saving it as .npz or .pt.</div>
                ) : (
                  <Preprocess view={view} onChanged={replace} onOpenRun={onOpenRun} />
                ))}
              {tab === "load" && <Load view={view} />}
            </div>
          )}
        </div>
      )}
      {adding && <AddDatasetDialog state={state} onClose={() => setAdding(false)} onAdded={(v) => { setAdding(false); void reload(v.dataset.id); setTab("explore"); }} />}
    </div>
  );
}

// ---------------------------------------------------------------- header

async function saveDataset(d: DatasetRef): Promise<DatasetView> {
  return api.dataSave({ id: d.id, name: d.name, machineId: d.machineId, path: d.path, format: d.format, target: d.target, steps: d.steps });
}

function DatasetHeader({ view, onRemoved }: { view: DatasetView; onRemoved: () => void }) {
  const toast = useToast();
  const d = view.dataset;
  const remove = async () => {
    if (!(await ask(`Remove ${d.name} from this project? The data on the machine isn't touched.`, "Remove"))) return;
    await api.dataRemove(d.id);
    onRemoved();
  };
  const p = view.profile;
  return (
    <div className="card" style={{ marginBottom: 12 }}>
      <div className="card-body row wrap" style={{ gap: 18 }}>
        <div style={{ minWidth: 0, flex: 1 }}>
          <div className="row" style={{ gap: 8 }}>
            <h2 style={{ margin: 0, fontSize: 17 }}>{d.name}</h2>
            <span className="tag">{d.format}</span>
          </div>
          <div className="mono faint selectable truncate" style={{ fontSize: 12, marginTop: 3 }}>
            {view.machineName ?? "?"}:{d.path}
          </div>
        </div>
        {p && (
          <div className="row" style={{ gap: 18 }}>
            {p.kind === "tabular" ? (
              <>
                <Fig label="Rows" value={p.rows.toLocaleString()} />
                <Fig label="Columns" value={String(p.columns.length)} />
              </>
            ) : p.kind === "tensors" ? (
              <>
                <Fig label="Examples" value={p.splits.reduce((a, s) => a + s.count, 0).toLocaleString()} />
                <Fig label="Each" value={p.x.shape.join("×") || "scalar"} />
                {p.y?.classes ? <Fig label="Classes" value={String(p.y.classes)} /> : null}
              </>
            ) : (
              <>
                <Fig label="Images" value={p.files.toLocaleString()} />
                <Fig label="Classes" value={String(p.classes.length)} />
              </>
            )}
            <Fig label="Size" value={formatBytes(p.bytes)} />
          </div>
        )}
        <button className="btn ghost sm icon" title="Remove from project" onClick={() => void remove().catch((e) => toast("error", "Couldn't remove", errorMessage(e)))}>
          <Trash2 size={14} />
        </button>
      </div>
    </div>
  );
}

function Fig({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="faint" style={{ fontSize: 11 }}>
        {label}
      </div>
      <div style={{ fontWeight: 650, fontSize: 16 }} className="tabular">
        {value}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- explore (EDA)

function Explore({ view, onChanged, onGoPreprocess }: { view: DatasetView; onChanged: (v: DatasetView) => void; onGoPreprocess: () => void }) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const d = view.dataset;
  const p = view.profile;
  const insights = useMemo(() => (p ? dataInsights(p, d.steps) : []), [p, d.steps]);

  const profile = async (next?: DatasetRef) => {
    setBusy(true);
    try {
      if (next) await saveDataset(next);
      onChanged(await api.dataProfile(d.id));
    } catch (e) {
      toast("error", "Profiling failed", errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  const addFix = async (i: DataInsight) => {
    if (!i.fix) return;
    try {
      onChanged(await saveDataset({ ...d, steps: [...d.steps, i.fix] }));
      toast("success", "Added to the pipeline", `${STEP_LABEL[i.fix.op]}: ${describeStep(i.fix)}`);
    } catch (e) {
      toast("error", "Couldn't add it", errorMessage(e));
    }
  };
  const addAll = async () => {
    const fixes = insights.filter((i) => i.fix).map((i) => i.fix!);
    onChanged(await saveDataset({ ...d, steps: [...d.steps, ...fixes] }));
    toast("success", `Added ${fixes.length} steps`, "Review them on the Preprocess tab.");
    onGoPreprocess();
  };

  if (!p)
    return (
      <div className="card">
        <Empty icon={<Sparkles size={22} />} title="Not profiled yet" action={<button className="btn primary" disabled={busy} onClick={() => void profile()}>{busy ? <LoaderCircle size={14} className="spin" /> : <Play size={13} />} Profile on {view.machineName}</button>}>
          Reads a sample (up to 50,000 rows, or 400 images) on the machine and reports types, missing values, distributions, duplicates, class balance and leakage.
        </Empty>
      </div>
    );

  const fixable = insights.filter((i) => i.fix).length;
  return (
    <div className="col" style={{ gap: 12 }}>
      <div className="row wrap" style={{ gap: 10 }}>
        {p.kind === "tabular" && (
          <label className="row" style={{ gap: 8 }}>
            <span className="faint">Predict</span>
            <select className="select" style={{ width: 200 }} value={d.target ?? ""} disabled={busy} onChange={(e) => void profile({ ...d, target: e.target.value || undefined })}>
              <option value="">(no target)</option>
              {p.columns.map((c) => (
                <option key={c.name} value={c.name}>
                  {c.name}
                </option>
              ))}
            </select>
          </label>
        )}
        <span className="faint" style={{ fontSize: 12 }}>
          {p.kind === "tabular" ? `Sampled ${p.rowsSampled.toLocaleString()} of ${p.rows.toLocaleString()} rows with ${p.engine}` : p.kind === "tensors" ? `Read ${p.splits.map((s) => s.name).join(", ")} (${p.splits.length} file${p.splits.length === 1 ? "" : "s"})` : `Checked ${p.checked} of ${p.files.toLocaleString()} images`}
          {view.profiledAt ? ` · ${formatDate(view.profiledAt / 1000)}` : ""}
        </span>
        <div className="spacer" />
        <button className="btn sm" disabled={busy} onClick={() => void profile()}>
          {busy ? <LoaderCircle size={13} className="spin" /> : <RefreshCw size={13} />} Profile again
        </button>
      </div>

      {insights.length > 0 && (
        <div className="card">
          <div className="card-head">
            <Sparkles size={15} />
            <div className="card-title">What to fix</div>
            <div className="spacer" />
            {fixable > 1 && (
              <button className="btn sm primary" onClick={() => void addAll()}>
                <Wand2 size={13} /> Add all {fixable} fixes
              </button>
            )}
          </div>
          <div className="card-body col" style={{ gap: 8 }}>
            {insights.map((i, k) => (
              <div key={k} className={`insight ${i.severity}`}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <b>{i.title}</b>
                  <div className="muted">{i.detail}</div>
                </div>
                {i.fix && (
                  <button className="btn sm" onClick={() => void addFix(i)} title={`${STEP_LABEL[i.fix.op]}: ${describeStep(i.fix)}`}>
                    <Plus size={13} /> {STEP_LABEL[i.fix.op]}
                  </button>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {p.kind === "tabular" ? <ColumnsTable p={p} target={d.target} /> : p.kind === "tensors" ? <TensorsView p={p} /> : <ImagesView p={p} />}
    </div>
  );
}

/** Array datasets: what one example is, the splits, and the labels. */
function TensorsView({ p }: { p: TensorProfile }) {
  const n = (v: number | null) => (v == null ? "—" : Math.abs(v) >= 1e4 || (Math.abs(v) < 1e-3 && v !== 0) ? v.toExponential(2) : String(Number(v.toPrecision(4))));
  const top = p.y?.counts.slice(0, 20) ?? [];
  const max = Math.max(1, ...top.map((c) => c.count));
  return (
    <div className="card">
      <div className="card-head">
        <div className="card-title">Arrays</div>
      </div>
      <div className="card-body col" style={{ gap: 12 }}>
        <dl className="kv">
          <dt>Inputs ({p.keys.x})</dt>
          <dd className="mono">
            {p.x.shape.join(" × ") || "scalar"} {p.x.dtype}
            {p.x.integer ? ` · ids up to ${n(p.x.max)}` : ` · min ${n(p.x.min)} · max ${n(p.x.max)} · mean ${n(p.x.mean)} · std ${n(p.x.std)}`}
          </dd>
          <dt>Labels</dt>
          <dd className="mono">{p.y ? `${p.keys.y}: ${p.y.shape.length ? `${p.y.shape.join(" × ")} per example, ` : ""}${p.y.dtype}${p.y.classes ? ` · ${p.y.classes} classes` : " · numeric targets"}` : "none"}</dd>
          {p.splits.map((s) => (
            <Fragment key={s.name}>
              <dt>{s.name}</dt>
              <dd className="mono">
                {s.count.toLocaleString()} <span className="faint">· {s.file}</span>
              </dd>
            </Fragment>
          ))}
        </dl>
        {top.length > 1 && (
          <div>
            <div className="label" style={{ marginBottom: 6 }}>
              Examples per class
            </div>
            {top.map((c) => (
              <div key={c.value} className="row" style={{ gap: 8, fontSize: 12 }}>
                <span className="mono" style={{ width: 60, textAlign: "right" }}>
                  {c.value}
                </span>
                <span style={{ height: 8, width: (c.count / max) * 240, background: "var(--accent)", borderRadius: 2 }} />
                <span className="faint">{c.count.toLocaleString()}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function Histogram({ counts, width = 120, height = 28, color = "var(--accent)" }: { counts: number[]; width?: number; height?: number; color?: string }) {
  const max = Math.max(...counts, 1);
  const w = width / counts.length;
  return (
    <svg width={width} height={height} role="img" aria-label="distribution">
      {counts.map((c, i) => {
        const h = Math.max(c > 0 ? 1 : 0, (c / max) * height);
        return <rect key={i} x={i * w + 0.5} y={height - h} width={Math.max(1, w - 1)} height={h} fill={color} opacity={0.85} />;
      })}
    </svg>
  );
}

function ColumnsTable({ p, target }: { p: Extract<DataProfile, { kind: "tabular" }>; target?: string }) {
  const n = p.rowsSampled || 1;
  return (
    <div className="card" style={{ overflow: "auto" }}>
      <table className="table">
        <thead>
          <tr>
            <th>Column</th>
            <th>Type</th>
            <th className="num">Missing</th>
            <th className="num">Unique</th>
            <th>Distribution</th>
            <th>Summary</th>
            {p.target && <th className="num" title="How strongly the column alone tracks the target">vs {p.target}</th>}
          </tr>
        </thead>
        <tbody>
          {p.columns.map((c) => (
            <tr key={c.name}>
              <td className="mono">
                {c.name} {c.name === target && <span className="tag accent">target</span>}
              </td>
              <td>
                <span className="tag">{c.dtype}</span>
              </td>
              <td className={`num mono ${c.missing / n > 0.2 ? "warn-text" : ""}`}>{c.missing ? `${((100 * c.missing) / n).toFixed(1)}%` : "—"}</td>
              <td className="num mono">{c.unique.toLocaleString()}</td>
              <td>{c.numeric ? <Histogram counts={c.numeric.hist.counts} /> : c.top ? <TopBars c={c} /> : null}</td>
              <td className="faint" style={{ fontSize: 12 }}>
                <ColumnSummary c={c} />
              </td>
              {p.target && <td className={`num mono ${leaky(c) ? "err-text" : ""}`}>{c.name === p.target ? "" : c.targetCorr !== undefined ? c.targetCorr.toFixed(2) : c.targetPurity !== undefined ? `${Math.round(c.targetPurity * 100)}% pure` : "—"}</td>}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

const leaky = (c: ColumnProfile) => (c.targetCorr !== undefined && Math.abs(c.targetCorr) > 0.98) || (c.targetPurity !== undefined && c.targetPurity > 0.995);

function TopBars({ c }: { c: ColumnProfile }) {
  return <Histogram counts={(c.top ?? []).slice(0, 12).map((t) => t.count)} color="var(--s2)" />;
}

function ColumnSummary({ c }: { c: ColumnProfile }) {
  if (c.numeric) {
    const s = c.numeric;
    return (
      <>
        {formatNumber(s.min)} … {formatNumber(s.max)} · mean {formatNumber(s.mean)} · median {formatNumber(s.p50)}
        {s.outliers ? ` · ${s.outliers} outliers` : ""}
      </>
    );
  }
  if (c.text) return <>~{Math.round(c.text.meanWords)} words, up to {c.text.maxLen} chars</>;
  return <>{(c.top ?? []).slice(0, 3).map((t) => `${t.value} (${t.count})`).join(", ")}{c.unique > 3 ? ", …" : ""}</>;
}

function ImagesView({ p }: { p: Extract<DataProfile, { kind: "images" }> }) {
  const max = Math.max(...p.classes.map((c) => c.count), 1);
  return (
    <div className="grid-2" style={{ alignItems: "start" }}>
      <div className="card">
        <div className="card-head">
          <div className="card-title">Classes</div>
          <div className="spacer" />
          {p.splits.length > 0 && <span className="faint">splits: {p.splits.join(", ")}</span>}
        </div>
        <div className="card-body col" style={{ gap: 6 }}>
          {p.classes.slice(0, 40).map((c) => (
            <div key={c.name} className="row" style={{ gap: 8 }}>
              <span className="mono truncate" style={{ width: 140 }}>
                {c.name}
              </span>
              <div style={{ flex: 1, height: 8, background: "var(--surface-3)", borderRadius: 4 }}>
                <div style={{ width: `${(100 * c.count) / max}%`, height: "100%", background: "var(--accent)", borderRadius: 4 }} />
              </div>
              <span className="mono faint" style={{ width: 60, textAlign: "right" }}>
                {c.count.toLocaleString()}
              </span>
            </div>
          ))}
          {p.classes.length > 40 && <span className="faint">and {p.classes.length - 40} more</span>}
        </div>
      </div>
      <div className="card">
        <div className="card-head">
          <div className="card-title">Images</div>
        </div>
        <div className="card-body">
          <dl className="kv">
            <dt>Sizes</dt>
            <dd className="mono">{p.sizes.length ? p.sizes.slice(0, 5).map((s) => `${s.size} (${s.count})`).join(", ") : "—"}</dd>
            <dt>Color modes</dt>
            <dd className="mono">{Object.entries(p.modes).map(([m, n]) => `${m} (${n})`).join(", ") || "—"}</dd>
            <dt>Unreadable</dt>
            <dd className={p.corrupt ? "err-text" : ""}>{p.pillow ? `${p.corrupt} of ${p.checked} checked` : "not checked (Pillow isn't installed)"}</dd>
          </dl>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- preprocess

const TABULAR_OPS: StepOp[] = ["drop_columns", "drop_duplicates", "drop_missing_rows", "fill_missing", "clip_outliers", "log1p", "encode", "scale", "split"];

function Preprocess({ view, onChanged, onOpenRun }: { view: DatasetView; onChanged: (v: DatasetView) => void; onOpenRun?: (runId: string) => void }) {
  const toast = useToast();
  const d = view.dataset;
  const p = view.profile;
  const images = d.format === "images";
  const [preview, setPreview] = useState<PreprocessPreview | null>(null);
  const [busy, setBusy] = useState<"preview" | "run" | null>(null);
  const columns = p?.kind === "tabular" ? p.columns.map((c) => c.name).filter((c) => c !== d.target) : [];

  const setSteps = async (steps: PreprocessStep[]) => {
    try {
      onChanged(await saveDataset({ ...d, steps }));
      setPreview(null);
    } catch (e) {
      toast("error", "Couldn't save the pipeline", errorMessage(e));
    }
  };
  const move = (i: number, by: number) => {
    const s = [...d.steps];
    const [x] = s.splice(i, 1);
    s.splice(Math.max(0, Math.min(s.length, i + by)), 0, x!);
    void setSteps(s);
  };
  const runPreview = async () => {
    setBusy("preview");
    try {
      setPreview(await api.dataPreview(d.id));
    } catch (e) {
      toast("error", "Preview failed", errorMessage(e));
    } finally {
      setBusy(null);
    }
  };
  const runAll = async () => {
    setBusy("run");
    try {
      const { runId } = await api.dataRunPreprocess(d.id);
      toast("success", "Preprocessing started", `Running on ${view.machineName} as a tracked run. The processed splits go next to the data.`);
      onOpenRun?.(runId);
    } catch (e) {
      toast("error", "Couldn't start preprocessing", errorMessage(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="col" style={{ gap: 12 }}>
      <div className="card">
        <div className="card-head">
          <Wand2 size={15} />
          <div className="card-title">{images ? "Transforms" : "Pipeline"}</div>
          <div className="spacer" />
          <select className="select" style={{ width: 210 }} value="" onChange={(e) => e.target.value && void setSteps([...d.steps, defaultStep(e.target.value as StepOp, p, d.target)])}>
            <option value="">Add a step…</option>
            {(images ? IMAGE_OPS : TABULAR_OPS).map((op) => (
              <option key={op} value={op}>
                {STEP_LABEL[op]}
              </option>
            ))}
          </select>
        </div>
        <div className="card-body col" style={{ gap: 8 }}>
          {d.steps.length === 0 && <span className="faint">No steps yet. Add fixes from the Explore tab, or add steps here.</span>}
          {d.steps.map((s, i) => (
            <div key={i} className="step-row">
              <span className="step-num">{i + 1}</span>
              <div style={{ flex: 1, minWidth: 0 }}>
                <b>{STEP_LABEL[s.op]}</b>
                <StepEditor step={s} columns={columns} onChange={(next) => void setSteps(d.steps.map((x, j) => (j === i ? next : x)))} />
              </div>
              <button className="btn ghost sm icon" disabled={i === 0} onClick={() => move(i, -1)} title="Move up">
                <ArrowUp size={13} />
              </button>
              <button className="btn ghost sm icon" disabled={i === d.steps.length - 1} onClick={() => move(i, 1)} title="Move down">
                <ArrowDown size={13} />
              </button>
              <button className="btn ghost sm icon" onClick={() => void setSteps(d.steps.filter((_, j) => j !== i))} title="Remove">
                <X size={13} />
              </button>
            </div>
          ))}
          {!images && d.steps.length > 0 && (
            <div className="faint" style={{ fontSize: 12 }}>
              Row filters run first, then the split. Fill, clip, log, encode and scale learn their values on the training split only and run in that order, so validation never leaks into training.
            </div>
          )}
        </div>
      </div>

      {!images && (
        <div className="row" style={{ gap: 8 }}>
          <button className="btn" disabled={!!busy || !d.steps.length} onClick={() => void runPreview()}>
            {busy === "preview" ? <LoaderCircle size={14} className="spin" /> : <Table2 size={14} />} Preview on 200 rows
          </button>
          <button className="btn primary" disabled={!!busy || !d.steps.length} onClick={() => void runAll()}>
            {busy === "run" ? <LoaderCircle size={14} className="spin" /> : <Play size={13} fill="currentColor" />} Run on the full dataset
          </button>
          <span className="faint" style={{ fontSize: 12 }}>
            Writes data/preprocess_{d.name.toLowerCase().replace(/[^a-z0-9]+/g, "_")}.py and runs it on {view.machineName} as a tracked run.
          </span>
        </div>
      )}
      {preview && <PreviewView preview={preview} />}
    </div>
  );
}

function Chips({ all, selected, onChange }: { all: string[]; selected: string[]; onChange: (s: string[]) => void }) {
  if (!all.length) return <input className="input mono" style={{ marginTop: 6 }} placeholder="column, column" value={selected.join(", ")} onChange={(e) => onChange(e.target.value.split(",").map((x) => x.trim()).filter(Boolean))} />;
  return (
    <div className="row wrap" style={{ gap: 4, marginTop: 6 }}>
      {all.map((c) => {
        const on = selected.includes(c);
        return (
          <button key={c} className={`chip ${on ? "on" : ""}`} onClick={() => onChange(on ? selected.filter((x) => x !== c) : [...selected, c])}>
            {c}
          </button>
        );
      })}
    </div>
  );
}

function StepEditor({ step, columns, onChange }: { step: PreprocessStep; columns: string[]; onChange: (s: PreprocessStep) => void }) {
  const num = (v: string, d: number) => (Number.isFinite(Number(v)) && v !== "" ? Number(v) : d);
  const select = <T extends string>(value: T, options: [T, string][], set: (v: T) => void) => (
    <select className="select" style={{ width: 150, height: 28 }} value={value} onChange={(e) => set(e.target.value as T)}>
      {options.map(([v, l]) => (
        <option key={v} value={v}>
          {l}
        </option>
      ))}
    </select>
  );
  switch (step.op) {
    case "drop_columns":
    case "drop_missing_rows":
    case "log1p":
      return <Chips all={columns} selected={step.columns} onChange={(columns) => onChange({ ...step, columns })} />;
    case "drop_duplicates":
      return <div className="faint">Rows identical in every column.</div>;
    case "fill_missing":
      return (
        <>
          <div className="row" style={{ gap: 8, marginTop: 6 }}>
            {select(step.strategy, [["median", "median"], ["mean", "mean"], ["mode", "most common"], ["constant", "a constant"]], (strategy) => onChange({ ...step, strategy }))}
            {step.strategy === "constant" && <input className="input mono" style={{ width: 120, height: 28 }} value={step.value ?? ""} onChange={(e) => onChange({ ...step, value: e.target.value })} />}
          </div>
          <Chips all={columns} selected={step.columns} onChange={(columns) => onChange({ ...step, columns })} />
        </>
      );
    case "clip_outliers":
      return (
        <>
          <div className="row" style={{ gap: 8, marginTop: 6 }}>
            <span className="faint">percentiles</span>
            <input className="input mono" style={{ width: 70, height: 28 }} value={step.lower} onChange={(e) => onChange({ ...step, lower: num(e.target.value, 0.01) })} />
            <span className="faint">to</span>
            <input className="input mono" style={{ width: 70, height: 28 }} value={step.upper} onChange={(e) => onChange({ ...step, upper: num(e.target.value, 0.99) })} />
          </div>
          <Chips all={columns} selected={step.columns} onChange={(columns) => onChange({ ...step, columns })} />
        </>
      );
    case "encode":
      return (
        <>
          <div style={{ marginTop: 6 }}>{select(step.method, [["onehot", "one-hot"], ["ordinal", "integers"]], (method) => onChange({ ...step, method }))}</div>
          <Chips all={columns} selected={step.columns} onChange={(columns) => onChange({ ...step, columns })} />
        </>
      );
    case "scale":
      return (
        <>
          <div style={{ marginTop: 6 }}>{select(step.method, [["standard", "mean 0, std 1"], ["minmax", "0 to 1"]], (method) => onChange({ ...step, method }))}</div>
          <Chips all={columns} selected={step.columns} onChange={(columns) => onChange({ ...step, columns })} />
        </>
      );
    case "split":
      return (
        <div className="row wrap" style={{ gap: 8, marginTop: 6 }}>
          <span className="faint">validation</span>
          <input className="input mono" style={{ width: 64, height: 28 }} value={step.val} onChange={(e) => onChange({ ...step, val: num(e.target.value, 0.1) })} />
          <span className="faint">test</span>
          <input className="input mono" style={{ width: 64, height: 28 }} value={step.test} onChange={(e) => onChange({ ...step, test: num(e.target.value, 0.1) })} />
          <span className="faint">seed</span>
          <input className="input mono" style={{ width: 64, height: 28 }} value={step.seed} onChange={(e) => onChange({ ...step, seed: Math.round(num(e.target.value, 0)) })} />
          <label className="row" style={{ gap: 6 }}>
            <Switch on={step.stratify} onChange={(stratify) => onChange({ ...step, stratify })} label="Stratify" /> stratify by target
          </label>
        </div>
      );
    case "image_resize":
      return (
        <div className="row" style={{ gap: 8, marginTop: 6 }}>
          <input className="input mono" style={{ width: 80, height: 28 }} value={step.size} onChange={(e) => onChange({ ...step, size: Math.round(num(e.target.value, 224)) })} />
          <span className="faint">pixels square</span>
        </div>
      );
    case "image_augment":
      return (
        <div className="row wrap" style={{ gap: 14, marginTop: 6 }}>
          {(["crop", "flip", "colorJitter"] as const).map((k) => (
            <label key={k} className="row" style={{ gap: 6 }}>
              <Switch on={step[k]} onChange={(v) => onChange({ ...step, [k]: v })} label={k} /> {k === "crop" ? "random crop" : k === "flip" ? "horizontal flip" : "color jitter"}
            </label>
          ))}
        </div>
      );
    case "image_normalize":
      return <div style={{ marginTop: 6 }}>{select(step.mode, [["imagenet", "ImageNet mean/std"], ["none", "none"]], (mode) => onChange({ ...step, mode }))}</div>;
  }
}

function PreviewView({ preview }: { preview: PreprocessPreview }) {
  const table = (t: PreprocessPreview["before"]) => (
    <div style={{ overflow: "auto", maxHeight: 280 }}>
      <table className="table">
        <thead>
          <tr>
            {t.columns.map((c) => (
              <th key={c} className="mono">
                {c}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {t.rows.map((r, i) => (
            <tr key={i}>
              {t.columns.map((c) => (
                <td key={c} className="mono" style={{ fontSize: 11.5 }}>
                  {r[c] === null || r[c] === undefined ? <span className="faint">∅</span> : typeof r[c] === "number" ? formatNumber(r[c] as number) : String(r[c])}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
  return (
    <div className="card">
      <div className="card-head">
        <Table2 size={15} />
        <div className="card-title">Preview</div>
        <div className="spacer" />
        <span className="faint">
          {preview.before.shape.join(" × ")} → {preview.after.shape.join(" × ")} · {Object.entries(preview.splits).map(([k, v]) => `${k} ${v}`).join(", ")}
        </span>
      </div>
      <div className="card-body col" style={{ gap: 10 }}>
        {preview.nonNumeric.length > 0 && <div className="callout">Still not numbers: <span className="mono">{preview.nonNumeric.join(", ")}</span>. Encode or drop them before training a neural network.</div>}
        {preview.missing > 0 && <div className="callout">{preview.missing} missing values remain after the pipeline.</div>}
        <div className="label">Before</div>
        {table(preview.before)}
        <div className="label">After{preview.splits.train !== undefined ? " (training split)" : ""}</div>
        {table(preview.after)}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- load

function Load({ view }: { view: DatasetView }) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const d = view.dataset;
  const code = useMemo(() => generateLoaderCode(d, view.profile), [d, view.profile]);
  const stem = d.name.toLowerCase().replace(/[^a-z0-9]+/g, "_");
  const save = async () => {
    setBusy(true);
    try {
      const r = await api.dataWriteCode(d.id);
      toast("success", "Data scripts saved", [r.preprocessPath, r.loaderPath].filter(Boolean).join(" · "));
      void api.openInEditor(r.loaderPath);
    } catch (e) {
      toast("error", "Couldn't save", errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="col" style={{ gap: 12 }}>
      <div className="callout info">
        <FolderOpen size={15} />
        <div>
          {d.format === "images" ? (
            <>A loader for the image folder with the transforms from the Preprocess tab: augmentation on training only, parallel workers and pinned memory so the GPU isn't left waiting.</>
          ) : d.format === "tensors" ? (
            <>A loader for the arrays in the .npz / .pt files, with a validation split held out when there's only one file.</>
          ) : (
            <>A loader for the splits the preprocessing run writes. Run preprocessing first; until then the files it reads don't exist.</>
          )}{" "}
          Choose this dataset in the Model Builder and its training script uses this loader. From your own script:
          <pre className="code-block" style={{ marginTop: 8 }}>{`from data.${stem}_loader import make_loaders\nloaders = make_loaders()\nfor x, y in loaders["train"]:\n    ...`}</pre>
        </div>
      </div>
      <div className="row">
        <b className="mono">data/{stem}_loader.py</b>
        <div className="spacer" />
        <button className="btn primary" disabled={busy} onClick={() => void save()}>
          {busy ? <LoaderCircle size={14} className="spin" /> : <FileCode size={14} />} Save into the project
        </button>
      </div>
      <pre className="code-block selectable" style={{ maxHeight: 520 }}>
        {code}
      </pre>
    </div>
  );
}

// ---------------------------------------------------------------- add dataset

function AddDatasetDialog({ state, onClose, onAdded }: { state: AppState; onClose: () => void; onAdded: (v: DatasetView) => void }) {
  const toast = useToast();
  const firstReady = state.machines.find((m) => state.probes[m.id]?.ready) ?? state.machines[0];
  const [machineId, setMachineId] = useState(firstReady?.id ?? "");
  const [dir, setDir] = useState<BrowseResult | null>(null);
  const [browseError, setBrowseError] = useState<string | null>(null);
  const [path, setPath] = useState("");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);

  const browse = async (to: string | null) => {
    setBrowseError(null);
    try {
      setDir(await api.dataBrowse(machineId, to));
    } catch (e) {
      setBrowseError(errorMessage(e));
    }
  };
  useEffect(() => {
    if (machineId) void browse(null);
  }, [machineId]); // eslint-disable-line react-hooks/exhaustive-deps

  const pick = (p: string) => {
    setPath(p);
    if (!name) setName(p.replace(/\/+$/, "").split("/").pop()!.replace(/\.[^.]+$/, ""));
  };
  const add = async () => {
    setBusy(true);
    try {
      const v = await api.dataSave({ name: name.trim(), machineId, path: path.trim(), format: "unknown", steps: [] });
      try {
        onAdded(await api.dataProfile(v.dataset.id));
      } catch (e) {
        toast("error", "Added, but profiling failed", errorMessage(e));
        onAdded(v);
      }
    } catch (e) {
      toast("error", "Couldn't add the dataset", errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      wide
      title="Add dataset"
      icon={<Database size={16} />}
      onClose={onClose}
      footer={
        <>
          <span className="faint" style={{ fontSize: 12, marginRight: "auto" }}>
            It stays on the machine; Converlt profiles it there.
          </span>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" disabled={busy || !path.trim() || !name.trim() || !machineId} onClick={() => void add()}>
            {busy ? <LoaderCircle size={14} className="spin" /> : <Plus size={14} />} Add and profile
          </button>
        </>
      }
    >
      <div className="grid-2">
        <div className="field">
          <label>Machine</label>
          <select className="select" value={machineId} onChange={(e) => setMachineId(e.target.value)}>
            {state.machines.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label>Name</label>
          <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. churn" />
        </div>
      </div>
      <div className="field">
        <label>Path on the machine</label>
        <input className="input mono" value={path} onChange={(e) => setPath(e.target.value)} placeholder="/workspace/data/train.csv or a folder" />
        <span className="hint">
          A CSV, TSV, Parquet or JSON-lines file or a folder of them; a folder with one sub-folder of images per class; or arrays in <span className="mono">.npz</span> / <span className="mono">.pt</span> (inputs <span className="mono">x</span>, labels <span className="mono">y</span>; one file, or train/val/test files in a folder) for text tokens, audio, video and time series. Datasets from Datasets &amp; Models land in ~/.converge/hub.
        </span>
      </div>
      <div className="browser">
        {browseError ? (
          <div className="callout err">{browseError}</div>
        ) : !dir ? (
          <div className="row faint" style={{ padding: 10 }}>
            <LoaderCircle size={14} className="spin" /> Reading the machine…
          </div>
        ) : (
          <>
            <div className="row browser-path">
              {dir.parent && (
                <button className="btn ghost sm" onClick={() => void browse(dir.parent)}>
                  ..
                </button>
              )}
              <span className="mono truncate">{dir.dir}</span>
              <div className="spacer" />
              <button className="btn sm" onClick={() => pick(dir.dir)}>
                Use this folder
              </button>
            </div>
            {dir.entries.length === 0 && <div className="faint" style={{ padding: 10 }}>No folders or data files here.</div>}
            {dir.entries.map((e) => (
              <button key={e.path} className={`browser-row ${path === e.path ? "on" : ""}`} onClick={() => (e.dir ? void browse(e.path) : pick(e.path))} onDoubleClick={() => e.dir && pick(e.path)}>
                {e.dir ? <Folder size={14} /> : <FileCode size={14} />}
                <span className="truncate">{e.name}</span>
                <span className="spacer" />
                <span className="faint mono">{e.dir ? <ChevronRight size={13} /> : `${e.format} · ${e.size !== null ? formatBytes(e.size) : ""}`}</span>
              </button>
            ))}
          </>
        )}
      </div>
    </Dialog>
  );
}
