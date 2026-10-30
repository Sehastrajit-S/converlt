import { ArrowRight, Folder, FolderOpen, Server, Sparkles, Zap } from "lucide-react";
import type { AppState } from "@converge/core/api";
import { api, errorMessage } from "../api.ts";
import { useToast } from "../components/ui.tsx";

export function Welcome({ state, onAddMachine }: { state: AppState; onAddMachine: () => void }) {
  const toast = useToast();
  const open = async (p?: string) => {
    try {
      if (p) await api.openProject(p);
      else await api.openProjectDialog();
    } catch (e) {
      toast("error", "Could not open project", errorMessage(e));
    }
  };
  return (
    <div className="welcome">
      <span className="tag accent">
        <Sparkles size={12} /> PyTorch-first · your GPUs · your editor
      </span>
      <h1 className="hero-title">
        From your first training run
        <br />
        to your <span className="grad">best model</span>.
      </h1>
      <p className="hero-sub">
        Launch training on any GPU machine over SSH, watch it live, catch NaNs and out-of-memory failures, and compare every experiment.
        Training keeps running if you close Converlt.
      </p>
      <div className="row">
        <button className="btn primary" style={{ height: 38, padding: "0 18px" }} onClick={() => open()}>
          <FolderOpen size={16} /> Open project folder
        </button>
        <button className="btn" style={{ height: 38, padding: "0 16px" }} onClick={onAddMachine}>
          <Server size={16} /> Add GPU machine
        </button>
      </div>

      {state.recentProjects.length > 0 && (
        <div className="recent">
          <div className="section-title">Recent projects</div>
          <div className="card" style={{ padding: 6 }}>
            {state.recentProjects.map((p) => (
              <button key={p} className="recent-item" onClick={() => open(p)}>
                <Folder size={16} className="muted" />
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontWeight: 600 }}>{p.split(/[\\/]/).pop()}</div>
                  <div className="faint truncate mono" style={{ fontSize: 11.5 }}>{p}</div>
                </div>
                <ArrowRight size={14} className="faint" style={{ marginLeft: "auto" }} />
              </button>
            ))}
          </div>
        </div>
      )}

      <div className="steps">
        <div className="card step">
          <div className="step-num">1</div>
          <h4>Connect a GPU</h4>
          <p>Any Linux machine you can reach over SSH: a cloud instance, a lab server, or a box under your desk. Converlt installs a small agent; no root needed.</p>
        </div>
        <div className="card step">
          <div className="step-num">2</div>
          <h4>Open your repo</h4>
          <p>No restructuring. Converlt syncs your code (skipping data, checkpoints, and secrets) and records the git commit and uncommitted diff for every run.</p>
        </div>
        <div className="card step">
          <div className="step-num">3</div>
          <h4>
            Run <Zap size={12} style={{ verticalAlign: -1 }} />
          </h4>
          <p>
            Live logs, GPU memory, and utilization out of the box. Add <span className="mono">converge.run().log()</span> for metric curves and precise diagnostics.
          </p>
        </div>
      </div>
      {state.machines.length === 0 && (
        <p className="faint" style={{ marginTop: 26, fontSize: 12 }}>
          Tip: Converlt uses your existing <span className="mono">ssh</span> setup and keys. Nothing is stored except host names.
        </p>
      )}
    </div>
  );
}
