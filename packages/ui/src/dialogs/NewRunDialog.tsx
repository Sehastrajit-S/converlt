import { useEffect, useMemo, useState } from "react";
import { CircleCheck, CircleX, Cpu, Database, GitCommitHorizontal, Gauge, Layers, LoaderCircle, Package, Play, Rocket, TriangleAlert } from "lucide-react";
import { expandSweep, fmtSeconds, multiGpuCommand, parseCliHyperparameters, parseMultiGpu, parseSweepValues, type RunOptions } from "@converge/run-protocol";
import type { AppState, JobEstimateResult, ReproducePlan, SyncPlanView } from "@converge/core/api";
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
  /** For a reproduction: how code, data and environment are reproduced. */
  plan?: ReproducePlan;
}

const STAGES = [
  { id: "env", label: "Rebuild the original environment" },
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
  const [estimate, setEstimate] = useState<JobEstimateResult | null>(null);
  /** The user picked a machine themselves: don't move it to the recommended one. */
  const [picked, setPicked] = useState(!!prefill?.machineId);
  const [sweep, setSweep] = useState(false);
  const [sweepText, setSweepText] = useState("lr = 1e-4..1e-2 x3 log");
  const [sweepMode, setSweepMode] = useState<"grid" | "random">("grid");
  const [sweepMax, setSweepMax] = useState(12);
  const [perMachine, setPerMachine] = useState(1);
  const [sweepError, setSweepError] = useState<string | null>(null);
  const repro = prefill?.plan;
  const [rebuildEnv, setRebuildEnv] = useState(false);

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

  // Memory, time and the best machine, from earlier runs of the same script.
  useEffect(() => {
    if (!command.trim()) return setEstimate(null);
    const t = setTimeout(() => {
      api.estimateJob({ command: command.trim() }).then(
        (r) => {
          setEstimate(r);
          if (!picked && r.estimate && r.recommendedMachineId) setMachineId(r.recommendedMachineId);
        },
        () => setEstimate(null),
      );
    }, 350);
    return () => clearTimeout(t);
  }, [command, picked]);

  const sweepPlan = useMemo(() => {
    if (!sweep) return null;
    const { values, errors } = parseSweepValues(sweepText);
    if (errors.length) return { error: errors[0]! };
    return expandSweep(command, values, { mode: sweepMode, max: sweepMax, seed: 1 });
  }, [sweep, sweepText, sweepMode, sweepMax, command]);

  const launchSweep = async () => {
    if (!machineId || !sweepPlan || !Array.isArray(sweepPlan)) return;
    setSweepError(null);
    try {
      await api.launchSweep({ command: command.trim(), values: sweepText, mode: sweepMode, max: sweepMax, machineIds: [machineId], perMachine, options });
      onClose();
    } catch (e) {
      setSweepError(errorMessage(e));
    }
  };

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
    let python: string | undefined;
    if (repro && rebuildEnv && prefill?.reproducedFrom) {
      setLaunching({ runId: null, stage: "env" });
      try {
        python = (await api.reproduceEnv(prefill.reproducedFrom, machineId)).python;
      } catch (e) {
        setLaunching({ runId: null, stage: "failed", error: errorMessage(e) });
        return;
      }
    }
    setLaunching({ runId: null, stage: "agent" });
    try {
      const { runId } = await api.launchRun({ machineId, command: command.trim(), options, reproducedFrom: prefill?.reproducedFrom, exactCode: repro?.code.mode === "exact", python });
      setLaunching((l) => (l && !l.runId ? { ...l, runId } : l));
    } catch (e) {
      setLaunching({ runId: null, stage: "failed", error: errorMessage(e) });
    }
  };

  if (launching) {
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
          {STAGES.filter((s) => s.id !== "env" || (repro && rebuildEnv)).map((s, i, stages) => {
            const idx = stages.findIndex((x) => x.id === launching.stage);
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
          {sweep ? (
            <button className="btn primary" disabled={!machineId || !command.trim() || !plan || !Array.isArray(sweepPlan)} onClick={launchSweep}>
              <Layers size={13} /> Launch {Array.isArray(sweepPlan) ? `${sweepPlan.length} runs` : "sweep"}
            </button>
          ) : (
            <button className="btn primary" disabled={!machineId || !command.trim() || !plan} onClick={launch}>
              <Play size={13} fill="currentColor" /> Launch
            </button>
          )}
        </>
      }
    >
      {repro && (
        <div className="repro-card">
          {repro.shared && (
            <div className="faint" style={{ marginBottom: 8 }}>
              Shared by <b>{repro.shared.by}</b> from their project {repro.shared.project} ({repro.shared.originalName}).
            </div>
          )}
          <div className="repro-row">
            <GitCommitHorizontal size={15} />
            <div>
              <b>Code</b> <span className={`tag ${repro.code.mode === "unknown" ? "warn-tag" : ""}`}>{repro.code.mode === "exact" ? "exact checkout" : repro.code.mode === "current" ? "your files match" : "your current files"}</span>
              <div className="faint">{repro.code.detail}</div>
            </div>
          </div>
          <div className="repro-row">
            <Database size={15} />
            <div>
              <b>Data</b>
              {repro.data.length === 0 ? (
                <div className="faint">None recorded.</div>
              ) : (
                repro.data.map((d) => (
                  <div key={d.name} className="faint">
                    {d.name}: {d.source ? `downloaded again from ${d.source.hub === "huggingface" ? "Hugging Face" : "Kaggle"} (${d.source.id}) if it isn't on the machine` : <span className="mono">{d.path}</span>}
                    {d.fingerprint ? "; checked against the original's fingerprint" : ""}
                  </div>
                ))
              )}
            </div>
          </div>
          <div className="repro-row">
            <Package size={15} />
            <div style={{ flex: 1 }}>
              <b>Environment</b>{" "}
              <span className="faint">
                originally {[repro.env.python && `Python ${repro.env.python}`, repro.env.torch && `PyTorch ${repro.env.torch}`, repro.env.cuda && `CUDA ${repro.env.cuda}`, repro.env.gpu].filter(Boolean).join(", ") || "not recorded"}
              </span>
              {repro.env.packages > 0 && (
                <div className="row" style={{ gap: 8, marginTop: 6 }}>
                  <Switch on={rebuildEnv} onChange={setRebuildEnv} label="Rebuild the original environment" />
                  <span>
                    Rebuild it <span className="faint">· a new environment with the {repro.env.packages} packages the run had (takes a few minutes the first time). Off: the machine's Python.</span>
                  </span>
                </div>
              )}
            </div>
          </div>
          <div className="faint" style={{ marginTop: 8 }}>When it finishes, Converlt compares it with the original and says whether it reproduced.</div>
        </div>
      )}

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
                <button
                  key={m.id}
                  className={`choice ${machineId === m.id ? "on" : ""}`}
                  onClick={() => {
                    setMachineId(m.id);
                    setPicked(true);
                  }}
                >
                  <div className="choice-title">
                    <Cpu size={14} />
                    <span className="truncate">{m.name}</span>
                    <span className={`health ${!p ? "" : !p.ok ? "err" : p.ready ? "ok" : "warn"}`} style={{ marginLeft: "auto" }} />
                  </div>
                  <div className="choice-sub truncate">
                    {gpu ? `${p!.gpus!.length > 1 ? `${p!.gpus!.length}× ` : ""}${gpu.name} · ${formatMiB(gpu.memTotalMiB)}` : p?.ok ? "No GPU detected" : p ? "Unreachable" : "Not tested yet"}
                  </div>
                  <div className="choice-sub">{m.hourlyRate !== undefined ? `$${m.hourlyRate}/hr` : "no rate set"}</div>
                  {(() => {
                    const c = estimate?.estimate ? estimate.machines.find((x) => x.machineId === m.id) : null;
                    if (!c) return null;
                    return (
                      <div className={`choice-sub ${c.fits ? "" : "err-text"}`}>
                        {estimate!.recommendedMachineId === m.id && <span className="tag ok-tag">Best fit</span>} {!c.fits ? "Too little free GPU memory" : c.seconds !== null ? `about ${fmtSeconds(c.seconds)}` : ""}
                      </div>
                    );
                  })()}
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
        {(() => {
          const gpus = selected ? (state.probes[selected.id]?.gpus?.length ?? 0) : 0;
          const multi = parseMultiGpu(command);
          const spread = multiGpuCommand(command, gpus);
          if (gpus < 2 || (!multi && !spread)) return null;
          return (
            <div className="row" style={{ gap: 8, marginTop: 8, fontSize: 12.5 }}>
              <Switch on={!!multi} onChange={(on) => setCommand(on ? (spread ?? command) : (multi?.single ?? command))} label={`Use all ${gpus} GPUs`} />
              <span>
                Use all {gpus} GPUs <span className="faint">· one process per GPU with torchrun; the script must use DDP (Model Builder scripts do)</span>
              </span>
            </div>
          );
        })()}
        <span className="hint">
          Runs in <span className="mono">{state.settings.remoteRoot}/{project.name}</span> with bash. Activate an environment inline if needed, e.g.{" "}
          <span className="mono">source .venv/bin/activate && python train.py</span>
        </span>
        {estimate?.estimate && (
          <div className="estimate-line">
            <Gauge size={13} />
            <span>
              {estimate.estimate.measured ? (
                <>
                  Took <b>{fmtSeconds(estimate.estimate.measured.seconds)}</b> on {estimate.estimate.measured.gpu ?? "its machine"}
                  {estimate.estimate.memMiB > 0 && <>, with the GPU at up to {(estimate.estimate.memMiB / 1024).toFixed(1)} GB in use</>}
                </>
              ) : (
                <>
                  About <b>{Math.max(1, Math.ceil(estimate.estimate.memMiB / 1024))} GB</b> of GPU memory
                </>
              )}
              <span className="faint"> · from {estimate.estimate.basis}</span>
            </span>
          </div>
        )}
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

      <div className="field sweep-field">
        <div className="row" style={{ gap: 8 }}>
          <Switch on={sweep} onChange={setSweep} label="Sweep" />
          <span>
            <b>Sweep</b> <span className="faint">· run this command once per setting, each value written into its command line</span>
          </span>
        </div>
        {sweep && (
          <div className="sweep-box">
            <textarea className="input mono" rows={3} value={sweepText} onChange={(e) => setSweepText(e.target.value)} placeholder={"lr = 1e-3, 3e-4\nbatch-size = 32, 64\nlr = 1e-4..1e-2 x4 log"} />
            <div className="row wrap" style={{ gap: 10, fontSize: 12.5 }}>
              <select className="input" value={sweepMode} onChange={(e) => setSweepMode(e.target.value as "grid" | "random")} style={{ width: "auto" }}>
                <option value="grid">Every combination</option>
                <option value="random">Random sample</option>
              </select>
              <label className="row" style={{ gap: 6 }}>
                at most <input className="input mono" style={{ width: 56 }} inputMode="numeric" value={sweepMax} onChange={(e) => setSweepMax(Math.max(1, Math.min(200, Number(e.target.value.replace(/\D/g, "")) || 1)))} /> runs
              </label>
              <label className="row" style={{ gap: 6 }}>
                <input className="input mono" style={{ width: 44 }} inputMode="numeric" value={perMachine} onChange={(e) => setPerMachine(Math.max(1, Math.min(8, Number(e.target.value.replace(/\D/g, "")) || 1)))} /> at a time; the rest wait their turn
              </label>
            </div>
            {sweepPlan && !Array.isArray(sweepPlan) ? (
              <div className="callout err">
                <CircleX size={15} /> {sweepPlan.error}
              </div>
            ) : sweepPlan ? (
              <div className="sweep-preview mono">
                {sweepPlan.slice(0, 6).map((p) => (
                  <div key={p.command} className="truncate">
                    {p.command}
                  </div>
                ))}
                {sweepPlan.length > 6 && <div className="faint">… and {sweepPlan.length - 6} more</div>}
              </div>
            ) : null}
            {sweepError && (
              <div className="callout err">
                <CircleX size={15} /> {sweepError}
              </div>
            )}
            <span className="hint">One value list per line: <span className="mono">name = a, b, c</span>, or a range <span className="mono">name = 1e-4..1e-2 x4 log</span>. The runs are grouped under the sweep, and Runs → Report ranks them.</span>
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
