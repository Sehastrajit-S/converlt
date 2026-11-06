// The guided wizard: the ML workflow as seven steps, one page each. A step's page says what to do,
// checks what's done from the project itself, and offers the actions; Next unlocks when it's done.
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import {
  ArrowLeft,
  ArrowRight,
  BarChart3,
  Boxes,
  Check,
  CircleCheck,
  Circle,
  Cpu,
  Database,
  Download,
  FileText,
  GitCompare,
  Layers,
  LoaderCircle,
  Play,
  Share2,
  Sparkles,
  Wand2,
} from "lucide-react";
import { dataInsights, datasetSpec, isTerminal, type PreprocessStep } from "@converge/run-protocol";
import type { AppState, BuilderDesign, DatasetView, RunListItem, RunView } from "@converge/core/api";
import { api, errorMessage } from "../api.ts";
import { Empty, StatusPill, useToast } from "../components/ui.tsx";
import { formatDuration, formatValue, timeAgo } from "../format.ts";

export type GuideStep = "data" | "prepare" | "model" | "train" | "evaluate" | "improve" | "share";

const STEPS: { id: GuideStep; label: string; title: string; icon: ReactNode; intro: string }[] = [
  { id: "data", label: "Data", title: "Get your data", icon: <Database size={15} />, intro: "Everything starts with a dataset on the machine that will train. Download one from Hugging Face or Kaggle, or point Converlt at files already on a machine." },
  { id: "prepare", label: "Prepare", title: "Check and prepare the data", icon: <Wand2 size={15} />, intro: "Converlt profiles the data and looks for problems that quietly ruin models: leaked labels, ID columns, missing values, imbalance. Fix them here, and hold out a test split so the model can be judged fairly later." },
  { id: "model", label: "Model", title: "Choose a model", icon: <Boxes size={15} />, intro: "Pick a template that fits the data, or design one layer by layer in the Model Builder. Converlt writes the model and a training script for it." },
  { id: "train", label: "Train", title: "Train on a GPU", icon: <Play size={15} />, intro: "Launch the training script on a GPU machine. Converlt syncs the code, watches the run live, and warns you about NaNs, stalls and running out of memory." },
  { id: "evaluate", label: "Evaluate", title: "See how good it is", icon: <BarChart3 size={15} />, intro: "After training, the model is scored on the test split it never saw, and Converlt shows the examples it gets most wrong. That's where to look before trusting it." },
  { id: "improve", label: "Improve", title: "Try to do better", icon: <GitCompare size={15} />, intro: "Run a few variations (a sweep over learning rates, say), then compare them. Converlt says which is best, whether the difference is real or noise, and why one run beat another." },
  { id: "share", label: "Share", title: "Share and reproduce", icon: <Share2 size={15} />, intro: "Write up the results, and send the best run to a teammate. They can open it and reproduce it exactly: same code, same data, and a check that they got the same result." },
];

const doneKey = (project: string) => `converlt:guide:${project}`;
type Marks = { step?: GuideStep; shared?: boolean; manual?: Partial<Record<GuideStep, boolean>> };
function loadMarks(project: string): Marks {
  try {
    return JSON.parse(localStorage.getItem(doneKey(project)) ?? "{}");
  } catch {
    return {};
  }
}
function saveMarks(project: string, marks: Marks): void {
  try {
    localStorage.setItem(doneKey(project), JSON.stringify(marks));
  } catch {
    // storage unavailable: the wizard still works, it just won't remember the step
  }
}

export interface GuideActions {
  openData: () => void;
  openHub: () => void;
  openBuilder: () => void;
  newRun: (prefill?: { command?: string; machineId?: string | null }) => void;
  openRun: (runId: string) => void;
  compare: (runIds: string[]) => void;
  addMachine: () => void;
}

/** What the project has, for judging which steps are done. */
interface Facts {
  datasets: DatasetView[];
  designs: BuilderDesign[];
  latest: RunView | null;
  evaluated: RunView | null;
}

export function Guide({ state, runs, actions }: { state: AppState; runs: RunListItem[]; actions: GuideActions }) {
  const project = state.project!;
  const toast = useToast();
  const [marks, setMarks] = useState(() => loadMarks(project.path));
  const [facts, setFacts] = useState<Facts | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const completed = useMemo(() => runs.filter((r) => r.status === "completed"), [runs]);
  const refresh = useCallback(async () => {
    const [datasets, designs] = await Promise.all([api.dataList().catch(() => []), api.builderList().catch(() => [])]);
    const latest = runs[0] ? await api.getRun(runs[0].runId) : null;
    let evaluated: RunView | null = null;
    for (const r of completed.slice(0, 10)) {
      const v = await api.getRun(r.runId);
      if (v?.summary.failures || Object.keys(v?.summary.metrics ?? {}).some((k) => k.startsWith("test/"))) {
        evaluated = v;
        break;
      }
    }
    setFacts({ datasets, designs, latest, evaluated });
  }, [runs, completed]);
  useEffect(() => {
    void refresh();
  }, [refresh]);

  const mark = (m: Marks) => {
    const next = { ...marks, ...m };
    setMarks(next);
    saveMarks(project.path, next);
  };

  const dataset = facts?.datasets[0] ?? null;
  const done: Record<GuideStep, boolean> = useMemo(() => {
    const d = dataset;
    const prepared = !!d?.profile && (d.dataset.format === "images" || d.dataset.format === "tensors" || d.dataset.steps.some((s) => s.op === "split"));
    return {
      data: !!facts?.datasets.length,
      prepare: prepared,
      model: !!facts?.designs.length || !!marks.manual?.model,
      train: completed.length > 0,
      evaluate: !!facts?.evaluated || !!marks.manual?.evaluate,
      improve: completed.length >= 2,
      share: !!marks.shared || runs.some((r) => r.reproducedFrom),
    };
  }, [facts, dataset, completed, marks.shared, marks.manual, runs]);
  /** Steps Converlt can only infer: the user can say they've done them their own way. */
  const manualOk: Partial<Record<GuideStep, string>> = {
    model: "I have my own model and training script",
    evaluate: "My script evaluates the model its own way",
  };

  const firstOpen = STEPS.findIndex((s) => !done[s.id]);
  const reachable = (i: number) => firstOpen < 0 || i <= firstOpen;
  const current = Math.max(0, STEPS.findIndex((s) => s.id === (marks.step ?? STEPS[firstOpen < 0 ? STEPS.length - 1 : firstOpen]!.id)));
  const step = STEPS[current]!;
  const go = (i: number) => reachable(i) && mark({ step: STEPS[i]!.id });

  const run = async (key: string, fn: () => Promise<unknown>, ok?: string) => {
    setBusy(key);
    try {
      await fn();
      if (ok) toast("success", ok);
      await refresh();
    } catch (e) {
      toast("error", "That didn't work", errorMessage(e));
    } finally {
      setBusy(null);
    }
  };

  if (!facts)
    return (
      <div className="page">
        <div className="empty">
          <LoaderCircle className="spin" />
        </div>
      </div>
    );

  return (
    <div className="page guide">
      <div className="page-header">
        <div>
          <h1 className="page-title">ML Guide</h1>
          <div className="page-sub">
            <span>{project.name}</span>
            <span className="faint">·</span>
            <span className="faint">
              {STEPS.filter((s) => done[s.id]).length} of {STEPS.length} steps done
            </span>
          </div>
        </div>
      </div>

      <ol className="guide-steps">
        {STEPS.map((s, i) => (
          <li key={s.id}>
            <button className={`guide-step ${i === current ? "on" : ""} ${done[s.id] ? "done" : ""}`} disabled={!reachable(i)} onClick={() => go(i)} title={reachable(i) ? s.title : "Finish the steps before this one first"}>
              <span className="guide-dot">{done[s.id] ? <Check size={12} /> : i + 1}</span>
              <span>{s.label}</span>
            </button>
          </li>
        ))}
      </ol>

      <div className="card guide-card">
        <div className="guide-head">
          <span className="guide-icon">{step.icon}</span>
          <div>
            <div className="faint" style={{ fontSize: 12 }}>
              Step {current + 1} of {STEPS.length}
            </div>
            <h2>{step.title}</h2>
          </div>
          {done[step.id] && (
            <span className="tag ok-tag" style={{ marginLeft: "auto" }}>
              <CircleCheck size={12} /> Done
            </span>
          )}
        </div>
        <p className="guide-intro">{step.intro}</p>

        {step.id === "data" && <DataStep facts={facts} actions={actions} />}
        {step.id === "prepare" && <PrepareStep dataset={dataset} busy={busy} run={run} actions={actions} />}
        {step.id === "model" && <ModelStep facts={facts} dataset={dataset} actions={actions} />}
        {step.id === "train" && <TrainStep state={state} runs={runs} actions={actions} />}
        {step.id === "evaluate" && <EvaluateStep run={facts.evaluated} latest={facts.latest} actions={actions} />}
        {step.id === "improve" && <ImproveStep completed={completed} busy={busy} run={run} actions={actions} />}
        {step.id === "share" && <ShareStep completed={completed} busy={busy} run={run} onShared={() => mark({ shared: true })} actions={actions} />}

        <div className="guide-foot">
          <button className="btn" disabled={current === 0} onClick={() => go(current - 1)}>
            <ArrowLeft size={14} /> Back
          </button>
          <div className="spacer" />
          {!done[step.id] && <span className="faint" style={{ fontSize: 12 }}>Finish this step to continue.</span>}
          {!done[step.id] && manualOk[step.id] && (
            <button className="btn ghost sm" onClick={() => mark({ manual: { ...marks.manual, [step.id]: true } })} title="Mark this step done and continue">
              {manualOk[step.id]}
            </button>
          )}
          {current < STEPS.length - 1 ? (
            <button className="btn primary" disabled={!done[step.id]} onClick={() => go(current + 1)}>
              Next: {STEPS[current + 1]!.label} <ArrowRight size={14} />
            </button>
          ) : (
            done.share && (
              <span className="tag ok-tag">
                <Sparkles size={12} /> All steps done
              </span>
            )
          )}
        </div>
      </div>
    </div>
  );
}

// ------------------------------------------------------------ the steps

function Task({ ok, children }: { ok: boolean; children: ReactNode }) {
  return (
    <div className={`guide-task ${ok ? "ok" : ""}`}>
      {ok ? <CircleCheck size={15} /> : <Circle size={15} />}
      <div>{children}</div>
    </div>
  );
}

type Run = (key: string, fn: () => Promise<unknown>, ok?: string) => Promise<void>;

function DataStep({ facts, actions }: { facts: Facts; actions: GuideActions }) {
  return (
    <>
      <Task ok={facts.datasets.length > 0}>
        {facts.datasets.length ? (
          <>
            {facts.datasets.length === 1 ? "A dataset is" : `${facts.datasets.length} datasets are`} in the project:{" "}
            {facts.datasets.map((d) => (
              <span key={d.dataset.id} className="tag" style={{ marginRight: 4 }}>
                {d.dataset.name}
              </span>
            ))}
          </>
        ) : (
          "Add a dataset to the project."
        )}
      </Task>
      <div className="guide-actions">
        <button className="btn primary" onClick={actions.openHub}>
          <Download size={14} /> Download a dataset
        </button>
        <button className="btn" onClick={actions.openData}>
          <Database size={14} /> Use files on a machine
        </button>
      </div>
    </>
  );
}

function PrepareStep({ dataset, busy, run, actions }: { dataset: DatasetView | null; busy: string | null; run: Run; actions: GuideActions }) {
  if (!dataset) return <Empty icon={<Database size={22} />} title="No dataset yet">Go back a step and add one.</Empty>;
  const d = dataset.dataset;
  const p = dataset.profile;
  const insights = p ? dataInsights(p, d.steps).filter((i) => i.severity !== "info" || i.fix) : [];
  const needsSplit = d.format !== "images" && d.format !== "tensors" && !d.steps.some((s) => s.op === "split");
  const addStep = (step: PreprocessStep, label: string) =>
    run(label, async () => {
      await api.dataSave({ ...d, steps: [...d.steps, step] });
      await api.dataWriteCode(d.id);
    }, `${label}: added`);
  return (
    <>
      <Task ok={!!p}>
        {p ? (
          <>
            <b>{d.name}</b> is profiled. It feeds a model as <span className="mono">{datasetSpec(d, p).summary}</span>.
          </>
        ) : (
          <>Profile {d.name} so Converlt can check it.</>
        )}
        {!p && (
          <div className="guide-actions">
            <button className="btn sm primary" disabled={busy === "profile"} onClick={() => run("profile", () => api.dataProfile(d.id), "Profiled")}>
              {busy === "profile" ? <LoaderCircle size={13} className="spin" /> : <Sparkles size={13} />} Profile it
            </button>
          </div>
        )}
      </Task>
      {p && (
        <Task ok={!needsSplit}>
          {needsSplit ? "Hold out validation and test data, so the model is judged on rows it never trained on." : "Validation and test data are held out."}
          {needsSplit && (
            <div className="guide-actions">
              <button className="btn sm primary" disabled={!!busy} onClick={() => addStep({ op: "split", val: 0.1, test: 0.1, stratify: !!d.target, seed: 0 } as PreprocessStep, "Split 80/10/10")}>
                Split 80 / 10 / 10
              </button>
            </div>
          )}
        </Task>
      )}
      {p &&
        insights.map((i) => (
          <Task key={i.title} ok={false}>
            <b>{i.title}</b> <span className={i.severity === "error" ? "err-text" : "faint"}>({i.severity === "error" ? "must fix" : i.severity === "warning" ? "should fix" : "suggested"})</span>
            <div className="faint">{i.detail}</div>
            {i.fix && (
              <div className="guide-actions">
                <button className="btn sm" disabled={!!busy} onClick={() => addStep(i.fix!, i.title)}>
                  Apply the fix
                </button>
              </div>
            )}
          </Task>
        ))}
      <div className="guide-actions">
        <button className="btn" onClick={actions.openData}>
          <Database size={14} /> Open in Data for more
        </button>
      </div>
    </>
  );
}

function ModelStep({ facts, dataset, actions }: { facts: Facts; dataset: DatasetView | null; actions: GuideActions }) {
  return (
    <>
      <Task ok={facts.designs.length > 0}>
        {facts.designs.length ? (
          <>
            Model{facts.designs.length > 1 ? "s" : ""}:{" "}
            {facts.designs.map((g) => (
              <span key={g.file} className="tag" style={{ marginRight: 4 }}>
                {g.name}
              </span>
            ))}
          </>
        ) : (
          <>Design a model{dataset ? ` for ${dataset.dataset.name}` : ""}. The Model Builder suggests templates that fit the data.</>
        )}
      </Task>
      <div className="guide-actions">
        <button className="btn primary" onClick={actions.openBuilder}>
          <Boxes size={14} /> Open the Model Builder
        </button>
      </div>
      <div className="faint" style={{ fontSize: 12 }}>
        Have your own training script already? It counts too: train it in the next step.
      </div>
    </>
  );
}

function TrainStep({ state, runs, actions }: { state: AppState; runs: RunListItem[]; actions: GuideActions }) {
  const ready = state.machines.filter((m) => state.probes[m.id]?.ready);
  const last = runs[0];
  const done = runs.some((r) => r.status === "completed");
  return (
    <>
      <Task ok={ready.length > 0}>
        {ready.length ? (
          <>
            Ready to train on {ready.map((m) => m.name).join(", ")}
            {state.probes[ready[0]!.id]?.gpus?.[0] ? ` (${state.probes[ready[0]!.id]!.gpus![0]!.name})` : ""}.
          </>
        ) : state.machines.length ? (
          "A machine is added but isn't ready yet. Check it on the Compute page."
        ) : (
          "Add a GPU machine: one over SSH, your own GPU through WSL, or rent one in the cloud."
        )}
        {!state.machines.length && (
          <div className="guide-actions">
            <button className="btn sm primary" onClick={actions.addMachine}>
              <Cpu size={13} /> Add a machine
            </button>
          </div>
        )}
      </Task>
      <Task ok={done}>
        {last ? (
          <span className="row" style={{ gap: 8, display: "inline-flex" }}>
            Latest run: <b>{last.name}</b> <StatusPill status={last.status} connection={last.connection} />
            <span className="faint">{timeAgo(last.createdAt)}</span>
          </span>
        ) : (
          "Launch a training run. The Model Builder's Train on GPU does it for a designed model; New run works for any script."
        )}
        {last && !done && !isTerminal(last.status) && <div className="faint">It's running: this step completes when a run finishes successfully.</div>}
      </Task>
      <div className="guide-actions">
        <button className="btn primary" disabled={!state.machines.length} onClick={() => actions.newRun()}>
          <Play size={13} fill="currentColor" /> New run
        </button>
        {last && (
          <button className="btn" onClick={() => actions.openRun(last.runId)}>
            Watch {last.name}
          </button>
        )}
      </div>
    </>
  );
}

function EvaluateStep({ run, latest, actions }: { run: RunView | null; latest: RunView | null; actions: GuideActions }) {
  if (!run)
    return (
      <>
        <Task ok={false}>
          No finished run has an evaluation yet. Scripts from the Model Builder score the test split after training; in your own script, log metrics named <span className="mono">test/…</span>, or call{" "}
          <span className="mono">converge.log_failures</span>.
        </Task>
        {latest && (
          <div className="guide-actions">
            <button className="btn" onClick={() => actions.openRun(latest.manifest.runId)}>
              Open {latest.manifest.name}
            </button>
          </div>
        )}
      </>
    );
  const s = run.summary;
  const test = Object.keys(s.metrics).filter((k) => k.startsWith("test/"));
  const f = s.failures;
  return (
    <>
      <Task ok>
        <b>{run.manifest.name}</b> on the test split:{" "}
        {test.map((k) => (
          <span key={k} className="tag mono" style={{ marginRight: 4 }}>
            {k} {formatValue(s.metrics[k]!.at(-1)?.value ?? null)}
          </span>
        ))}
        {f && f.wrong !== null && (
          <div className="faint">
            {f.wrong} of {f.total} examples wrong ({((f.wrong / Math.max(1, f.total)) * 100).toFixed(1)}%).
          </div>
        )}
      </Task>
      {f && f.inputs.length > 0 && <Task ok={false}>Look at the worst mistakes on the run page: they show what the model hasn't learned, and often point at problems in the data.</Task>}
      <div className="guide-actions">
        <button className="btn primary" onClick={() => actions.openRun(run.manifest.runId)}>
          <BarChart3 size={14} /> Open the evaluation
        </button>
      </div>
    </>
  );
}

function ImproveStep({ completed, busy, run, actions }: { completed: RunListItem[]; busy: string | null; run: Run; actions: GuideActions }) {
  const best = completed[0];
  return (
    <>
      <Task ok={completed.length >= 2}>
        {completed.length >= 2 ? `${completed.length} finished runs to compare.` : "Run at least one more variation. A sweep runs several at once."}
      </Task>
      <div className="guide-actions">
        <button className="btn primary" onClick={() => actions.newRun(best ? { command: best.command } : undefined)}>
          <Layers size={14} /> Launch a sweep
        </button>
        <button className="btn" disabled={completed.length < 2} onClick={() => actions.compare(completed.slice(0, 2).map((r) => r.runId))}>
          <GitCompare size={14} /> Compare the latest two
        </button>
        <button className="btn" disabled={completed.length < 2 || !!busy} onClick={() => run("report", () => api.writeReport({ runIds: completed.slice(0, 30).map((r) => r.runId) }), "Report written")}>
          {busy === "report" ? <LoaderCircle size={14} className="spin" /> : <FileText size={14} />} Write the report
        </button>
      </div>
      <div className="faint" style={{ fontSize: 12 }}>
        In New run, turn on <b>Sweep</b> and list values, e.g. <span className="mono">lr = 1e-4..1e-2 x4 log</span>.
      </div>
    </>
  );
}

function ShareStep({ completed, busy, run, onShared, actions }: { completed: RunListItem[]; busy: string | null; run: Run; onShared: () => void; actions: GuideActions }) {
  const best = completed.find((r) => !r.reproducedFrom) ?? completed[0];
  return (
    <>
      <Task ok={false}>Write the experiment report: the runs ranked, the best one with its command and commit, its mistakes, and what to try next.</Task>
      <Task ok={false}>Share the best run as a file. A teammate opens it in Converlt (Runs → Open shared run) and reproduces it with the same code and data.</Task>
      <div className="guide-actions">
        <button className="btn" disabled={!completed.length || !!busy} onClick={() => run("report", () => api.writeReport({}), "Report written")}>
          {busy === "report" ? <LoaderCircle size={14} className="spin" /> : <FileText size={14} />} Write the report
        </button>
        <button
          className="btn primary"
          disabled={!best || !!busy}
          onClick={() =>
            run("share", async () => {
              const r = await api.shareRun(best!.runId);
              if (r) onShared();
            })
          }
        >
          <Share2 size={14} /> Share {best?.name ?? "a run"}
        </button>
        {best && (
          <button className="btn" onClick={() => actions.openRun(best.runId)}>
            Open {best.name}
          </button>
        )}
      </div>
      {best?.durationSec != null && <div className="faint" style={{ fontSize: 12 }}>{best.name} took {formatDuration(best.durationSec)}.</div>}
    </>
  );
}
