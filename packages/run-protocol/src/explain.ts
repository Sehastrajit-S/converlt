// "Why is run B different from run A?" Compares two runs and ranks every difference between them
// (config, code, environment, hardware) by how likely it is to explain the gap in the target
// metric. Rules choose and rank the candidates; an LLM may later word the explanation, but never
// invents causes that aren't listed here.
import { flattenConfig } from "./compare.ts";
import { primaryMetricKey, type MetricPoint, type RunSummary } from "./summary.ts";
import type { RunManifest } from "./types.ts";

export interface ExplainInput {
  manifest: RunManifest;
  summary: RunSummary;
  effectiveConfig: Record<string, unknown>;
}

/** Code that differs between the two runs, collected from git by the caller. */
export interface CodeChanges {
  /** Files changed between the two commits (`git diff --name-only A B`). */
  committedFiles: string[];
  /** Files whose uncommitted changes differ between the runs (from each run's code.patch). */
  uncommittedFiles: string[];
  /** Commits are unknown (not a git repo, or a commit is missing locally). */
  unknown: boolean;
}

export type CauseCategory = "config" | "code" | "data" | "environment" | "hardware" | "length";
export type Likelihood = "high" | "medium" | "low";

export interface Cause {
  category: CauseCategory;
  /** What changed, e.g. "lr" or "src/model.py". */
  subject: string;
  from: string;
  to: string;
  likelihood: Likelihood;
  /** 0–1; causes are sorted by it. */
  score: number;
  /** Why this ranks where it does, in one sentence. */
  reason: string;
}

export type Verdict = "worse" | "better" | "within-noise" | "unknown";

export interface RunExplanation {
  metric: string | null;
  lowerIsBetter: boolean;
  /** Where each run finished on the metric: the median of its last 10% of points. */
  a: number | null;
  b: number | null;
  /** (b − a) relative to a, positive when B is worse. */
  gapPct: number | null;
  /** Typical step-to-step noise of run A's metric, relative to its best value. */
  noisePct: number | null;
  verdict: Verdict;
  /** First step where B moved outside A's noise band and stayed there. */
  divergedAtStep: number | null;
  causes: Cause[];
  /** Things checked and found identical, e.g. "Code", "Environment". */
  unchanged: string[];
  /** Caveats worth showing, e.g. a missing data fingerprint. */
  notes: string[];
}

// ------------------------------------------------------------ metric and outcome

const lowerBetter = (key: string) => /loss|err|perplex|ppl|mse|mae|rmse|cer|wer/i.test(key);

/** The metric to judge runs by: validation loss if both runs have it, else the primary metric. */
export function targetMetric(a: RunSummary, b: RunSummary): string | null {
  const shared = Object.keys(a.metrics).filter((k) => k in b.metrics && a.metrics[k]!.some((p) => p.value !== null));
  if (!shared.length) return null;
  const val = shared.find((k) => /^(val|valid|validation|eval|test)[/_.-]?loss$/i.test(k)) ?? shared.find((k) => /^(val|valid|eval)/i.test(k) && /loss/i.test(k));
  return val ?? primaryMetricKey(shared);
}

const finite = (s: MetricPoint[]) => s.filter((p): p is MetricPoint & { value: number } => p.value !== null && Number.isFinite(p.value)).sort((x, y) => x.step - y.step);

/** Where a run ended up: the median of its last 10% of points (at least 5), robust to the odd spike. */
function final(s: MetricPoint[]): number | null {
  const f = finite(s);
  if (!f.length) return null;
  const tail = f.slice(-Math.max(5, Math.ceil(f.length * 0.1))).map((p) => p.value).sort((x, y) => x - y);
  return tail[Math.floor(tail.length / 2)]!;
}

function best(s: MetricPoint[], lower: boolean): number | null {
  const f = finite(s);
  if (!f.length) return null;
  return f.reduce((m, p) => (lower ? Math.min(m, p.value) : Math.max(m, p.value)), f[0]!.value);
}

/** Exponential moving average, the same smoothing the charts use. */
function ema(points: { step: number; value: number }[], alpha = 0.6): { step: number; value: number }[] {
  let acc: number | null = null;
  return points.map((p) => {
    acc = acc === null ? p.value : alpha * acc + (1 - alpha) * p.value;
    return { step: p.step, value: acc };
  });
}

/** Rolling median over `w` points: follows the trend but ignores one-off spikes, unlike an EMA. */
function rollingMedian(points: { step: number; value: number }[], w = 7): { step: number; value: number }[] {
  const h = Math.floor(w / 2);
  return points.map((p, i) => {
    const win = points.slice(Math.max(0, i - h), i + h + 1).map((q) => q.value).sort((x, y) => x - y);
    return { step: p.step, value: win[Math.floor(win.length / 2)]! };
  });
}

/** Median absolute deviation of a series from its own smoothed curve: its step-to-step noise. */
function noise(points: { step: number; value: number }[]): number {
  if (points.length < 4) return 0;
  const sm = ema(points);
  const dev = points.map((p, i) => Math.abs(p.value - sm[i]!.value)).sort((x, y) => x - y);
  return dev[Math.floor(dev.length / 2)]! * 1.4826;
}

function interpolate(points: { step: number; value: number }[], step: number): number | null {
  if (!points.length || step < points[0]!.step || step > points[points.length - 1]!.step) return null;
  let lo = 0;
  let hi = points.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (points[mid]!.step <= step) lo = mid;
    else hi = mid;
  }
  const p = points[lo]!;
  const q = points[hi]!;
  if (q.step === p.step) return p.value;
  return p.value + ((q.value - p.value) * (step - p.step)) / (q.step - p.step);
}

/**
 * The first step where B's rolling median is worse than A's by more than `k` times A's noise (and
 * by at least 1%), and stays that way for the next few aligned points.
 */
export function divergenceStep(a: MetricPoint[], b: MetricPoint[], lower: boolean, k = 3): number | null {
  const fa = finite(a);
  const fb = finite(b);
  if (fa.length < 4 || fb.length < 4) return null;
  const sa = rollingMedian(fa);
  const sb = rollingMedian(fb);
  const band = Math.max(k * noise(fa), 0.01 * Math.abs(best(a, lower) ?? 0));
  const sign = lower ? 1 : -1;
  const steps = sa.map((p) => p.step).filter((s) => s >= sb[0]!.step && s <= sb[sb.length - 1]!.step);
  const PERSIST = Math.min(3, Math.max(1, Math.floor(steps.length / 10)));
  let run = 0;
  for (let i = 0; i < steps.length; i++) {
    const va = interpolate(sa, steps[i]!);
    const vb = interpolate(sb, steps[i]!);
    if (va === null || vb === null) continue;
    if (sign * (vb - va) > band) {
      run++;
      if (run >= PERSIST) return steps[i - PERSIST + 1]!;
    } else run = 0;
  }
  return null;
}

// ------------------------------------------------------------ candidate ranking

interface Rule {
  re: RegExp;
  score: number;
  why: string;
}

/** Config keys by how often they change training outcomes. First match wins. */
const CONFIG_RULES: Rule[] = [
  { re: /(^|[._-])(log|print|save|ckpt|checkpoint|eval)[._-]?(every|interval|freq|steps?)$|(^|[._-])(output|out|save|log|run)[._-]?(dir|path|name)$|wandb|project|^name$|tag|verbose|num[._-]?workers|resume/i, score: 0.05, why: "Only affects logging, saving or bookkeeping, not the training itself." },
  { re: /seed/i, score: 0.25, why: "A different seed changes initialisation and data order; gaps this small are often just seed noise." },
  { re: /warmup|schedul|decay[._-]?(steps|rate|type)|cosine|step[._-]?size|gamma|min[._-]?lr|lr[._-]?(min|end)/i, score: 0.75, why: "Learning-rate schedule changes shift when and how fast the model learns." },
  { re: /(^|[._-])(lr|learning[._-]?rate|eta)([._-]|$)|^lr/i, score: 0.9, why: "The learning rate is the most common cause of a run training worse or diverging." },
  { re: /batch|bs$|^bs|grad(ient)?[._-]?accum|accumulat|micro[._-]?batch/i, score: 0.8, why: "Batch size changes the effective learning rate and gradient noise." },
  { re: /optim|weight[._-]?decay|^wd$|momentum|beta|eps(ilon)?$|clip|grad[._-]?norm|nesterov|adam|sgd/i, score: 0.7, why: "Optimizer settings change how each update is applied." },
  { re: /label[._-]?smooth|loss|criterion|temperature|margin|alpha|lambda|coef|weight$/i, score: 0.7, why: "Changes what the model is optimising." },
  { re: /model|arch|layer|depth|width|hidden|dim|d_model|heads|embed|block|channels|dropout|drop[._-]?path|norm|activation|init/i, score: 0.65, why: "Model architecture or regularisation changes capacity and how it trains." },
  { re: /data|dataset|split|augment|aug|transform|crop|resize|mix(up|cut)|shuffle|max[._-]?(len|length|seq)|seq[._-]?len|context|tokeniz|vocab|sample/i, score: 0.65, why: "Changes the data the model sees." },
  { re: /precision|amp|fp16|bf16|half|dtype|tf32|compile|fused|flash/i, score: 0.5, why: "Numeric precision and kernels can change results, especially fp16 overflow." },
  { re: /epoch|max[._-]?steps|total[._-]?steps|num[._-]?steps|iters|iterations|train[._-]?steps/i, score: 0.35, why: "Training length mostly changes how far the run got, not how well it learns per step." },
];

const CODE_HOT = /loss|model|net|optim|train|trainer|data|dataset|loader|augment|transform|sched|config|layers?|attention|head|module/i;
const NOT_CODE = /\.(md|rst|txt|png|jpe?g|gif|svg|lock|gitignore|ipynb_checkpoints)$|(^|\/)(readme|license|changelog|docs?)\b/i;

const str = (v: unknown) => (v === undefined ? "(unset)" : typeof v === "string" ? v : JSON.stringify(v));
const likelihood = (s: number): Likelihood => (s >= 0.65 ? "high" : s >= 0.35 ? "medium" : "low");

function configCauses(a: Record<string, unknown>, b: Record<string, unknown>, divergedAt: number | null, lengthA: number | null): Cause[] {
  const fa = flattenConfig(a);
  const fb = flattenConfig(b);
  const out: Cause[] = [];
  for (const key of new Set([...Object.keys(fa), ...Object.keys(fb)])) {
    const va = fa[key];
    const vb = fb[key];
    if (JSON.stringify(va) === JSON.stringify(vb)) continue;
    const rule = CONFIG_RULES.find((r) => r.re.test(key));
    let score = rule?.score ?? 0.4;
    let why = rule?.why ?? "A changed setting with no known role; check what it controls.";
    if (typeof va === "number" && typeof vb === "number" && va !== 0 && vb !== 0 && score >= 0.5) {
      const ratio = Math.max(va / vb, vb / va);
      if (ratio >= 3) {
        score = Math.min(1, score + 0.05);
        why += ` It changed ${ratio >= 10 ? "by more than 10×" : `${ratio.toFixed(1)}×`}.`;
      } else if (ratio < 1.15) score -= 0.15;
    }
    // A schedule change that lines up with where the runs split is a strong hint.
    if (divergedAt !== null && typeof vb === "number" && /warmup|decay[._-]?steps|step[._-]?size|milestone/i.test(key)) {
      const near = [va, vb].some((v) => typeof v === "number" && v > 0 && Math.abs(divergedAt - v) <= Math.max(v * 0.15, (lengthA ?? 0) * 0.03));
      if (near) {
        score = Math.min(1, score + 0.15);
        why += ` The runs split at step ${divergedAt}, right where this takes effect.`;
      }
    }
    out.push({ category: "config", subject: key, from: str(va), to: str(vb), score, likelihood: likelihood(score), reason: why });
  }
  return out;
}

function codeCauses(code: CodeChanges | null): Cause[] {
  if (!code || code.unknown) return [];
  const files = [...new Set([...code.committedFiles, ...code.uncommittedFiles])];
  return files
    .map((f): Cause => {
      const uncommitted = code.uncommittedFiles.includes(f) && !code.committedFiles.includes(f);
      const score = NOT_CODE.test(f) ? 0.05 : CODE_HOT.test(f) ? 0.7 : /\.(py|pyx|cu|cpp|c|h|yaml|yml|json|toml|cfg)$/i.test(f) ? 0.45 : 0.15;
      const why =
        score >= 0.7
          ? "Training code (model, loss, data or optimiser) changed here."
          : score >= 0.45
            ? "Code or config the run imports changed here."
            : "Unlikely to affect training (docs or assets).";
      return { category: "code", subject: f, from: "", to: uncommitted ? "uncommitted change" : "changed", score, likelihood: likelihood(score), reason: why };
    })
    .sort((x, y) => y.score - x.score)
    .slice(0, 25);
}

function pkgVersions(pkgs: string[] | undefined): Map<string, string> {
  const m = new Map<string, string>();
  for (const p of pkgs ?? []) {
    const i = p.indexOf("==");
    if (i > 0) m.set(p.slice(0, i).toLowerCase(), p.slice(i + 2));
  }
  return m;
}

const minor = (v: string | null | undefined) => (v ?? "").split(/[.+]/).slice(0, 2).join(".");
const ML_PKGS = /^(torch|torchvision|torchaudio|transformers|accelerate|deepspeed|flash[-_]attn|xformers|timm|numpy|triton|apex|peft|datasets|tokenizers|lightning|pytorch[-_]lightning|jax|jaxlib)$/;

function envCauses(a: RunSummary["env"], b: RunSummary["env"]): Cause[] {
  if (!a || !b) return [];
  const out: Cause[] = [];
  const add = (subject: string, from: unknown, to: unknown, score: number, reason: string) =>
    out.push({ category: "environment", subject, from: str(from), to: str(to), score, likelihood: likelihood(score), reason });
  if (a.torch !== b.torch) add("torch", a.torch, b.torch, minor(a.torch) !== minor(b.torch) ? 0.4 : 0.2, "A PyTorch upgrade can change kernels, defaults and numerics.");
  if (a.torchCuda !== b.torchCuda) add("CUDA (torch build)", a.torchCuda, b.torchCuda, 0.3, "A different CUDA build can change kernels and numerics.");
  if (a.driver !== b.driver) add("GPU driver", a.driver, b.driver, 0.1, "Driver changes rarely change results.");
  if (a.python !== b.python && minor(a.python) !== minor(b.python)) add("Python", a.python, b.python, 0.1, "Python minor-version changes rarely affect training.");
  const pa = pkgVersions(a.packages);
  const pb = pkgVersions(b.packages);
  for (const name of new Set([...pa.keys(), ...pb.keys()])) {
    if (name === "torch") continue;
    const va = pa.get(name);
    const vb = pb.get(name);
    if (va === vb) continue;
    const ml = ML_PKGS.test(name);
    add(name, va, vb, ml ? (minor(va) !== minor(vb) ? 0.35 : 0.15) : 0.05, ml ? "An ML library the training likely uses changed version." : "A package changed version.");
  }
  return out.sort((x, y) => y.score - x.score).slice(0, 12);
}

function hardwareCauses(a: ExplainInput, b: ExplainInput): Cause[] {
  const out: Cause[] = [];
  const ga = a.summary.env?.gpus ?? [];
  const gb = b.summary.env?.gpus ?? [];
  if (ga.length && gb.length && ga.length !== gb.length)
    out.push({ category: "hardware", subject: "GPU count", from: String(ga.length), to: String(gb.length), score: 0.6, likelihood: "medium", reason: "With data parallelism, more GPUs means a larger effective batch size unless the learning rate was scaled to match." });
  const na = ga[0]?.name;
  const nb = gb[0]?.name;
  if (na && nb && na !== nb)
    out.push({ category: "hardware", subject: "GPU", from: na, to: nb, score: 0.2, likelihood: "low", reason: "Different GPUs give slightly different numerics (e.g. TF32 or bf16 support), rarely a large gap." });
  return out;
}

const short = (s: string | null | undefined) => (s ? (s.length > 12 ? s.slice(0, 12) : s) : "");

/** Datasets and pretrained weights whose fingerprint or revision differs, or that only one run used. */
function inputCauses(a: RunSummary["inputs"], b: RunSummary["inputs"]): Cause[] {
  const out: Cause[] = [];
  const key = (i: RunSummary["inputs"][number]) => `${i.kind}:${i.name}`;
  const mb = new Map(b.map((i) => [key(i), i]));
  const ma = new Map(a.map((i) => [key(i), i]));
  const label = (k: "dataset" | "weights") => (k === "dataset" ? "Dataset" : "Pretrained weights");
  for (const [k, ia] of ma) {
    const ib = mb.get(k);
    if (!ib) continue;
    const va = ia.fingerprint ?? ia.revision;
    const vb = ib.fingerprint ?? ib.revision;
    if (!va || !vb || va === vb) continue;
    const dataset = ia.kind === "dataset";
    out.push({
      category: "data",
      subject: `${label(ia.kind)} ${ia.name}`,
      from: short(va),
      to: short(vb),
      score: dataset ? 0.75 : 0.65,
      likelihood: likelihood(dataset ? 0.75 : 0.65),
      reason: dataset
        ? `The ${ia.name} data itself changed between the runs${ia.files != null && ib.files != null && ia.files !== ib.files ? ` (${ia.files} → ${ib.files} files)` : ""}. Different data often moves results more than any setting.`
        : `The runs started from different versions of ${ia.name}.`,
    });
  }
  // Inputs only one run recorded: swapped datasets or base models show up here.
  const onlyA = [...ma.keys()].filter((k) => !mb.has(k));
  const onlyB = [...mb.keys()].filter((k) => !ma.has(k));
  for (const kind of ["dataset", "weights"] as const) {
    const fa = onlyA.filter((k) => k.startsWith(`${kind}:`)).map((k) => ma.get(k)!.name);
    const fb = onlyB.filter((k) => k.startsWith(`${kind}:`)).map((k) => mb.get(k)!.name);
    if (fa.length && fb.length)
      out.push({ category: "data", subject: label(kind), from: fa.join(", "), to: fb.join(", "), score: 0.8, likelihood: "high", reason: `The runs used different ${kind === "dataset" ? "datasets" : "base models"}.` });
  }
  return out;
}

// ------------------------------------------------------------ the explanation

export function explainRuns(a: ExplainInput, b: ExplainInput, code: CodeChanges | null): RunExplanation {
  const metric = targetMetric(a.summary, b.summary);
  const lower = metric ? lowerBetter(metric) : true;
  const sa = metric ? a.summary.metrics[metric]! : [];
  const sb = metric ? b.summary.metrics[metric]! : [];
  // Judge where each run ended up, not its best moment: a run that peaks and then destabilises is worse.
  const bestA = metric ? final(sa) : null;
  const bestB = metric ? final(sb) : null;
  const noiseA = metric ? noise(finite(sa)) : 0;
  const gapPct = bestA !== null && bestB !== null && bestA !== 0 ? ((lower ? bestB - bestA : bestA - bestB) / Math.abs(bestA)) * 100 : null;
  const noisePct = bestA !== null && bestA !== 0 ? (noiseA / Math.abs(bestA)) * 100 : null;
  let verdict: Verdict = "unknown";
  if (gapPct !== null) verdict = Math.abs(gapPct) <= Math.max(1, 2 * (noisePct ?? 0)) ? "within-noise" : gapPct > 0 ? "worse" : "better";
  const divergedAt = metric && verdict === "worse" ? divergenceStep(sa, sb, lower) : null;
  const lengthA = sa.length ? sa[sa.length - 1]!.step : null;

  const cfgA = { ...a.manifest.hyperparameters, ...a.effectiveConfig };
  const cfgB = { ...b.manifest.hyperparameters, ...b.effectiveConfig };
  const inputsA = a.summary.inputs ?? [];
  const inputsB = b.summary.inputs ?? [];
  const causes = [
    ...configCauses(cfgA, cfgB, divergedAt, lengthA),
    ...codeCauses(code),
    ...inputCauses(inputsA, inputsB),
    ...envCauses(a.summary.env, b.summary.env),
    ...hardwareCauses(a, b),
  ];

  // Diverging in the first few percent of training points at init, data or the base LR rather than the schedule.
  if (divergedAt !== null && lengthA) {
    const early = divergedAt <= lengthA * 0.05;
    for (const c of causes) {
      if (early && c.category === "config" && /init|data|dataset|lr|learning|model|arch/i.test(c.subject)) c.score = Math.min(1, c.score + 0.05);
      if (early && c.category === "config" && /warmup|schedul|decay/i.test(c.subject)) c.score = Math.max(0, c.score - 0.1);
      c.likelihood = likelihood(c.score);
    }
  }
  // B finished early: say so, since a shorter run looks worse for reasons that aren't a regression.
  const endA = sa.length ? sa[sa.length - 1]!.step : null;
  const endB = sb.length ? sb[sb.length - 1]!.step : null;
  if (endA !== null && endB !== null && endB < endA * 0.8 && verdict === "worse")
    causes.push({ category: "length", subject: "Run length", from: `${endA} steps`, to: `${endB} steps`, score: 0.55, likelihood: "medium", reason: `B stopped at step ${endB}, ${Math.round((1 - endB / endA) * 100)}% earlier than A, so it had less time to improve.` });

  causes.sort((x, y) => y.score - x.score || x.subject.localeCompare(y.subject));

  const unchanged: string[] = [];
  const has = (cat: CauseCategory) => causes.some((c) => c.category === cat);
  if (!has("config")) unchanged.push("Config and hyperparameters");
  if (code && !code.unknown && !has("code")) unchanged.push("Code");
  const datasetsA = inputsA.filter((i) => i.kind === "dataset");
  const datasetsB = inputsB.filter((i) => i.kind === "dataset");
  if (datasetsA.length && datasetsB.length && !has("data")) unchanged.push("Data");
  if (a.summary.env && b.summary.env && !has("environment")) unchanged.push("Environment");
  if (!has("hardware") && a.summary.env?.gpus?.length && b.summary.env?.gpus?.length) unchanged.push("Hardware");

  const notes: string[] = [];
  if (!metric) notes.push("The runs share no logged metric, so there's nothing to compare. Log the same metric with converge.log in both.");
  if (code?.unknown) notes.push("Couldn't compare the code: a run has no git commit, or its commit isn't in this repository.");
  if (!a.summary.env || !b.summary.env) notes.push("A run has no environment record, so package and driver changes weren't checked.");
  if (!datasetsA.length || !datasetsB.length)
    notes.push("A run has no dataset fingerprint, so data changes can't be ruled out. Datasets from Hugging Face's load_dataset are recorded automatically; for local data, call run.log_dataset(path).");
  if (verdict === "within-noise") notes.push("The gap is within the run's own noise. Repeat both runs with different seeds before trusting it.");
  if (verdict === "worse" && !causes.some((c) => c.score >= 0.35)) notes.push("Nothing that changed is a likely cause. Suspect data changes or randomness, and repeat the runs with a fixed seed.");

  return { metric, lowerIsBetter: lower, a: bestA, b: bestB, gapPct, noisePct, verdict, divergedAtStep: divergedAt, causes, unchanged, notes };
}

/** The changed file paths in a unified diff (the "+++ b/…" lines). */
export function filesInPatch(patch: string): string[] {
  const out = new Set<string>();
  for (const m of patch.matchAll(/^\+\+\+ b\/(.+)$/gm)) out.add(m[1]!.trim());
  for (const m of patch.matchAll(/^--- a\/(.+)$/gm)) out.add(m[1]!.trim());
  return [...out];
}

/** Per-file hunks of a patch, so two runs' uncommitted changes can be compared file by file. */
export function patchByFile(patch: string): Map<string, string> {
  const out = new Map<string, string>();
  const parts = patch.split(/^(?=diff --git )/m);
  for (const p of parts) {
    const m = /^diff --git a\/(.+?) b\/(.+)$/m.exec(p);
    if (m) out.set(m[2]!.trim(), p.replace(/^index .*$/m, ""));
  }
  return out;
}
