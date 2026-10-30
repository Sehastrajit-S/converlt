import { useMemo, useState } from "react";
import { Code, FlaskConical, GitCompare, OctagonAlert, Play, Search, TriangleAlert } from "lucide-react";
import type { AppState, RunListItem } from "@converge/core/api";
import { api } from "../api.ts";
import { Sparkline } from "../components/Chart.tsx";
import { Empty, Segmented, StatusPill } from "../components/ui.tsx";
import { formatDuration, formatNumber, formatUsd, shortCommit, timeAgo } from "../format.ts";

type Filter = "all" | "active" | "failed" | "completed";

const ACTIVE = new Set(["running", "preparing", "cancelling", "created", "unknown"]);

export function Runs({
  state,
  runs,
  onOpen,
  onNewRun,
  onCompare,
  embedded = false,
}: {
  state: AppState;
  runs: RunListItem[];
  onOpen: (runId: string) => void;
  onNewRun: () => void;
  onCompare: (ids: string[]) => void;
  /** Rendered inside the editor (Converlt IDE / VS Code), so there's no editor to open. */
  embedded?: boolean;
}) {
  const [filter, setFilter] = useState<Filter>("all");
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<string[]>([]);
  const project = state.project!;

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return runs.filter((r) => {
      if (filter === "active" && !ACTIVE.has(r.status)) return false;
      if (filter === "failed" && r.status !== "failed") return false;
      if (filter === "completed" && r.status !== "completed") return false;
      if (!q) return true;
      return [r.name, r.command, r.machineName, r.gpuName ?? "", r.group, r.gitCommit ?? ""].some((s) => s.toLowerCase().includes(q));
    });
  }, [runs, filter, query]);

  const counts = useMemo(
    () => ({
      active: runs.filter((r) => ACTIVE.has(r.status)).length,
      failed: runs.filter((r) => r.status === "failed").length,
      completed: runs.filter((r) => r.status === "completed").length,
    }),
    [runs],
  );

  const toggle = (id: string) => setSelected((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]));

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h1 className="page-title">Runs</h1>
          <div className="page-sub">
            <span>{project.name}</span>
            {project.branch && <span className="tag">{project.branch}</span>}
            <span className="faint">·</span>
            <span className="faint">{runs.length} runs</span>
          </div>
        </div>
        <div className="spacer" />
        {!embedded && (
          <button className="btn" onClick={() => api.openInEditor()}>
            <Code size={15} /> Open in editor
          </button>
        )}
        <button className="btn primary" onClick={onNewRun}>
          <Play size={14} fill="currentColor" /> New run
        </button>
      </div>

      {runs.length === 0 ? (
        <div className="card">
          <Empty
            icon={<FlaskConical size={24} />}
            title="No runs yet"
            action={
              <button className="btn primary" onClick={onNewRun}>
                <Play size={14} fill="currentColor" /> Launch your first run
              </button>
            }
          >
            {state.machines.length === 0
              ? "Add a GPU machine on the Compute page, then launch your training script on it."
              : "Pick a machine and a command such as python train.py. Converlt syncs your code and starts training in the background."}
          </Empty>
        </div>
      ) : (
        <>
          <div className="toolbar">
            <Segmented<Filter>
              value={filter}
              onChange={setFilter}
              options={[
                { value: "all", label: "All" },
                { value: "active", label: `Active${counts.active ? ` · ${counts.active}` : ""}` },
                { value: "failed", label: `Failed${counts.failed ? ` · ${counts.failed}` : ""}` },
                { value: "completed", label: "Completed" },
              ]}
            />
            <div className="spacer" />
            <div className="search">
              <Search size={14} />
              <input className="input" placeholder="Search runs, commands, machines…" value={query} onChange={(e) => setQuery(e.target.value)} />
            </div>
          </div>
          <div className="card" style={{ overflow: "hidden" }}>
            <table className="table">
              <thead>
                <tr>
                  <th style={{ width: 36 }} />
                  <th>Run</th>
                  <th>Status</th>
                  <th>Metric</th>
                  <th>Compute</th>
                  <th className="num">Duration</th>
                  <th className="num">Est. cost</th>
                  <th className="num">Started</th>
                </tr>
              </thead>
              <tbody>
                {visible.map((r) => (
                  <tr key={r.runId} className={`clickable ${selected.includes(r.runId) ? "selected" : ""}`} onClick={() => onOpen(r.runId)}>
                    <td onClick={(e) => e.stopPropagation()}>
                      <button className={`checkbox ${selected.includes(r.runId) ? "on" : ""}`} onClick={() => toggle(r.runId)} aria-label={`Select ${r.name}`}>
                        {selected.includes(r.runId) && <svg width="10" height="10" viewBox="0 0 10 10"><path d="M1.5 5.2 4 7.5 8.5 2.5" stroke="white" strokeWidth="1.8" fill="none" /></svg>}
                      </button>
                    </td>
                    <td style={{ maxWidth: 420 }}>
                      <div className="run-name">
                        {r.name}
                        {r.group && <span className="tag accent">{r.group}</span>}
                        {r.diagnosticKinds.includes("nan") && (
                          <span className="tag err" title="Non-finite loss detected">
                            NaN
                          </span>
                        )}
                        {r.diagnosticKinds.includes("oom") && (
                          <span className="tag err" title="CUDA out of memory">
                            OOM
                          </span>
                        )}
                        {r.diagnosticKinds.some((k) => k === "stall" || k === "perf") && <TriangleAlert size={13} color="var(--warn)" />}
                        {r.diagnosticKinds.includes("exception") && <OctagonAlert size={13} color="var(--err)" />}
                      </div>
                      <div className="run-cmd truncate" title={r.command}>
                        {r.command}
                      </div>
                    </td>
                    <td>
                      <StatusPill status={r.status} connection={r.connection} />
                    </td>
                    <td>
                      {r.primaryMetric ? (
                        <div className="row" style={{ gap: 10 }}>
                          <Sparkline values={r.primaryMetric.spark} />
                          <div>
                            <div className="mono" style={{ fontSize: 12 }}>
                              {r.primaryMetric.last === null ? <span style={{ color: "var(--err)" }}>NaN</span> : formatNumber(r.primaryMetric.last)}
                            </div>
                            <div className="faint" style={{ fontSize: 11 }}>{r.primaryMetric.key}</div>
                          </div>
                        </div>
                      ) : (
                        <span className="faint">—</span>
                      )}
                    </td>
                    <td>
                      <div style={{ fontWeight: 550 }}>{r.gpuName ?? r.machineName}</div>
                      <div className="faint" style={{ fontSize: 11.5 }}>
                        {r.gpuName ? r.machineName : ""} {r.gitCommit && <span className="mono">· {shortCommit(r.gitCommit)}{r.dirty ? "*" : ""}</span>}
                      </div>
                    </td>
                    <td className="num mono">{r.durationSec === null ? "—" : formatDuration(r.durationSec)}</td>
                    <td className="num mono">{formatUsd(r.costUsd)}</td>
                    <td className="num faint">{timeAgo(r.createdAt)}</td>
                  </tr>
                ))}
                {visible.length === 0 && (
                  <tr>
                    <td colSpan={8} className="faint" style={{ textAlign: "center", padding: 28 }}>
                      No runs match.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
          {selected.length > 0 && (
            <div className="floating-bar">
              <span>
                <b>{selected.length}</b> selected
              </span>
              <button className="btn ghost sm" onClick={() => setSelected([])}>
                Clear
              </button>
              <button className="btn primary sm" disabled={selected.length < 2} onClick={() => onCompare(selected)}>
                <GitCompare size={14} /> Compare
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
