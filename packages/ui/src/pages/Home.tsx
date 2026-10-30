import { useEffect, useState, type ReactNode } from "react";
import { Activity, ArrowRight, Bot, CircleCheck, Plug, Boxes, Cloud, Code2, Coins, Cpu, Database, FlaskConical, FolderOpen, Play, Plus, Rocket, Server, Sparkles } from "lucide-react";
import type { AgentsStatus, AppState, RunListItem } from "@converge/core/api";
import { api, errorMessage } from "../api.ts";
import { useToast } from "../components/ui.tsx";
import { formatCredits, formatHours, useCloudStatus, usePods, useWallet } from "../cloud.ts";
import { StatusPill } from "../components/ui.tsx";
import { formatDuration, formatNumber, timeAgo } from "../format.ts";

export interface HomeActions {
  onNewRun: () => void;
  onOpenRun: (runId: string) => void;
  onOpenRuns: () => void;
  onOpenGpus: () => void;
  onOpenWallet: () => void;
  onOpenModels: () => void;
  onOpenEnvironments: () => void;
  onOpenHub?: () => void;
  onAddMachine: () => void;
  /** Dashboard mode (Converlt IDE): the page owns the window and lists projects. */
  dashboard?: boolean;
  onShowCode?: () => void;
  onOpenProject?: (path: string) => void;
  onOpenFolder?: () => void;
}

function greeting(): string {
  const h = new Date().getHours();
  return h < 5 ? "Working late" : h < 12 ? "Good morning" : h < 18 ? "Good afternoon" : "Good evening";
}

export function Home({ state, runs, ...a }: { state: AppState; runs: RunListItem[] } & HomeActions) {
  const cloud = useCloudStatus();
  const connected = !!cloud.data?.connected;
  const wallet = useWallet(connected);
  const pods = usePods(connected);
  const w = wallet.data;
  const livePods = (pods.data ?? []).filter((p) => p.status === "running" || p.status === "starting");
  const activeRuns = runs.filter((r) => r.status === "running" || r.status === "preparing");
  const failed = runs.filter((r) => r.status === "failed").length;
  const ready = state.machines.filter((m) => state.probes[m.id]?.ready).length;

  return (
    <div className={`page home ${a.dashboard ? "dashboard" : ""}`}>
      <div className="home-hero">
        <div>
          {a.dashboard && <div className="hero-eyebrow">{greeting()}</div>}
          <h1 className="hero-title">{state.project ? state.project.name : "Welcome to Converlt"}</h1>
          <div className="hero-sub">
            {state.project ? (
              <>
                {runs.length} run{runs.length === 1 ? "" : "s"}
                {failed ? ` · ${failed} failed` : ""}
                {state.project.branch ? ` · ${state.project.branch}` : ""}
              </>
            ) : (
              "Open your training code, pick a GPU, and run."
            )}
          </div>
        </div>
        <div className="spacer" />
        {state.project && a.onShowCode && (
          <button className="btn" onClick={a.onShowCode}>
            <Code2 size={14} /> Open in Code
          </button>
        )}
        {state.project && (
          <button className="btn primary" onClick={a.onNewRun}>
            <Play size={13} fill="currentColor" /> New run
          </button>
        )}
      </div>

      <div className="kpis">
        <Kpi icon={<Coins size={15} />} label="Credits" onClick={a.onOpenWallet} tone="accent">
          {connected && w ? (
            <>
              <b className="tabular">{formatCredits(w.balance)}</b>
              <span>{w.burnPerHour > 0 ? `${formatCredits(w.burnPerHour)}/hr · lasts ${formatHours(w.balance / w.burnPerHour)}` : "nothing running"}</span>
            </>
          ) : (
            <>
              <b>Connect</b>
              <span>Sign in to Converlt Cloud</span>
            </>
          )}
        </Kpi>
        <Kpi icon={<Cpu size={15} />} label="Cloud GPUs" onClick={a.onOpenGpus}>
          <b className="tabular">{connected ? livePods.length : "—"}</b>
          <span>{livePods.length ? livePods.map((p) => p.gpuName).slice(0, 2).join(", ") : "Launch one in seconds"}</span>
        </Kpi>
        <Kpi icon={<Activity size={15} />} label="Active runs" onClick={a.onOpenRuns}>
          <b className="tabular">{activeRuns.length}</b>
          <span>{activeRuns[0] ? `${activeRuns[0].name} on ${activeRuns[0].machineName}` : "No training running"}</span>
        </Kpi>
        <Kpi icon={<Server size={15} />} label="Machines ready" onClick={a.onOpenEnvironments}>
          <b className="tabular">
            {ready}/{state.machines.length}
          </b>
          <span>{state.machines.length ? "SSH, WSL and cloud pods" : "Add one or launch a GPU"}</span>
        </Kpi>
      </div>

      {a.dashboard && (
        <div className="card projects-card">
          <div className="card-head">
            <div className="card-title">Projects</div>
            <div className="spacer" />
            {a.onOpenFolder && (
              <button className="btn ghost sm" onClick={a.onOpenFolder}>
                <FolderOpen size={13} /> Open folder…
              </button>
            )}
          </div>
          <div className="projects">
            {[...new Set([...(state.project ? [state.project.path] : []), ...state.recentProjects])].slice(0, 8).map((p) => {
              const current = p === state.project?.path;
              const name = p.split(/[\\/]/).pop();
              return (
                <button key={p} className={`project ${current ? "current" : ""}`} onClick={() => (current ? a.onShowCode?.() : a.onOpenProject?.(p))}>
                  <span className="project-icon">
                    <FlaskConical size={16} />
                  </span>
                  <span className="project-text">
                    <b className="truncate">{name}</b>
                    <span className="faint mono truncate">{p}</span>
                  </span>
                  <span className="project-go">{current ? "Open in Code" : "Open"}</span>
                </button>
              );
            })}
            {!state.project && state.recentProjects.length === 0 && <div className="faint" style={{ padding: "6px 2px" }}>No recent projects. Open the folder with your training code.</div>}
          </div>
        </div>
      )}

      <AgentsCard />

      <div className="home-grid">
        <div className="card">
          <div className="card-head">
            <div className="card-title">Start something</div>
          </div>
          <div className="actions-grid">
            <Action icon={<Rocket size={18} />} title="Launch a GPU" sub="RTX 4090 to H100, billed per second" onClick={a.onOpenGpus} />
            <Action icon={<FlaskConical size={18} />} title="New training run" sub="Sync code, run, watch metrics" onClick={a.onNewRun} disabled={!state.project} />
            <Action icon={<Boxes size={18} />} title="Environments" sub="venv, conda, packages, CUDA" onClick={a.onOpenEnvironments} />
            <Action icon={<Sparkles size={18} />} title="Models" sub="Any LLM, one endpoint, your credits" onClick={a.onOpenModels} />
            <Action icon={<Plus size={18} />} title="Bring a machine" sub="Your own server over SSH or WSL" onClick={a.onAddMachine} />
            {a.onOpenHub ? (
              <Action icon={<Database size={18} />} title="Datasets & models" sub="Hugging Face and Kaggle, onto your GPU" onClick={a.onOpenHub} />
            ) : (
              <Action icon={<Cloud size={18} />} title="Wallet" sub="Balance, limits, activity" onClick={a.onOpenWallet} />
            )}
          </div>
        </div>

        <div className="card" style={{ overflow: "hidden" }}>
          <div className="card-head">
            <div className="card-title">Recent runs</div>
            <div className="spacer" />
            {runs.length > 0 && (
              <button className="btn ghost sm" onClick={a.onOpenRuns}>
                All runs <ArrowRight size={13} />
              </button>
            )}
          </div>
          {runs.length === 0 ? (
            <div className="empty faint" style={{ padding: 28 }}>
              {state.project ? "No runs yet. Start one on any machine." : "Open a folder to see its runs."}
            </div>
          ) : (
            <div className="recent-runs">
              {runs.slice(0, 6).map((r) => (
                <button key={r.runId} className="recent-run" onClick={() => a.onOpenRun(r.runId)}>
                  <span className="recent-run-name">{r.name}</span>
                  <StatusPill status={r.status} connection={r.connection} />
                  <span className="faint truncate">{r.primaryMetric ? `${r.primaryMetric.key} ${formatNumber(r.primaryMetric.last)}` : r.machineName}</span>
                  <span className="spacer" />
                  <span className="faint mono" style={{ fontSize: 11.5 }}>
                    {r.durationSec !== null ? formatDuration(r.durationSec) : ""} · {timeAgo(r.createdAt)}
                  </span>
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function Kpi({ icon, label, children, onClick, tone }: { icon: ReactNode; label: string; children: ReactNode; onClick: () => void; tone?: "accent" }) {
  return (
    <button className={`card kpi ${tone ?? ""}`} onClick={onClick}>
      <div className="kpi-label">
        {icon} {label}
      </div>
      <div className="kpi-body">{children}</div>
    </button>
  );
}

function Action({ icon, title, sub, onClick, disabled }: { icon: ReactNode; title: string; sub: string; onClick: () => void; disabled?: boolean }) {
  return (
    <button className="action" onClick={onClick} disabled={disabled}>
      <span className="action-icon">{icon}</span>
      <span style={{ minWidth: 0 }}>
        <b>{title}</b>
        <span className="faint">{sub}</span>
      </span>
    </button>
  );
}

/** Claude Code and Codex in the editor get Converlt's tools through the Converlt MCP server. */
function AgentsCard() {
  const toast = useToast();
  const [status, setStatus] = useState<AgentsStatus | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    api.agentsStatus().then(setStatus, () => {});
  }, []);
  if (!status) return null;
  const both = status.claudeCode && status.codex;
  const connect = async () => {
    setBusy(true);
    try {
      const st = await api.agentsConnect({ claudeCode: true, codex: true });
      setStatus(st);
      toast("success", "Converlt tools added for Claude Code and Codex", "Start a new agent session to use them.");
    } catch (e) {
      toast("error", "Could not connect the agents", errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="card agents-card">
      <span className="action-icon">
        <Bot size={18} />
      </span>
      <div style={{ minWidth: 0, flex: 1 }}>
        <b>Claude Code & Codex</b>
        <div className="faint" style={{ fontSize: 12.5, marginTop: 2 }}>
          Give your coding agents Converlt's tools: read runs and failure diagnoses, find datasets on your GPUs, and launch training with your approval.
        </div>
      </div>
      <span className={`tag ${status.claudeCode ? "ok" : ""}`}>{status.claudeCode && <CircleCheck size={10} />} Claude Code</span>
      <span className={`tag ${status.codex ? "ok" : ""}`}>{status.codex && <CircleCheck size={10} />} Codex</span>
      <button className={`btn ${both ? "ghost" : "primary"} sm`} disabled={busy} onClick={() => void connect()}>
        <Plug size={13} /> {both ? "Reconnect" : "Connect"}
      </button>
    </div>
  );
}
