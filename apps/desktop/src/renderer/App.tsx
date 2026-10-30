// IDE shell: activity tabs on top of the side bar (files, search, source control, runs, compute),
// a tabbed editor area where code files open in Monaco and Converlt screens open as tabs, a
// terminal panel below it, and the AI assistant on the right.
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ChevronDown,
  Cpu,
  Files,
  FlaskConical,
  FolderOpen,
  GitBranch,
  GitCompare,
  Layers,
  LoaderCircle,
  PanelBottom,
  PanelLeft,
  Play,
  Plus,
  RefreshCw,
  Search,
  Server,
  Settings as SettingsIcon,
  Sparkles,
  Unplug,
  X,
} from "lucide-react";
import type { Machine } from "@converge/run-protocol";
import {
  api,
  Compare,
  Compute,
  errorMessage,
  formatDuration,
  formatNumber,
  formatUsd,
  MachineDialog,
  NewRunDialog,
  RunDetail,
  Runs,
  Settings,
  useAppState,
  useRuns,
  useToast,
  Welcome,
  type NewRunPrefill,
} from "@converge/ui";
import type { GitStatus } from "../shared/ide.ts";
import { AgentPanel } from "./ide/AgentPanel.tsx";
import { runAgentTool } from "./ide/agentTools.ts";
import { CodeEditor, type Reveal } from "./ide/CodeEditor.tsx";
import { DiffEditor, type DiffBase } from "./ide/DiffEditor.tsx";
import { Explorer, FileIcon } from "./ide/Explorer.tsx";
import { GitView } from "./ide/GitView.tsx";
import { anyDirty, closeAllModels, closeModel, getOpenModel, ide, isDirty, onDirtyChange, saveAll } from "./ide/monaco.ts";
import { QuickOpen } from "./ide/QuickOpen.tsx";
import { SearchView } from "./ide/SearchView.tsx";
import { TerminalPanel } from "./ide/TerminalPanel.tsx";

type Tab =
  | { kind: "file"; path: string }
  | { kind: "diff"; path: string; base: DiffBase }
  | { kind: "runs" }
  | { kind: "run"; runId: string }
  | { kind: "compare" }
  | { kind: "compute" }
  | { kind: "settings" };
type SideView = "explorer" | "search" | "git" | "runs" | "compute";

const tabId = (t: Tab) => (t.kind === "file" ? `file:${t.path}` : t.kind === "diff" ? `diff:${t.base}:${t.path}` : t.kind === "run" ? `run:${t.runId}` : t.kind);
const baseName = (p: string) => p.slice(p.lastIndexOf("/") + 1);

const STORE_KEY = "converge.ide.layout";
type Layout = { side: SideView; width: number; open: boolean; panel: boolean; panelHeight: number; agent: boolean; agentWidth: number };
const DEFAULT_LAYOUT: Layout = { side: "explorer", width: 260, open: true, panel: false, panelHeight: 260, agent: true, agentWidth: 380 };
function loadLayout(): Layout {
  try {
    return { ...DEFAULT_LAYOUT, ...JSON.parse(localStorage.getItem(STORE_KEY) ?? "{}") };
  } catch {
    return DEFAULT_LAYOUT;
  }
}

/** Drag handle helper: reports the pointer delta from where the drag started. */
function startDrag(e: React.MouseEvent, axis: "x" | "y", onMove: (delta: number) => void) {
  e.preventDefault();
  const start = axis === "x" ? e.clientX : e.clientY;
  const move = (ev: MouseEvent) => onMove((axis === "x" ? ev.clientX : ev.clientY) - start);
  const up = () => {
    window.removeEventListener("mousemove", move);
    window.removeEventListener("mouseup", up);
    document.body.classList.remove("resizing", "resizing-y");
  };
  document.body.classList.add(axis === "x" ? "resizing" : "resizing-y");
  window.addEventListener("mousemove", move);
  window.addEventListener("mouseup", up);
}

const STATUS_DOT: Record<string, string> = { running: "ok", preparing: "ok", cancelling: "warn", completed: "ok", failed: "err", unknown: "warn" };

export function App() {
  const [state] = useAppState();
  const runs = useRuns(state?.project?.path);
  const toast = useToast();

  const initial = useMemo(loadLayout, []);
  const [side, setSide] = useState<SideView>(initial.side);
  const [sideOpen, setSideOpen] = useState(initial.open);
  const [sideWidth, setSideWidth] = useState(initial.width);
  const [panelOpen, setPanelOpen] = useState(initial.panel);
  const [panelHeight, setPanelHeight] = useState(initial.panelHeight);
  const [agentOpen, setAgentOpen] = useState(initial.agent);
  const [agentWidth, setAgentWidth] = useState(initial.agentWidth);
  const [agentNonce, setAgentNonce] = useState(0);
  const [searchNonce, setSearchNonce] = useState(0);
  const [reveal, setReveal] = useState<Reveal | null>(null);
  const [gitStatus, setGitStatus] = useState<GitStatus | null>(null);
  const [tabs, setTabs] = useState<Tab[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [lastFile, setLastFile] = useState<string | null>(null);
  const [, setDirtyTick] = useState(0);
  const [explorerVersion, setExplorerVersion] = useState(0);
  const [quickOpen, setQuickOpen] = useState(false);
  const [compareIds, setCompareIds] = useState<string[]>([]);
  const [newRun, setNewRun] = useState<NewRunPrefill | null>(null);
  const [machineDialog, setMachineDialog] = useState<{ machine?: Machine } | null>(null);
  const [projectMenu, setProjectMenu] = useState(false);

  useEffect(() => onDirtyChange(() => setDirtyTick((n) => n + 1)), []);
  useEffect(() => {
    try {
      const layout: Layout = { side, width: sideWidth, open: sideOpen, panel: panelOpen, panelHeight, agent: agentOpen, agentWidth };
      localStorage.setItem(STORE_KEY, JSON.stringify(layout));
    } catch {
      // storage unavailable: layout just isn't remembered
    }
  }, [side, sideWidth, sideOpen, panelOpen, panelHeight, agentOpen, agentWidth]);

  // Main shows a confirm dialog when this blocks the window from closing.
  useEffect(() => {
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      if (anyDirty()) {
        e.preventDefault();
        e.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, []);

  const projectPath = state?.project?.path;
  useEffect(() => {
    closeAllModels();
    setCompareIds([]);
    setLastFile(null);
    setExplorerVersion((v) => v + 1);
    setTabs(projectPath ? [{ kind: "runs" }] : []);
    setActiveId(projectPath ? "runs" : null);
    setGitStatus(null);
  }, [projectPath]);

  const open = useCallback((t: Tab) => {
    const id = tabId(t);
    setTabs((ts) => (ts.some((x) => tabId(x) === id) ? ts : [...ts, t]));
    setActiveId(id);
  }, []);

  // The assistant's tools run here, against the editor buffers.
  useEffect(
    () =>
      ide.agent.onToolRequest(async (req) => {
        const result = await runAgentTool(req, {
          api,
          opened: (path, edited) => {
            open({ kind: "file", path });
            if (edited) setTabs((ts) => [...ts]); // repaint the dirty dot
          },
        });
        await ide.agent.toolResult(req.callId, result);
      }),
    [open],
  );

  const close = useCallback(
    (id: string) => {
      const t = tabs.find((x) => tabId(x) === id);
      if (!t) return;
      // A file's buffer is shared by its editor tab and any diff tabs; dispose it with the last one.
      const others = t.kind === "file" || t.kind === "diff" ? tabs.filter((x) => x !== t && (x.kind === "file" || x.kind === "diff") && x.path === t.path) : [];
      if ((t.kind === "file" || t.kind === "diff") && !others.length) {
        if (isDirty(t.path) && !window.confirm(`Discard unsaved changes to ${baseName(t.path)}?`)) return;
        if (getOpenModel(t.path)) closeModel(t.path);
      }
      const idx = tabs.indexOf(t);
      const rest = tabs.filter((x) => x !== t);
      setTabs(rest);
      if (activeId === id) {
        const next = rest[Math.min(idx, rest.length - 1)];
        setActiveId(next ? tabId(next) : null);
      }
      if (t.kind === "file" && lastFile === t.path) {
        const other = rest.find((x): x is Extract<Tab, { kind: "file" }> => x.kind === "file");
        setLastFile(other?.path ?? null);
      }
    },
    [tabs, activeId, lastFile],
  );

  const active = tabs.find((t) => tabId(t) === activeId) ?? null;
  const activeFile = active?.kind === "file" ? active.path : null;
  // The editor stays mounted (showing the last file) while a Converlt screen is in front.
  const editorPath = activeFile ?? lastFile;
  useEffect(() => {
    if (activeFile) setLastFile(activeFile);
  }, [activeFile]);

  const runOnGpu = useCallback(
    async (file?: string) => {
      if (!state?.project) return;
      try {
        await saveAll();
      } catch (e) {
        toast("error", "Could not save files before running", errorMessage(e));
        return;
      }
      const py = state.machines[0]?.python;
      const python = py && /^[\w./-]+$/.test(py) ? py : "python3";
      setNewRun(file ? { command: `${python} ${file}` } : {});
    },
    [state, toast],
  );

  const showSide = (view: SideView) => {
    setSide(view);
    setSideOpen(true);
    if (view === "search") setSearchNonce((n) => n + 1);
  };

  // Ctrl+P quick open, Ctrl+N new run, Ctrl+O open folder, Ctrl+W close tab, Ctrl+B side bar,
  // Ctrl+` / Ctrl+J terminal, Ctrl+L assistant, Ctrl+Shift+F search, Ctrl+Shift+G source control,
  // Ctrl+Shift+E explorer.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.altKey) return;
      const k = e.key.toLowerCase();
      if (k === "p" && !e.shiftKey && state?.project) setQuickOpen(true);
      else if (k === "n" && !e.shiftKey && state?.project) void runOnGpu(activeFile?.endsWith(".py") ? activeFile : undefined);
      else if (k === "o" && !e.shiftKey) void api.openProjectDialog();
      else if (k === "w" && activeId) close(activeId);
      else if (k === "b" && !e.shiftKey) setSideOpen((o) => !o);
      else if (e.code === "Backquote" || (k === "j" && !e.shiftKey)) setPanelOpen((o) => !o);
      else if (k === "l" && !e.shiftKey) {
        setAgentOpen(true);
        setAgentNonce((n) => n + 1);
      } else if (k === "f" && e.shiftKey && state?.project) showSide("search");
      else if (k === "g" && e.shiftKey && state?.project) showSide("git");
      else if (k === "e" && e.shiftKey) showSide("explorer");
      else return;
      e.preventDefault();
      e.stopPropagation();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [state?.project, activeId, activeFile, close, runOnGpu]);

  const reproduce = useCallback(
    async (runId: string) => {
      try {
        const plan = await api.planReproduce(runId);
        const name = runs.find((r) => r.runId === runId)?.name;
        setNewRun({ command: plan.command, machineId: plan.machineId, options: plan.options, warnings: plan.warnings, reproducedFrom: runId, reproducedName: name });
      } catch (e) {
        toast("error", "Cannot reproduce", errorMessage(e));
      }
    },
    [runs, toast],
  );

  const resizeSide = (e: React.MouseEvent) => {
    const w = sideWidth;
    startDrag(e, "x", (d) => setSideWidth(Math.max(190, Math.min(560, w + d))));
  };
  const resizeAgent = (e: React.MouseEvent) => {
    const w = agentWidth;
    startDrag(e, "x", (d) => setAgentWidth(Math.max(300, Math.min(720, w - d))));
  };
  const resizePanel = (e: React.MouseEvent) => {
    const h = panelHeight;
    startDrag(e, "y", (d) => setPanelHeight(Math.max(120, Math.min(window.innerHeight - 220, h - d))));
  };

  const openAt = useCallback(
    (path: string, line: number, col: number, length: number) => {
      open({ kind: "file", path });
      setReveal({ path, line, col, length, nonce: Date.now() });
    },
    [open],
  );

  const live = useMemo(() => runs.filter((r) => r.status === "running" || r.status === "preparing" || r.status === "cancelling"), [runs]);

  if (!state)
    return (
      <div style={{ display: "grid", placeItems: "center", height: "100%" }}>
        <LoaderCircle className="spin" />
      </div>
    );

  const tabLabel = (t: Tab): { icon: React.ReactNode; label: string } => {
    switch (t.kind) {
      case "file":
        return { icon: <FileIcon name={t.path} />, label: baseName(t.path) };
      case "diff":
        return { icon: <GitCompare size={14} className="ficon code" />, label: `${baseName(t.path)} ${t.base === "head" ? "(changes)" : "(review)"}` };
      case "runs":
        return { icon: <FlaskConical size={14} className="ficon accent" />, label: "Runs" };
      case "run":
        return { icon: <FlaskConical size={14} className="ficon accent" />, label: runs.find((r) => r.runId === t.runId)?.name ?? "Run" };
      case "compare":
        return { icon: <GitCompare size={14} className="ficon accent" />, label: "Compare" };
      case "compute":
        return { icon: <Server size={14} className="ficon accent" />, label: "Compute" };
      case "settings":
        return { icon: <SettingsIcon size={14} className="ficon" />, label: "Settings" };
    }
  };

  const sideButton = (view: SideView, icon: React.ReactNode, label: string, badge?: React.ReactNode) => (
    <button
      className={`side-tab ${sideOpen && side === view ? "active" : ""}`}
      title={label}
      onClick={() => {
        if (sideOpen && side === view) setSideOpen(false);
        else showSide(view);
      }}
    >
      {icon}
      {badge}
    </button>
  );

  const page = (t: Tab) => {
    if (t.kind === "compute") return <Compute state={state} onAdd={() => setMachineDialog({})} onEdit={(m) => setMachineDialog({ machine: m })} />;
    if (t.kind === "settings") return <Settings state={state} />;
    if (t.kind === "run") return <RunDetail key={t.runId} runId={t.runId} onBack={() => open({ kind: "runs" })} onReproduce={reproduce} />;
    if (t.kind === "compare") return <Compare runs={runs} ids={compareIds} onChange={setCompareIds} onOpen={(runId) => open({ kind: "run", runId })} />;
    return (
      <Runs
        state={state}
        runs={runs}
        onOpen={(runId) => open({ kind: "run", runId })}
        onNewRun={() => void runOnGpu()}
        onCompare={(ids) => {
          setCompareIds(ids);
          open({ kind: "compare" });
        }}
      />
    );
  };

  return (
    <div className="ide">
      <header className="titlebar ide-titlebar">
        <div className="brand">
          <div className="brand-mark">
            <Layers size={13} strokeWidth={2.5} />
          </div>
        </div>
        <div className="no-drag" style={{ position: "relative" }}>
          <button className="btn ghost sm" onClick={() => setProjectMenu(!projectMenu)} style={{ fontWeight: 600 }}>
            <FolderOpen size={14} />
            {state.project ? state.project.name : "Open folder"}
            <ChevronDown size={13} />
          </button>
          {projectMenu && (
            <>
              <div style={{ position: "fixed", inset: 0, zIndex: 40 }} onClick={() => setProjectMenu(false)} />
              <div className="card" style={{ position: "absolute", top: 34, left: 0, width: 340, padding: 6, zIndex: 41, boxShadow: "var(--shadow-pop)" }}>
                <button
                  className="recent-item"
                  onClick={() => {
                    setProjectMenu(false);
                    void api.openProjectDialog();
                  }}
                >
                  <FolderOpen size={15} /> Open folder… <span className="kbd" style={{ marginLeft: "auto" }}>Ctrl O</span>
                </button>
                {state.recentProjects
                  .filter((p) => p !== state.project?.path)
                  .map((p) => (
                    <button
                      key={p}
                      className="recent-item"
                      onClick={() => {
                        setProjectMenu(false);
                        api.openProject(p).catch((e) => toast("error", "Could not open project", errorMessage(e)));
                      }}
                    >
                      <FlaskConical size={15} className="faint" />
                      <div style={{ minWidth: 0 }}>
                        <div>{p.split(/[\\/]/).pop()}</div>
                        <div className="faint mono truncate" style={{ fontSize: 11 }}>{p}</div>
                      </div>
                    </button>
                  ))}
                {state.project && (
                  <button
                    className="recent-item"
                    onClick={() => {
                      setProjectMenu(false);
                      if (anyDirty() && !window.confirm("Discard unsaved changes and close the project?")) return;
                      void api.closeProject();
                    }}
                  >
                    <X size={15} /> Close project
                  </button>
                )}
              </div>
            </>
          )}
        </div>
        {state.project?.branch && <span className="tag no-drag">{state.project.branch}</span>}
        <div className="spacer" />
        <button className="command-center no-drag" disabled={!state.project} onClick={() => setQuickOpen(true)}>
          <Search size={13} />
          <span className="truncate">{state.project ? `Search ${state.project.name}` : "Converlt"}</span>
          <span className="kbd">Ctrl P</span>
        </button>
        <div className="spacer" />
        <button className={`btn ghost sm icon ${sideOpen ? "on" : ""}`} title="Toggle side bar (Ctrl+B)" onClick={() => setSideOpen(!sideOpen)}>
          <PanelLeft size={15} />
        </button>
        <button className={`btn ghost sm icon ${panelOpen ? "on" : ""}`} title="Toggle terminal (Ctrl+`)" onClick={() => setPanelOpen(!panelOpen)}>
          <PanelBottom size={15} />
        </button>
        <button className={`btn ghost sm icon ${agentOpen ? "on" : ""}`} title="Toggle assistant (Ctrl+L)" onClick={() => setAgentOpen(!agentOpen)}>
          <Sparkles size={15} />
        </button>
        <button className="btn ghost sm icon" title="Settings" onClick={() => open({ kind: "settings" })}>
          <SettingsIcon size={15} />
        </button>
        {state.project && (
          <button className="btn primary sm" onClick={() => void runOnGpu(activeFile?.endsWith(".py") ? activeFile : undefined)} title="New run (Ctrl+N)">
            <Play size={12} fill="currentColor" /> Run on GPU
          </button>
        )}
      </header>

      <div className="ide-body">
        {sideOpen && (
          <aside className="side" style={{ width: sideWidth }}>
            <div className="side-tabs">
              {sideButton("explorer", <Files size={16} />, "Explorer (Ctrl+Shift+E)")}
              {sideButton("search", <Search size={16} />, "Search (Ctrl+Shift+F)")}
              {sideButton("git", <GitBranch size={16} />, "Source control (Ctrl+Shift+G)", gitStatus?.changes.length ? <span className="side-badge">{gitStatus.changes.length}</span> : null)}
              {sideButton("runs", <FlaskConical size={16} />, "Runs", live.length ? <span className="side-badge">{live.length}</span> : null)}
              {sideButton("compute", <Server size={16} />, "Compute")}
            </div>
            {(side === "search" || side === "git") && !state.project ? (
              <div className="side-empty muted">Open a project first.</div>
            ) : side === "search" ? (
              <>
                <div className="side-head">
                  <span>Search</span>
                </div>
                <SearchView focusNonce={searchNonce} onOpen={(path, m) => openAt(path, m.line, m.col, m.length)} />
              </>
            ) : side === "git" ? (
              <>
                <div className="side-head">
                  <span>Source control</span>
                </div>
                <GitView onOpenDiff={(path) => open({ kind: "diff", path, base: "head" })} onError={(title, msg) => toast("error", title, msg)} onStatus={setGitStatus} />
              </>
            ) : side === "explorer" ? (
              <>
                <div className="side-head">
                  <span className="truncate">{state.project?.name ?? "Explorer"}</span>
                  {state.project && (
                    <button className="btn ghost sm icon" title="Refresh" onClick={() => setExplorerVersion((v) => v + 1)}>
                      <RefreshCw size={13} />
                    </button>
                  )}
                </div>
                <div className="side-body">
                  {state.project ? (
                    <Explorer version={explorerVersion} activePath={activeFile} onOpen={(path) => open({ kind: "file", path })} />
                  ) : (
                    <div className="side-empty">
                      <div className="muted">Open the folder with your training code.</div>
                      <button className="btn primary sm" onClick={() => void api.openProjectDialog()}>
                        <FolderOpen size={13} /> Open folder
                      </button>
                    </div>
                  )}
                </div>
              </>
            ) : side === "runs" ? (
              <>
                <div className="side-head">
                  <span>Runs</span>
                  {state.project && (
                    <button className="btn ghost sm icon" title="Open runs dashboard" onClick={() => open({ kind: "runs" })}>
                      <Layers size={13} />
                    </button>
                  )}
                </div>
                <div className="side-body">
                  {!state.project ? (
                    <div className="side-empty muted">Open a project to see its runs.</div>
                  ) : runs.length === 0 ? (
                    <div className="side-empty">
                      <div className="muted">No runs yet.</div>
                      <button className="btn primary sm" onClick={() => void runOnGpu()}>
                        <Play size={12} fill="currentColor" /> New run
                      </button>
                    </div>
                  ) : (
                    runs.map((r) => (
                      <button key={r.runId} className={`tree-row run-row ${activeId === `run:${r.runId}` ? "active" : ""}`} onClick={() => open({ kind: "run", runId: r.runId })}>
                        <span className={`health ${STATUS_DOT[r.status] ?? ""}`} style={{ width: 7, height: 7, flexShrink: 0, opacity: r.status === "cancelled" ? 0.4 : 1 }} />
                        <span style={{ fontWeight: 560 }}>{r.name}</span>
                        <span className="faint truncate" style={{ fontSize: 12.5 }}>
                          {r.diagnosticKinds.length ? r.diagnosticKinds.join(", ") + " · " : ""}
                          {r.primaryMetric ? `${r.primaryMetric.key.split("/").pop()} ${formatNumber(r.primaryMetric.last)}` : r.status}
                        </span>
                      </button>
                    ))
                  )}
                </div>
              </>
            ) : (
              <>
                <div className="side-head">
                  <span>Compute</span>
                  <button className="btn ghost sm icon" title="Add machine" onClick={() => setMachineDialog({})}>
                    <Plus size={14} />
                  </button>
                </div>
                <div className="side-body">
                  {state.machines.length === 0 ? (
                    <div className="side-empty">
                      <div className="muted">Connect a GPU machine over SSH, or your local GPU through WSL.</div>
                      <button className="btn primary sm" onClick={() => setMachineDialog({})}>
                        <Plus size={13} /> Add machine
                      </button>
                    </div>
                  ) : (
                    state.machines.map((m) => {
                      const probe = state.probes[m.id];
                      const health = !probe ? "" : probe.ready ? "ok" : probe.ok ? "warn" : "err";
                      return (
                        <button key={m.id} className="tree-row run-row" onClick={() => open({ kind: "compute" })}>
                          <span className={`health ${health}`} style={{ width: 7, height: 7, flexShrink: 0 }} />
                          <span style={{ fontWeight: 560 }} className="truncate">{m.name}</span>
                          <span className="faint truncate" style={{ fontSize: 12.5 }}>{probe?.gpus?.[0]?.name?.replace(/^NVIDIA (GeForce )?/, "") ?? ""}</span>
                        </button>
                      );
                    })
                  )}
                </div>
              </>
            )}
          </aside>
        )}
        {sideOpen && <div className="side-resize" onMouseDown={resizeSide} />}

        <div className="center">
        <section className="workbench">
          {tabs.length > 0 && (
            <div className="tabs">
              <div className="tabs-scroll">
                {tabs.map((t) => {
                  const id = tabId(t);
                  const { icon, label } = tabLabel(t);
                  const dirty = t.kind === "file" && isDirty(t.path);
                  return (
                    <div
                      key={id}
                      className={`tab ${id === activeId ? "active" : ""} ${dirty ? "dirty" : ""}`}
                      title={t.kind === "file" ? t.path : label}
                      onClick={() => setActiveId(id)}
                      onMouseDown={(e) => {
                        if (e.button !== 1) return;
                        e.preventDefault();
                        close(id);
                      }}
                    >
                      {icon}
                      <span className="tab-label">{label}</span>
                      <button
                        className="tab-close"
                        onMouseDown={(e) => e.stopPropagation()}
                        onClick={(e) => {
                          e.stopPropagation();
                          close(id);
                        }}
                        aria-label={`Close ${label}`}
                      >
                        <span className="tab-dot" />
                        <X size={13} />
                      </button>
                    </div>
                  );
                })}
              </div>
              {activeFile?.endsWith(".py") && (
                <button className="btn ghost sm tab-action" onClick={() => void runOnGpu(activeFile)} title={`Run ${activeFile} on a GPU`}>
                  <Play size={12} fill="currentColor" /> Run on GPU
                </button>
              )}
            </div>
          )}
          {activeFile && <div className="breadcrumbs">{activeFile.split("/").join("  ›  ")}</div>}
          <div className="workbench-body">
            {editorPath && (
              <div className="editor-pane" style={{ display: activeFile ? "flex" : "none" }}>
                <CodeEditor path={editorPath} reveal={reveal} onSaveError={(p, e) => toast("error", `Could not save ${baseName(p)}`, errorMessage(e))} />
              </div>
            )}
            {active?.kind === "diff" && <DiffEditor key={activeId} path={active.path} base={active.base} onError={(msg) => toast("error", "Could not open the diff", msg)} />}
            {!activeFile && active?.kind !== "diff" && (
              <div className="main pane-scroll">
                {!state.project && (!active || active.kind === "runs" || active.kind === "run" || active.kind === "compare") ? (
                  <Welcome state={state} onAddMachine={() => setMachineDialog({})} />
                ) : active ? (
                  page(active)
                ) : (
                  <EmptyEditor onQuickOpen={() => setQuickOpen(true)} onRuns={() => open({ kind: "runs" })} />
                )}
              </div>
            )}
          </div>
        </section>
        {panelOpen && <div className="panel-resize" onMouseDown={resizePanel} />}
        <div className="panel-slot" style={{ height: panelOpen ? panelHeight : 0, display: panelOpen ? "flex" : "none" }}>
          <TerminalPanel visible={panelOpen} onClose={() => setPanelOpen(false)} />
        </div>
        </div>

        {agentOpen && <div className="side-resize" onMouseDown={resizeAgent} />}
        <div className="agent-slot" style={{ width: agentWidth, display: agentOpen ? "flex" : "none" }}>
          <AgentPanel
            visible={agentOpen}
            activeFile={activeFile}
            projectOpen={!!state.project}
            focusNonce={agentNonce}
            onClose={() => setAgentOpen(false)}
            onReview={(path) => open({ kind: "diff", path, base: "disk" })}
          />
        </div>
      </div>

      <StatusBar runs={runs} machines={state.machines.length} file={activeFile} onOpen={(runId) => open({ kind: "run", runId })} />

      {quickOpen && state.project && (
        <QuickOpen
          onClose={() => setQuickOpen(false)}
          onPick={(path) => {
            setQuickOpen(false);
            open({ kind: "file", path });
          }}
        />
      )}
      {newRun && state.project && (
        <NewRunDialog
          state={state}
          prefill={newRun}
          onClose={() => setNewRun(null)}
          onLaunched={(runId) => {
            setNewRun(null);
            open({ kind: "run", runId });
          }}
        />
      )}
      {machineDialog && <MachineDialog machine={machineDialog.machine} onClose={() => setMachineDialog(null)} />}
    </div>
  );
}

function EmptyEditor({ onQuickOpen, onRuns }: { onQuickOpen: () => void; onRuns: () => void }) {
  return (
    <div className="empty-editor">
      <div className="brand-mark" style={{ width: 44, height: 44, borderRadius: 12 }}>
        <Layers size={22} strokeWidth={2.2} />
      </div>
      <div className="shortcuts">
        <button onClick={onQuickOpen}>
          Go to file <span className="kbd">Ctrl P</span>
        </button>
        <button onClick={onRuns}>
          Runs dashboard <span className="kbd">Runs</span>
        </button>
        <button onClick={() => void api.openProjectDialog()}>
          Open folder <span className="kbd">Ctrl O</span>
        </button>
        <div className="shortcut-row">
          New run <span className="kbd">Ctrl N</span>
        </div>
        <div className="shortcut-row">
          Ask the assistant <span className="kbd">Ctrl L</span>
        </div>
        <div className="shortcut-row">
          Terminal <span className="kbd">Ctrl `</span>
        </div>
        <div className="shortcut-row">
          Search in files <span className="kbd">Ctrl Shift F</span>
        </div>
        <div className="shortcut-row">
          Toggle side bar <span className="kbd">Ctrl B</span>
        </div>
      </div>
    </div>
  );
}

function StatusBar({ runs, machines, file, onOpen }: { runs: ReturnType<typeof useRuns>; machines: number; file: string | null; onOpen: (id: string) => void }) {
  const live = runs.find((r) => r.status === "running");
  const lost = runs.filter((r) => r.connection === "lost" && r.status === "unknown").length;
  return (
    <footer className="statusbar">
      <span className="item">
        <Cpu size={12} /> {machines} machine{machines === 1 ? "" : "s"}
      </span>
      {live ? (
        <button className="item" onClick={() => onOpen(live.runId)}>
          <span className="health ok" style={{ width: 6, height: 6 }} />
          {live.name}
          {live.primaryMetric && (
            <span className="mono">
              {live.primaryMetric.key} {formatNumber(live.primaryMetric.last)}
            </span>
          )}
          {live.gpuName && <span>· {live.gpuName}</span>}
          {live.durationSec !== null && <span className="mono">· {formatDuration(live.durationSec)}</span>}
          {live.costUsd !== null && <span className="mono">· {formatUsd(live.costUsd)}</span>}
        </button>
      ) : (
        <span className="item faint">No active runs</span>
      )}
      {lost > 0 && (
        <span className="item" style={{ color: "var(--warn)" }}>
          <Unplug size={12} /> {lost} run{lost === 1 ? "" : "s"} unreachable
        </span>
      )}
      <span className="spacer" />
      {file && <span className="item faint">{file}</span>}
      <span className="item faint">UTF-8</span>
    </footer>
  );
}
