import { useEffect, useMemo, useState } from "react";
import { FileDiff, GitCompare, LoaderCircle, Plus, X } from "lucide-react";
import { diffConfigs, primaryMetricKey, seriesStats, sharedMetricKeys } from "@converge/run-protocol";
import type { RunListItem, RunView } from "@converge/core/api";
import { api, errorMessage } from "../api.ts";
import { LineChart, SERIES_COLORS, smooth } from "../components/Chart.tsx";
import { Dialog, Empty, StatusPill, useToast } from "../components/ui.tsx";
import { formatDuration, formatMiB, formatNumber, formatUsd, formatValue, shortCommit } from "../format.ts";

export function Compare({ runs, ids, onChange, onOpen }: { runs: RunListItem[]; ids: string[]; onChange: (ids: string[]) => void; onOpen: (id: string) => void }) {
  const [views, setViews] = useState<RunView[]>([]);
  const [loading, setLoading] = useState(false);
  const [onlyDiff, setOnlyDiff] = useState(true);
  const [smoothing, setSmoothing] = useState(0.6);
  const [picker, setPicker] = useState(false);
  const [diffText, setDiffText] = useState<{ title: string; text: string } | null>(null);
  const toast = useToast();

  useEffect(() => {
    let alive = true;
    setLoading(true);
    Promise.all(ids.map((id) => api.getRun(id))).then((vs) => {
      if (!alive) return;
      setViews(vs.filter((v): v is RunView => !!v));
      setLoading(false);
    });
    return () => {
      alive = false;
    };
  }, [ids, runs]);

  const color = (i: number) => SERIES_COLORS[i % SERIES_COLORS.length]!;
  const metricKeys = useMemo(() => {
    const keys = sharedMetricKeys(views.map((v) => Object.keys(v.summary.metrics)));
    const p = primaryMetricKey(keys);
    // Primary (loss-like) metric first, then other loss/val metrics, then the rest.
    const rank = (k: string) => (k === p ? 0 : /loss/i.test(k) ? 1 : /val|acc/i.test(k) ? 2 : 3);
    return keys.sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
  }, [views]);
  const configRows = useMemo(() => {
    const rows = diffConfigs(
      views.map((v) => ({
        ...v.effectiveConfig,
        "· command": v.manifest.command,
        "· gpu": v.summary.env?.gpus?.[0]?.name ?? v.manifest.machine.name,
        "· torch": v.summary.env?.torch ?? undefined,
      })),
    );
    return onlyDiff ? rows.filter((r) => r.differs) : rows;
  }, [views, onlyDiff]);

  const showDiff = async (a: RunView, b: RunView) => {
    const from = a.manifest.git?.commit;
    const to = b.manifest.git?.commit;
    if (!from || !to) return;
    try {
      const text = await api.gitDiff(from, to);
      setDiffText({ title: `${a.manifest.name} → ${b.manifest.name}`, text: text || "No committed code differences." });
    } catch (e) {
      toast("error", "Could not diff commits", errorMessage(e));
    }
  };

  if (ids.length === 0) {
    return (
      <div className="page">
        <div className="page-header">
          <h1 className="page-title">Compare</h1>
        </div>
        <div className="card">
          <Empty icon={<GitCompare size={24} />} title="Compare runs side by side" action={<button className="btn primary" onClick={() => setPicker(true)}><Plus size={14} /> Choose runs</button>}>
            Overlay training curves, see exactly which parameters, code, and hardware changed, and compare runtime and cost.
          </Empty>
        </div>
        {picker && <RunPicker runs={runs} selected={ids} onClose={() => setPicker(false)} onChange={onChange} />}
      </div>
    );
  }

  const base = views[0];
  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h1 className="page-title">Compare</h1>
          <div className="page-sub">
            {views.map((v, i) => (
              <span key={v.manifest.runId} className="tag" style={{ paddingRight: 3 }}>
                <span className="swatch" style={{ width: 8, height: 8, borderRadius: 2, background: color(i) }} />
                <button className="btn ghost sm" style={{ height: 18, padding: "0 3px" }} onClick={() => onOpen(v.manifest.runId)}>
                  {v.manifest.name}
                </button>
                <button className="btn ghost sm icon" style={{ height: 18, width: 18 }} onClick={() => onChange(ids.filter((x) => x !== v.manifest.runId))} aria-label="Remove">
                  <X size={11} />
                </button>
              </span>
            ))}
            <button className="btn ghost sm" onClick={() => setPicker(true)}>
              <Plus size={13} /> Add run
            </button>
          </div>
        </div>
      </div>

      {loading && views.length === 0 ? (
        <div className="empty">
          <LoaderCircle className="spin" />
        </div>
      ) : (
        <>
          <div className="card" style={{ overflow: "auto" }}>
            <table className="table">
              <thead>
                <tr>
                  <th>Run</th>
                  <th>Status</th>
                  <th>Compute</th>
                  <th>Commit</th>
                  <th className="num">Duration</th>
                  <th className="num">Est. cost</th>
                  <th className="num">Peak VRAM</th>
                  {metricKeys.slice(0, 4).map((k) => (
                    <th key={k} className="num">
                      {k}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {views.map((v, i) => (
                  <tr key={v.manifest.runId} className="clickable" onClick={() => onOpen(v.manifest.runId)}>
                    <td>
                      <div className="run-name">
                        <span className="swatch" style={{ width: 9, height: 9, borderRadius: 3, background: color(i) }} />
                        {v.manifest.name}
                      </div>
                    </td>
                    <td>
                      <StatusPill status={v.status} />
                    </td>
                    <td>{v.summary.env?.gpus?.[0]?.name ?? v.manifest.machine.name}</td>
                    <td className="mono">
                      {shortCommit(v.manifest.git?.commit)}
                      {v.manifest.git?.dirty ? <span title="uncommitted changes">*</span> : ""}
                    </td>
                    <td className="num mono">{v.durationSec === null ? "—" : formatDuration(v.durationSec)}</td>
                    <td className="num mono">{formatUsd(v.costUsd)}</td>
                    <td className="num mono">{formatMiB(v.summary.peakGpuMemMiB)}</td>
                    {metricKeys.slice(0, 4).map((k) => {
                      const st = seriesStats(v.summary.metrics[k]);
                      const lowerBetter = /loss|err|perplex/i.test(k);
                      return (
                        <td key={k} className="num mono" title={`min ${formatNumber(st.min)} · max ${formatNumber(st.max)}`}>
                          {st.last === null ? (st.count ? <span style={{ color: "var(--err)" }}>NaN</span> : "—") : formatNumber(lowerBetter ? st.min : st.max)}
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {metricKeys.length > 0 && (
            <div className="faint" style={{ fontSize: 11.5, marginTop: 6 }}>
              Metric columns show the best value (min for loss-like metrics, max otherwise).
            </div>
          )}

          {metricKeys.length > 0 && (
            <>
              <div className="row" style={{ margin: "24px 0 10px" }}>
                <div className="section-title" style={{ margin: 0 }}>
                  Metrics
                </div>
                <div className="spacer" />
                <span className="faint" style={{ fontSize: 12 }}>
                  Smoothing
                </span>
                <input type="range" min={0} max={0.99} step={0.01} value={smoothing} onChange={(e) => setSmoothing(Number(e.target.value))} style={{ width: 140, accentColor: "var(--accent)" }} />
                <span className="mono faint" style={{ width: 32 }}>
                  {smoothing.toFixed(2)}
                </span>
              </div>
              <div className="charts">
                {metricKeys.map((k) => (
                  <div key={k} className="card chart-card">
                    <div className="chart-title">{k}</div>
                    <LineChart
                      legend={false}
                      series={views
                        .map((v, i) => ({ v, i }))
                        .filter(({ v }) => v.summary.metrics[k])
                        .map(({ v, i }) => ({
                          name: v.manifest.name,
                          color: color(i),
                          points: smooth(v.summary.metrics[k]!.map((p) => ({ x: p.step, y: p.value })), smoothing),
                        }))}
                    />
                  </div>
                ))}
              </div>
            </>
          )}

          <div className="row" style={{ margin: "26px 0 10px" }}>
            <div className="section-title" style={{ margin: 0 }}>
              Configuration
            </div>
            <div className="spacer" />
            <label className="row muted" style={{ gap: 8, fontSize: 12 }}>
              <input type="checkbox" checked={onlyDiff} onChange={(e) => setOnlyDiff(e.target.checked)} style={{ accentColor: "var(--accent)" }} /> Only differences
            </label>
          </div>
          <div className="card" style={{ overflow: "auto" }}>
            <table className="table">
              <thead>
                <tr>
                  <th>Parameter</th>
                  {views.map((v, i) => (
                    <th key={v.manifest.runId}>
                      <span className="row" style={{ gap: 6 }}>
                        <span className="swatch" style={{ width: 8, height: 8, borderRadius: 2, background: color(i), display: "inline-block" }} />
                        {v.manifest.name}
                      </span>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {configRows.map((r) => (
                  <tr key={r.key}>
                    <td className="mono">{r.key.replace(/^· /, "")}</td>
                    {r.values.map((val, i) => (
                      <td key={i} className={`mono selectable ${r.differs ? "diff" : ""}`} style={{ maxWidth: 360, overflowWrap: "anywhere" }}>
                        {formatValue(val)}
                      </td>
                    ))}
                  </tr>
                ))}
                {configRows.length === 0 && (
                  <tr>
                    <td colSpan={views.length + 1} className="faint" style={{ textAlign: "center", padding: 20 }}>
                      {onlyDiff ? "Configurations are identical." : "No configuration captured."}
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>

          <div className="section-title">Code</div>
          <div className="card card-body">
            {base && views.length > 1 ? (
              <div className="col">
                {views.slice(1).map((v) => {
                  const a = base.manifest.git?.commit;
                  const b = v.manifest.git?.commit;
                  return (
                    <div key={v.manifest.runId} className="row">
                      <span className="mono">
                        {base.manifest.name} <span className="faint">{shortCommit(a)}</span> → {v.manifest.name} <span className="faint">{shortCommit(b)}</span>
                      </span>
                      {a && b && a === b && <span className="tag ok">same commit</span>}
                      {(base.manifest.git?.dirty || v.manifest.git?.dirty) && <span className="tag warn">uncommitted changes recorded</span>}
                      <div className="spacer" />
                      {a && b && a !== b && (
                        <button className="btn sm" onClick={() => showDiff(base, v)}>
                          <FileDiff size={13} /> Diff commits
                        </button>
                      )}
                      {v.hasPatch && (
                        <button className="btn sm ghost" onClick={() => api.openPatch(v.manifest.runId)}>
                          {v.manifest.name} patch
                        </button>
                      )}
                    </div>
                  );
                })}
              </div>
            ) : (
              <span className="faint">Add another run to compare code versions.</span>
            )}
          </div>
        </>
      )}

      {picker && <RunPicker runs={runs} selected={ids} onClose={() => setPicker(false)} onChange={onChange} />}
      {diffText && (
        <Dialog wide title={diffText.title} icon={<FileDiff size={17} />} onClose={() => setDiffText(null)}>
          <DiffView text={diffText.text} />
        </Dialog>
      )}
    </div>
  );
}

function RunPicker({ runs, selected, onClose, onChange }: { runs: RunListItem[]; selected: string[]; onClose: () => void; onChange: (ids: string[]) => void }) {
  const [sel, setSel] = useState(selected);
  return (
    <Dialog
      title="Choose runs to compare"
      icon={<GitCompare size={17} />}
      onClose={onClose}
      footer={
        <>
          <span className="faint">{sel.length} selected</span>
          <div className="spacer" />
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button
            className="btn primary"
            disabled={sel.length === 0}
            onClick={() => {
              onChange(sel);
              onClose();
            }}
          >
            Compare
          </button>
        </>
      }
    >
      <div className="col" style={{ gap: 2 }}>
        {runs.map((r) => {
          const on = sel.includes(r.runId);
          return (
            <button key={r.runId} className="recent-item" onClick={() => setSel(on ? sel.filter((x) => x !== r.runId) : [...sel, r.runId])}>
              <span className={`checkbox ${on ? "on" : ""}`}>{on && <svg width="10" height="10" viewBox="0 0 10 10"><path d="M1.5 5.2 4 7.5 8.5 2.5" stroke="white" strokeWidth="1.8" fill="none" /></svg>}</span>
              <span style={{ fontWeight: 600, width: 70 }}>{r.name}</span>
              <span className="mono faint truncate" style={{ flex: 1, fontSize: 11.5 }}>{r.command}</span>
              <StatusPill status={r.status} />
            </button>
          );
        })}
        {runs.length === 0 && <span className="faint">No runs in this project yet.</span>}
      </div>
    </Dialog>
  );
}

function DiffView({ text }: { text: string }) {
  const lines = text.split("\n").slice(0, 6000);
  return (
    <pre className="code-block" style={{ maxHeight: "65vh" }}>
      {lines.map((l, i) => {
        const cls = l.startsWith("+++") || l.startsWith("---") || l.startsWith("diff ") ? "diff-file" : l.startsWith("+") ? "diff-add" : l.startsWith("-") ? "diff-del" : l.startsWith("@@") ? "diff-hunk" : "";
        return (
          <div key={i} className={cls}>
            {l || " "}
          </div>
        );
      })}
    </pre>
  );
}
