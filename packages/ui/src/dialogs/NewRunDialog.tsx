import { useEffect, useMemo, useState } from "react";
import { CircleCheck, CircleX, Cpu, LoaderCircle, Play, Rocket, TriangleAlert } from "lucide-react";
import { parseCliHyperparameters, type RunOptions } from "@converge/run-protocol";
import type { AppState, SyncPlanView } from "@converge/core/api";
import { api, errorMessage } from "../api.ts";
import { EnvIssues } from "../components/EnvIssues.tsx";
import { Dialog, Switch } from "../components/ui.tsx";
import { formatBytes, formatMiB, formatValue } from "../format.ts";

export interface NewRunPrefill {
  command?: string;
  machineId?: string | null;
  options?: RunOptions;
  warnings?: string[];
  reproducedFrom?: string;
  reproducedName?: string;
}

const STAGES = [
  { id: "agent", label: "Connect & install agent" },
  { id: "sync", label: "Sync code" },
  { id: "start", label: "Start supervised process" },
];

function storageKey(project: string) {
  return `converge:lastCommand:${project}`;
}

export function NewRunDialog({
  state,
  prefill,
  onClose,
  onLaunched,
  onSetupAlerts,
}: {
  state: AppState;
  prefill?: NewRunPrefill;
  onClose: () => void;
  onLaunched: (runId: string) => void;
  onSetupAlerts?: () => void;
}) {
  const project = state.project!;
  const initialCommand = prefill?.command ?? (() => {
    try {
      return localStorage.getItem(storageKey(project.path)) ?? state.settings.defaultCommand;
    } catch {
      return state.settings.defaultCommand;
    }
  })();
  const firstReady = state.machines.find((m) => state.probes[m.id]?.ready) ?? state.machines[0];
  const [machineId, setMachineId] = useState<string | null>(prefill?.machineId ?? firstReady?.id ?? null);
  const [command, setCommand] = useState(initialCommand);
  const [options, setOptions] = useState<RunOptions>(prefill?.options ?? state.settings.defaultOptions);
  const [plan, setPlan] = useState<SyncPlanView | null>(null);
  const [planError, setPlanError] = useState<string | null>(null);
  const [showSkipped, setShowSkipped] = useState(false);
  const [launching, setLaunching] = useState<{ runId: string | null; stage: string; error?: string } | null>(null);

  useEffect(() => {
    api.planSync().then(setPlan, (e) => setPlanError(errorMessage(e)));
  }, []);

  useEffect(() => {
    if (!launching) return;
    return api.onLaunchProgress((p) => {
      if (launching.runId && p.runId !== launching.runId) return;
      if (p.stage === "started") onLaunched(p.runId);
      else setLaunching((l) => (l ? { ...l, runId: p.runId, stage: p.stage, error: p.stage === "failed" ? p.detail : undefined } : l));
    });
  }, [launching, onLaunched]);

  const hp = useMemo(() => parseCliHyperparameters(command), [command]);
  const selected = state.machines.find((m) => m.id === machineId) ?? null;
  const alertsUrl = state.settings.defaultOptions.notifyUrl;

  const launch = async () => {
    if (!machineId || !command.trim()) return;
    try {
      localStorage.setItem(storageKey(project.path), command.trim());
    } catch {
      // storage unavailable
    }
    setLaunching({ runId: null, stage: "agent" });
    try {
      const { runId } = await api.launchRun({ machineId, command: command.trim(), options, reproducedFrom: prefill?.reproducedFrom });
      setLaunching((l) => (l && !l.runId ? { ...l, runId } : l));
    } catch (e) {
      setLaunching({ runId: null, stage: "failed", error: errorMessage(e) });
    }
  };

  if (launching) {
    const idx = STAGES.findIndex((s) => s.id === launching.stage);
    const failed = launching.stage === "failed";
    return (
      <Dialog title={failed ? "Launch failed" : "Launching run"} icon={<Rocket size={18} />} onClose={onClose}
        footer={
          <>
            <div className="spacer" />
            {failed && launching.runId && (
              <button className="btn" onClick={() => onLaunched(launching.runId!)}>
                View run
              </button>
            )}
            <button className="btn" onClick={failed ? () => setLaunching(null) : onClose}>
              {failed ? "Back" : "Run in background"}
            </button>
          </>
        }
      >
        <div className="progress-steps">
          {STAGES.map((s, i) => {
            const done = !failed ? i < idx : i < Math.max(0, idx);
            const active = !failed && i === idx;
            return (
              <div key={s.id} className={`progress-step ${done ? "done" : ""} ${active ? "active" : ""}`}>
                {done ? <CircleCheck size={16} /> : active ? <LoaderCircle size={16} className="spin" /> : <span style={{ width: 16, height: 16, borderRadius: 8, border: "1.5px solid var(--border-strong)", display: "inline-block" }} />}
                {s.label}
                {s.id === "sync" && plan && <span className="faint">· {plan.files} files, {formatBytes(plan.bytes)}</span>}
              </div>
            );
          })}
        </div>
        {failed && (
          <div className="callout err">
            <CircleX size={15} />
            <span className="selectable">{launching.error}</span>
          </div>
        )}
      </Dialog>
    );
  }

  return (
    <Dialog
      wide
      title={prefill?.reproducedFrom ? `Reproduce ${prefill.reproducedName ?? "run"}` : "New run"}
      icon={<Play size={17} />}
      onClose={onClose}
      footer={
        <>
          <span className="faint" style={{ fontSize: 12 }}>
            Training runs under a supervisor on the machine. Closing Converlt won't stop it.
          </span>
          <div className="spacer" />
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" disabled={!machineId || !command.trim() || !plan} onClick={launch}>
            <Play size={13} fill="currentColor" /> Launch
          </button>
        </>
      }
    >
      {prefill?.warnings && prefill.warnings.length > 0 && (
        <div className="callout">
          <TriangleAlert size={15} />
          <div>
            <b>Reproduction notes</b>
            <ul>
              {prefill.warnings.map((w) => (
                <li key={w}>{w}</li>
              ))}
            </ul>
          </div>
        </div>
      )}

      <div className="field">
        <label>Machine</label>
        {state.machines.length === 0 ? (
          <div className="callout err">
            <CircleX size={15} /> Add a GPU machine on the Compute page first.
          </div>
        ) : (
          <div className="choice-grid">
            {state.machines.map((m) => {
              const p = state.probes[m.id];
              const gpu = p?.gpus?.[0];
              return (
                <button key={m.id} className={`choice ${machineId === m.id ? "on" : ""}`} onClick={() => setMachineId(m.id)}>
                  <div className="choice-title">
                    <Cpu size={14} />
                    <span className="truncate">{m.name}</span>
                    <span className={`health ${!p ? "" : !p.ok ? "err" : p.ready ? "ok" : "warn"}`} style={{ marginLeft: "auto" }} />
                  </div>
                  <div className="choice-sub truncate">
                    {gpu ? `${p!.gpus!.length > 1 ? `${p!.gpus!.length}× ` : ""}${gpu.name} · ${formatMiB(gpu.memTotalMiB)}` : p?.ok ? "No GPU detected" : p ? "Unreachable" : "Not tested yet"}
                  </div>
                  <div className="choice-sub">{m.hourlyRate !== undefined ? `$${m.hourlyRate}/hr` : "no rate set"}</div>
                </button>
              );
            })}
          </div>
        )}
        {selected && <EnvIssues machine={selected} probe={state.probes[selected.id]} />}
      </div>

      <div className="field">
        <label>Command</label>
        <input className="input mono" style={{ height: 40 }} value={command} autoFocus onChange={(e) => setCommand(e.target.value)} onKeyDown={(e) => e.key === "Enter" && launch()} placeholder="python train.py --lr 3e-4" />
        <span className="hint">
          Runs in <span className="mono">{state.settings.remoteRoot}/{project.name}</span> with bash. Activate an environment inline if needed, e.g.{" "}
          <span className="mono">source .venv/bin/activate && python train.py</span>
        </span>
        {Object.keys(hp).length > 0 && (
          <div className="row wrap" style={{ gap: 6, marginTop: 2 }}>
            {Object.entries(hp).map(([k, v]) => (
              <span key={k} className="tag mono">
                {k}={formatValue(v)}
              </span>
            ))}
          </div>
        )}
      </div>

      <div className="grid-2" style={{ alignItems: "start" }}>
        <div className="card" style={{ padding: "4px 14px", boxShadow: "none" }}>
          <div className="option-row">
            <div className="text">
              <div className="title">Stop on NaN loss</div>
              <div className="hint">Stop the run as soon as a non-finite metric is logged.</div>
            </div>
            <Switch on={options.stopOnNan} onChange={(v) => setOptions({ ...options, stopOnNan: v })} label="Stop on NaN" />
          </div>
          <div className="option-row">
            <div className="text">
              <div className="title">Phone alert</div>
              <div className="hint">{alertsUrl ? "Message your phone when the run ends, fails, hits NaN or stalls." : "Get a message on your phone when the run ends or fails."}</div>
            </div>
            {alertsUrl ? (
              <Switch on={!!options.notifyUrl} onChange={(v) => setOptions({ ...options, notifyUrl: v ? alertsUrl : undefined })} label="Phone alert" />
            ) : (
              onSetupAlerts && (
                <button className="btn sm" onClick={onSetupAlerts}>
                  Set up
                </button>
              )
            )}
          </div>
          <div className="option-row">
            <div className="text">
              <div className="title">Stall alert</div>
              <div className="hint">Warn after this many minutes without output (0 = off).</div>
            </div>
            <input className="input mono" inputMode="numeric" value={options.stallMinutes} onChange={(e) => setOptions({ ...options, stallMinutes: Number(e.target.value.replace(/\D/g, "")) || 0 })} />
          </div>
          <div className="option-row">
            <div className="text">
              <div className="title">Telemetry interval</div>
              <div className="hint">Seconds between GPU samples.</div>
            </div>
            <input className="input mono" inputMode="numeric" value={options.telemetryIntervalSec} onChange={(e) => setOptions({ ...options, telemetryIntervalSec: Math.max(2, Number(e.target.value.replace(/\D/g, "")) || 10) })} />
          </div>
        </div>

        <div className="card" style={{ padding: 14, boxShadow: "none" }}>
          <div className="label" style={{ marginBottom: 8 }}>
            Code sync
          </div>
          {planError ? (
            <div className="callout err">
              <CircleX size={15} />
              <span>{planError}</span>
            </div>
          ) : !plan ? (
            <div className="row faint">
              <LoaderCircle size={14} className="spin" /> Scanning project…
            </div>
          ) : (
            <>
              <div style={{ fontSize: 18, fontWeight: 650 }}>
                {plan.files.toLocaleString()} {plan.files === 1 ? "file" : "files"} <span className="faint" style={{ fontSize: 13, fontWeight: 500 }}>· {formatBytes(plan.bytes)}</span>
              </div>
              <div className="hint" style={{ marginTop: 4 }}>
                {plan.usedGit ? "Tracked and untracked files, respecting .gitignore." : "All files (not a git repository)."} Datasets, checkpoints, environments, and credentials are excluded.
              </div>
              {project.isGitRepo ? null : (
                <div className="hint" style={{ color: "var(--warn)" }}>Without git, Converlt can't record the exact code version.</div>
              )}
              {plan.skippedCount > 0 && (
                <button className="btn ghost sm" style={{ marginTop: 8, marginLeft: -8 }} onClick={() => setShowSkipped(!showSkipped)}>
                  {showSkipped ? "Hide" : "Show"} {plan.skippedCount} skipped
                </button>
              )}
              {showSkipped && (
                <pre className="code-block" style={{ maxHeight: 160, marginTop: 6 }}>
                  {plan.skipped.map((s) => `${s.path}  (${s.reason})`).join("\n")}
                  {plan.skippedCount > plan.skipped.length ? `\n… and ${plan.skippedCount - plan.skipped.length} more` : ""}
                </pre>
              )}
            </>
          )}
        </div>
      </div>
    </Dialog>
  );
}
