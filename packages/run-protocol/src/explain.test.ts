import { test } from "node:test";
import assert from "node:assert/strict";
import { createSummary, divergenceStep, explainRuns, filesInPatch, patchByFile, targetMetric, type ExplainInput, type MetricPoint, type RunManifest } from "./index.ts";

/** Deterministic pseudo-noise, so tests don't flake. */
function rng(seed: number) {
  let s = seed;
  return () => ((s = (s * 1103515245 + 12345) % 2 ** 31) / 2 ** 31 - 0.5) * 2;
}

/** A loss curve: exponential decay to `floor`, plus noise; after `breakAt`, `after` takes over. */
function curve(n: number, opts: { floor?: number; noise?: number; seed?: number; breakAt?: number; after?: (step: number, v: number) => number; every?: number } = {}): MetricPoint[] {
  const r = rng(opts.seed ?? 1);
  const every = opts.every ?? 10;
  const out: MetricPoint[] = [];
  for (let step = 0; step <= n; step += every) {
    let v = (opts.floor ?? 0.5) + 2 * Math.exp(-step / 300);
    if (opts.breakAt !== undefined && step >= opts.breakAt && opts.after) v = opts.after(step, v);
    out.push({ step, value: v + r() * (opts.noise ?? 0.01), ts: step });
  }
  return out;
}

function run(config: Record<string, unknown>, metrics: Record<string, MetricPoint[]>, env: Partial<NonNullable<ExplainInput["summary"]["env"]>> | null = {}): ExplainInput {
  const summary = createSummary();
  summary.metrics = metrics;
  summary.env = env === null ? null : { torch: "2.5.1", torchCuda: "12.4", driver: "550.54", python: "3.11.9", gpus: [{ index: 0, name: "RTX 4090", memTotalMiB: 24564 }], packages: ["numpy==2.1.0", "transformers==4.46.0"], ...env };
  return { manifest: { hyperparameters: {} } as unknown as RunManifest, summary, effectiveConfig: config };
}

const NO_CODE = { committedFiles: [], uncommittedFiles: [], unknown: false };

test("a learning-rate change that makes the run worse ranks first, and the split step is found", () => {
  const a = run({ lr: 3e-4, batch_size: 64, log_every: 10 }, { "train/loss": curve(3000) });
  const b = run({ lr: 3e-3, batch_size: 64, log_every: 50 }, { "train/loss": curve(3000, { breakAt: 600, after: (s, v) => v + (s - 600) / 4000 }) });
  const x = explainRuns(a, b, NO_CODE);
  assert.equal(x.metric, "train/loss");
  assert.equal(x.verdict, "worse");
  assert.ok(x.gapPct! > 5, `gap ${x.gapPct}`);
  assert.ok(x.divergedAtStep! >= 600 && x.divergedAtStep! <= 900, `split at ${x.divergedAtStep}`);
  assert.equal(x.causes[0]!.subject, "lr");
  assert.equal(x.causes[0]!.likelihood, "high");
  assert.match(x.causes[0]!.reason, /10×|10\.0×|more than 10/);
  const log = x.causes.find((c) => c.subject === "log_every")!;
  assert.equal(log.likelihood, "low");
  assert.ok(x.unchanged.includes("Code") && x.unchanged.includes("Environment") && x.unchanged.includes("Hardware"));
});

test("a run that reaches the same best value and then destabilises is still worse", () => {
  const a = run({ lr: 0.02 }, { loss: curve(3000) });
  const b = run({ lr: 0.08 }, { loss: curve(3000, { breakAt: 1500, after: (s, v) => v + (s - 1500) / 1500 }) });
  const x = explainRuns(a, b, NO_CODE);
  assert.equal(x.verdict, "worse");
  assert.ok(x.divergedAtStep! >= 1500, `split at ${x.divergedAtStep}`);
  assert.equal(x.causes[0]!.subject, "lr");
});

test("a gap within the run's own noise is called noise, and a seed change ranks low", () => {
  const a = run({ lr: 1e-3, seed: 1 }, { loss: curve(2000, { noise: 0.05, seed: 1 }) });
  const b = run({ lr: 1e-3, seed: 2 }, { loss: curve(2000, { noise: 0.05, seed: 2 }) });
  const x = explainRuns(a, b, NO_CODE);
  assert.equal(x.verdict, "within-noise");
  assert.equal(x.divergedAtStep, null);
  assert.equal(x.causes[0]!.subject, "seed");
  assert.equal(x.causes[0]!.likelihood, "low");
  assert.ok(x.notes.some((n) => /within the run's own noise/.test(n)));
});

test("a warmup change that lines up with the split gets the extra hint", () => {
  const a = run({ warmup_steps: 100, lr: 1e-3 }, { loss: curve(3000) });
  const b = run({ warmup_steps: 1000, lr: 1e-3 }, { loss: curve(3000, { breakAt: 1000, after: (s, v) => v + 0.3 }) });
  const x = explainRuns(a, b, NO_CODE);
  assert.equal(x.verdict, "worse");
  const w = x.causes.find((c) => c.subject === "warmup_steps")!;
  assert.equal(x.causes[0], w);
  assert.match(w.reason, /split at step/);
});

test("prefers validation loss when both runs log it, and judges accuracy as higher-is-better", () => {
  const a = createSummary();
  const b = createSummary();
  a.metrics = { "train/loss": curve(100), "val/loss": curve(100) };
  b.metrics = { "train/loss": curve(100), "val/loss": curve(100) };
  assert.equal(targetMetric(a, b), "val/loss");
  const up = (n: number, top: number) => Array.from({ length: n }, (_, i) => ({ step: i * 10, value: top * (1 - Math.exp(-i / 10)), ts: i }));
  const x = explainRuns(run({ lr: 1 }, { accuracy: up(60, 0.9) }), run({ lr: 2 }, { accuracy: up(60, 0.7) }), NO_CODE);
  assert.equal(x.lowerIsBetter, false);
  assert.equal(x.verdict, "worse");
});

test("ranks code, environment and hardware changes, and notes what couldn't be checked", () => {
  const a = run({ lr: 1e-3 }, { loss: curve(2000) }, { torch: "2.4.1", gpus: [{ index: 0, name: "A100", memTotalMiB: 81920 }] });
  const b = run({ lr: 1e-3 }, { loss: curve(2000, { breakAt: 0, after: (_s, v) => v * 1.2 }) }, { gpus: [{ index: 0, name: "A100", memTotalMiB: 81920 }, { index: 1, name: "A100", memTotalMiB: 81920 }], packages: ["numpy==2.1.0", "transformers==4.47.0"] });
  const x = explainRuns(a, b, { committedFiles: ["src/model.py", "README.md"], uncommittedFiles: ["scripts/plot.py"], unknown: false });
  const by = (s: string) => x.causes.find((c) => c.subject === s)!;
  assert.equal(by("src/model.py").likelihood, "high");
  assert.equal(by("README.md").likelihood, "low");
  assert.equal(by("scripts/plot.py").to, "uncommitted change");
  assert.equal(by("torch").likelihood, "medium");
  assert.equal(by("GPU count").likelihood, "medium");
  assert.ok(by("transformers"));
  assert.ok(!x.unchanged.includes("Code"));
  assert.ok(x.unchanged.includes("Config and hyperparameters"));
  assert.ok(x.notes.some((n) => /no dataset fingerprint/.test(n)));
  assert.ok(explainRuns(a, b, { committedFiles: [], uncommittedFiles: [], unknown: true }).notes.some((n) => /Couldn't compare the code/.test(n)));
});

test("a run that stopped early says so", () => {
  const a = run({ lr: 1e-3 }, { loss: curve(3000) });
  const b = run({ lr: 1e-3 }, { loss: curve(300) });
  const x = explainRuns(a, b, NO_CODE);
  assert.equal(x.verdict, "worse");
  assert.equal(x.causes[0]!.subject, "Run length");
});

test("with no shared metric there is no verdict", () => {
  const x = explainRuns(run({}, { loss: curve(100) }), run({}, { acc: curve(100) }), NO_CODE);
  assert.equal(x.metric, null);
  assert.equal(x.verdict, "unknown");
});

test("divergence needs a sustained gap, not one spike", () => {
  const a = curve(2000);
  const b = curve(2000).map((p) => (p.step === 1000 ? { ...p, value: p.value! + 5 } : p));
  assert.equal(divergenceStep(a, b, true), null);
});

test("patch helpers list and split files", () => {
  const patch = "diff --git a/train.py b/train.py\nindex 1..2 100644\n--- a/train.py\n+++ b/train.py\n@@ -1 +1 @@\n-lr=1\n+lr=2\ndiff --git a/new.py b/new.py\n--- /dev/null\n+++ b/new.py\n@@ -0,0 +1 @@\n+x\n";
  assert.deepEqual(filesInPatch(patch).sort(), ["new.py", "train.py"]);
  const byFile = patchByFile(patch);
  assert.deepEqual([...byFile.keys()].sort(), ["new.py", "train.py"]);
  assert.match(byFile.get("train.py")!, /\+lr=2/);
});

test("a changed dataset fingerprint is a top cause; matching fingerprints count as unchanged data", () => {
  const ds = (fingerprint: string, files = 100) => ({ seq: 1, ts: 0, type: "input" as const, kind: "dataset" as const, name: "data/train", fingerprint, files, source: "sdk" as const });
  const a = run({ lr: 3e-4 }, { "train/loss": curve(3000) });
  const b = run({ lr: 3e-4 }, { "train/loss": curve(3000, { breakAt: 300, after: (_s, v) => v + 0.3 }) });
  a.summary.inputs = [ds("aaaaaaaaaaaaaaaa", 100)];
  b.summary.inputs = [ds("bbbbbbbbbbbbbbbb", 140)];
  const x = explainRuns(a, b, NO_CODE);
  assert.equal(x.causes[0]!.category, "data");
  assert.equal(x.causes[0]!.subject, "Dataset data/train");
  assert.match(x.causes[0]!.reason, /100 → 140 files/);
  assert.ok(!x.notes.some((n) => /no dataset fingerprint/.test(n)));

  b.summary.inputs = [ds("aaaaaaaaaaaaaaaa", 100)];
  const y = explainRuns(a, b, NO_CODE);
  assert.ok(!y.causes.some((c) => c.category === "data"));
  assert.ok(y.unchanged.includes("Data"));
});

test("runs that used different base models say so", () => {
  const w = (name: string) => ({ seq: 1, ts: 0, type: "input" as const, kind: "weights" as const, name, revision: "abc", source: "auto" as const });
  const a = run({}, { "train/loss": curve(3000) });
  const b = run({}, { "train/loss": curve(3000, { breakAt: 300, after: (_s, v) => v + 0.3 }) });
  a.summary.inputs = [w("gpt2")];
  b.summary.inputs = [w("distilgpt2")];
  const x = explainRuns(a, b, NO_CODE);
  const c = x.causes.find((c) => c.category === "data")!;
  assert.equal(c.subject, "Pretrained weights");
  assert.equal(c.from, "gpt2");
  assert.equal(c.to, "distilgpt2");
  assert.match(x.notes.join(" "), /no dataset fingerprint/);
});
