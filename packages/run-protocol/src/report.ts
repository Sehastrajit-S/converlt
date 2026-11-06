// The experiment report: runs ranked on one metric, the best run and what set it apart, problems,
// the evaluation after training, and what to try next. Markdown, so it can be read in the editor,
// pasted into a PR or handed to an agent.
import { diffConfigs } from "./compare.ts";
import { finalValue, lowerBetter, type RunExplanation } from "./explain.ts";
import { primaryMetricKey, type RunSummary } from "./summary.ts";
import type { ExampleLabel, ExamplePrediction } from "./types.ts";

export interface ReportRun {
  name: string;
  status: string;
  command: string;
  config: Record<string, unknown>;
  summary: RunSummary;
  durationSec: number | null;
  costUsd: number | null;
  machine: string;
  gpu: string | null;
  group: string;
  gitCommit: string | null;
  dirty: boolean;
}

export interface RankedRun {
  run: ReportRun;
  value: number | null;
}

const PREFERRED = [
  /^test[/_.]?(accuracy|acc|f1|auc)$/i,
  /^(val|valid|validation|eval)[/_.]?(accuracy|acc|f1|auc)$/i,
  /^test[/_.]?loss$/i,
  /^(val|valid|validation|eval)[/_.]?loss$/i,
];

/** The metric to rank by: a test score, then validation accuracy or loss, then the primary metric. */
export function reportMetric(runs: ReportRun[]): string | null {
  const counts = new Map<string, number>();
  for (const r of runs) for (const [k, pts] of Object.entries(r.summary.metrics)) if (pts.some((p) => p.value !== null)) counts.set(k, (counts.get(k) ?? 0) + 1);
  const keys = [...counts.keys()];
  const half = Math.max(1, Math.ceil(runs.length / 2));
  for (const re of PREFERRED) {
    const hit = keys.filter((k) => re.test(k)).sort((a, b) => counts.get(b)! - counts.get(a)!)[0];
    if (hit && counts.get(hit)! >= half) return hit;
  }
  return primaryMetricKey(keys.sort((a, b) => counts.get(b)! - counts.get(a)!));
}

/** Runs best first on `metric`; runs without it (or failed ones) last. */
export function rankRuns(runs: ReportRun[], metric: string | null): RankedRun[] {
  const lower = metric ? lowerBetter(metric) : true;
  const ranked = runs.map((run) => {
    const pts = metric ? run.summary.metrics[metric] : undefined;
    const value = pts?.length ? finalValue(pts) : null;
    return { run, value };
  });
  const bad = (r: RankedRun) => (r.value === null ? 2 : r.run.status === "failed" || r.run.status === "lost" ? 1 : 0);
  return ranked.sort((x, y) => bad(x) - bad(y) || (x.value === null || y.value === null ? 0 : lower ? x.value - y.value : y.value - x.value));
}

const fmt = (v: unknown): string => {
  if (v === undefined) return "—";
  if (typeof v === "number") return Number.isInteger(v) ? v.toLocaleString("en-US") : Math.abs(v) < 1e-3 || Math.abs(v) >= 1e5 ? v.toExponential(2) : String(Number(v.toPrecision(4)));
  if (typeof v === "string") return v.length > 40 ? v.slice(0, 39) + "…" : v;
  return JSON.stringify(v).slice(0, 40);
};
const dur = (s: number | null) => (s === null ? "—" : s < 90 ? `${Math.round(s)}s` : s < 5400 ? `${Math.round(s / 60)} min` : `${(s / 3600).toFixed(1)} h`);
const cell = (s: string) => s.replace(/\|/g, "\\|").replace(/\n/g, " ");
/** Settings Converlt records about a run rather than choices made for it. */
const BOOKKEEPING = /^(parameters|gpus|total_steps|world|rank|seed_used|dataset|model)$/;

function labelText(l: ExampleLabel | undefined, names: string[]): string {
  if (!l) return "?";
  if ("class" in l) return l.name ?? names[l.class] ?? `class ${l.class}`;
  if ("value" in l) return fmt(l.value);
  return `[${l.values.slice(0, 4).map(fmt).join(", ")}…]`;
}
function predText(p: ExamplePrediction | undefined, names: string[]): string {
  if (!p) return "?";
  if ("class" in p && "p" in p) return `${names[p.class] ?? `class ${p.class}`} (${Math.round(p.p * 100)}%)`;
  if ("value" in p && "p" in p) return `${fmt(p.value)}`;
  if ("tokens" in p) return `tokens ${p.tokens.slice(0, 8).join(" ")}…`;
  if ("values" in p && Array.isArray(p.values)) return `[${(p.values as number[]).slice(0, 4).map(fmt).join(", ")}…]`;
  return "(reconstruction)";
}

/** Whether the metric was still getting better over the last fifth of the run. */
function stillImproving(r: ReportRun, metric: string): boolean {
  const pts = (r.summary.metrics[metric] ?? []).filter((p) => p.value !== null) as { step: number; value: number }[];
  if (pts.length < 10) return false;
  const k = Math.max(3, Math.floor(pts.length / 5));
  const tail = pts.slice(-k);
  const before = pts.slice(-2 * k, -k);
  const mean = (a: { value: number }[]) => a.reduce((s, p) => s + p.value, 0) / a.length;
  const gain = lowerBetter(metric) ? mean(before) - mean(tail) : mean(tail) - mean(before);
  return gain > Math.abs(mean(before)) * 0.01;
}

/** What to try next, from the ranking: edges of the range tried, overfitting, unfinished training, failures. */
export function nextSteps(ranked: RankedRun[], metric: string | null, why: RunExplanation | null): string[] {
  const out: string[] = [];
  const done = ranked.filter((r) => r.value !== null);
  const best = done[0]?.run;
  if (!best || !metric) {
    if (ranked.some((r) => r.run.summary.diagnostics.some((d) => d.severity === "error"))) out.push("Fix the errors listed under Problems first: no run produced a usable result.");
    return out;
  }
  // Settings varied across runs where the best value sits at the end of the range tried.
  const rows = diffConfigs(done.map((r) => r.run.config)).filter((row) => row.differs && !BOOKKEEPING.test(row.key));
  for (const row of rows) {
    const nums = row.values.filter((v): v is number => typeof v === "number");
    if (nums.length < 3 || nums.length !== row.values.length) continue;
    const bestV = row.values[0] as number;
    const lo = Math.min(...nums);
    const hi = Math.max(...nums);
    if (lo === hi) continue;
    if (bestV === lo) out.push(`The best ${row.key} (${fmt(bestV)}) is the smallest value tried: try lower values too.`);
    else if (bestV === hi) out.push(`The best ${row.key} (${fmt(bestV)}) is the largest value tried: try higher values too.`);
  }
  if (stillImproving(best, metric)) out.push(`${best.name}'s ${metric} was still improving when it stopped: train it longer (more epochs or steps).`);
  const train = Object.keys(best.summary.metrics).find((k) => /^train[/_.]?loss$/i.test(k));
  const val = Object.keys(best.summary.metrics).find((k) => /^(val|valid|validation|eval)[/_.]?loss$/i.test(k));
  if (train && val) {
    const t = finalValue(best.summary.metrics[train]!);
    const v = finalValue(best.summary.metrics[val]!);
    if (t !== null && v !== null && t > 0 && v > t * 1.5) out.push(`${best.name} fits the training data much better than the validation data (loss ${fmt(t)} vs ${fmt(v)}): it is overfitting. Try more dropout or weight decay, augmentation, or a smaller model.`);
  }
  const f = best.summary.failures;
  if (f && f.wrong !== null && f.wrong > 0 && f.labels.length) {
    const names = f.classNames;
    const pairs = new Map<string, number>();
    f.labels.forEach((l, i) => {
      const k = `${labelText(l, names)} → ${predText(f.predictions[i], names).replace(/ \(\d+%\)$/, "")}`;
      pairs.set(k, (pairs.get(k) ?? 0) + 1);
    });
    const top = [...pairs.entries()].sort((a, b) => b[1] - a[1])[0];
    if (top && top[1] >= 2) out.push(`Most of the worst mistakes are ${top[0]}: look at those examples, and consider more data or class weights for them.`);
  }
  if (why?.verdict === "within-noise" && done.length > 1) out.push(`${done[0]!.run.name} and ${done[1]!.run.name} differ by less than the run-to-run noise: repeat both with another seed before choosing.`);
  const nan = ranked.filter((r) => r.run.summary.diagnostics.some((d) => d.kind === "nan"));
  if (nan.length) out.push(`${nan.map((r) => r.run.name).join(", ")} hit NaN: lower the learning rate or add gradient clipping for those settings.`);
  if (!out.length) out.push(`Run ${best.name} again with a different seed to confirm the result, then try a larger model or more data.`);
  return out;
}

export interface ReportInput {
  project: string;
  runs: ReportRun[];
  /** Rank by this metric; chosen automatically when omitted. */
  metric?: string | null;
  /** Why the best run beat the runner-up (explainRuns(runnerUp, best)). */
  why?: RunExplanation | null;
  generatedAt?: Date;
}

/** The report as Markdown. */
export function buildReport(input: ReportInput): string {
  const runs = input.runs;
  const metric = input.metric ?? reportMetric(runs);
  const ranked = rankRuns(runs, metric);
  const lower = metric ? lowerBetter(metric) : true;
  const when = (input.generatedAt ?? new Date()).toISOString().replace("T", " ").slice(0, 16);
  const count = (s: string) => runs.filter((r) => r.status === s).length;
  const L: string[] = [];
  L.push(`# Experiment report: ${input.project}`, "");
  L.push(`${when} UTC · ${runs.length} run${runs.length === 1 ? "" : "s"} (${count("completed")} completed, ${count("failed")} failed${count("running") ? `, ${count("running")} still running` : ""})`, "");
  if (!runs.length) return L.concat("No runs to report yet.", "").join("\n");

  L.push(`## Ranking`, "");
  L.push(metric ? `By **${metric}** (${lower ? "lower" : "higher"} is better; where each run finished).` : "No metric is shared by these runs, so they aren't ranked.", "");
  const varied = diffConfigs(ranked.map((r) => r.run.config)).filter((row) => row.differs && !BOOKKEEPING.test(row.key)).slice(0, 6);
  L.push(`| # | Run | ${metric ? cell(metric) + " | " : ""}Status | ${varied.map((v) => cell(v.key) + " | ").join("")}Time | Cost | Machine |`);
  L.push(`|---|---|${metric ? "---|" : ""}---|${varied.map(() => "---|").join("")}---|---|---|`);
  ranked.forEach((r, i) => {
    const vals = varied.map((v) => cell(fmt(v.values[i])) + " | ").join("");
    L.push(`| ${i + 1} | ${r.run.name} | ${metric ? (r.value === null ? "—" : fmt(r.value)) + " | " : ""}${r.run.status} | ${vals}${dur(r.run.durationSec)} | ${r.run.costUsd ? "$" + r.run.costUsd.toFixed(2) : "—"} | ${cell(r.run.machine)}${r.run.gpu ? ` (${cell(r.run.gpu)})` : ""} |`);
  });
  L.push("");

  const best = ranked[0]!.value !== null ? ranked[0]!.run : null;
  if (best) {
    L.push(`## Best run: ${best.name}`, "");
    L.push("```", best.command, "```", "");
    const settings = Object.entries(best.config).filter(([k, v]) => !BOOKKEEPING.test(k) && (typeof v !== "object" || v === null));
    if (settings.length) L.push(`Settings: ${settings.slice(0, 16).map(([k, v]) => `${k}=${fmt(v)}`).join(", ")}`, "");
    if (best.gitCommit) L.push(`Code: commit ${best.gitCommit.slice(0, 10)}${best.dirty ? " with uncommitted changes (saved with the run)" : ""}`, "");
    const inputs = best.summary.inputs;
    if (inputs.length) L.push(`Inputs: ${inputs.map((i) => `${i.kind} ${i.name}${i.fingerprint ? ` (fingerprint ${i.fingerprint.slice(0, 12)})` : ""}${i.revision ? ` @ ${i.revision}` : ""}`).join("; ")}`, "");
    const why = input.why;
    if (why && why.causes.length && ranked[1]) {
      L.push(`Compared with the runner-up, ${ranked[1].run.name}, the likeliest reasons it did better:`, "");
      for (const c of why.causes.slice(0, 4)) L.push(`- **${c.subject}** (${c.category}): ${c.from} → ${c.to}. ${c.reason}`);
      if (why.verdict === "within-noise") L.push("", "The gap between them is within the run-to-run noise.");
      L.push("");
    }
  }

  const evals = ranked.filter((r) => r.run.summary.failures);
  if (evals.length) {
    L.push(`## Evaluation after training`, "");
    for (const { run } of evals.slice(0, 5)) {
      const f = run.summary.failures!;
      const scores = Object.keys(run.summary.metrics)
        .filter((k) => k.startsWith(`${f.split}/`))
        .map((k) => `${k} ${fmt(run.summary.metrics[k]!.at(-1)?.value ?? null)}`);
      L.push(`**${run.name}** on the ${f.split} split (${f.total.toLocaleString("en-US")} examples${f.wrong !== null ? `, ${f.wrong.toLocaleString("en-US")} wrong` : ""})${scores.length ? ": " + scores.join(", ") : ""}`, "");
      if (f.labels.length) {
        L.push(`| Example | Truth | Predicted | Loss |`, `|---|---|---|---|`);
        f.inputs.forEach((_, i) => L.push(`| ${i + 1} | ${cell(labelText(f.labels[i], f.classNames))} | ${cell(predText(f.predictions[i], f.classNames))} | ${fmt(f.losses[i])} |`));
        L.push("");
      }
    }
  }

  const problems = ranked.filter((r) => r.run.summary.diagnostics.length || r.run.status === "failed");
  if (problems.length) {
    L.push(`## Problems`, "");
    for (const { run } of problems) {
      const ds = run.summary.diagnostics.filter((d) => d.severity !== "info");
      if (!ds.length && run.status === "failed") L.push(`- **${run.name}** failed${run.summary.reason ? `: ${run.summary.reason}` : run.summary.exitCode !== null ? ` (exit code ${run.summary.exitCode})` : ""}`);
      for (const d of ds.slice(0, 3)) L.push(`- **${run.name}** ${d.kind}${d.step !== null && d.step !== undefined ? ` at step ${d.step}` : ""}: ${d.message}`);
    }
    L.push("");
  }

  L.push(`## Next experiments`, "");
  for (const s of nextSteps(ranked, metric, input.why ?? null)) L.push(`- ${s}`);
  L.push("");
  return L.join("\n");
}
