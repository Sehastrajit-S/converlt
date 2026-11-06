import { test } from "node:test";
import assert from "node:assert/strict";
import { buildReport, createSummary, rankRuns, reportMetric, type ReportRun } from "./index.ts";

function run(name: string, lr: number, valAcc: number[], o: Partial<ReportRun> = {}): ReportRun {
  const summary = createSummary();
  summary.metrics["val/accuracy"] = valAcc.map((value, i) => ({ step: (i + 1) * 10, value, ts: i }));
  summary.metrics["train/loss"] = valAcc.map((v, i) => ({ step: (i + 1) * 10, value: 1 - v, ts: i }));
  summary.metrics["val/loss"] = valAcc.map((v, i) => ({ step: (i + 1) * 10, value: 1 - v, ts: i }));
  return { name, status: "completed", command: `python train.py --lr ${lr}`, config: { lr, epochs: 10, parameters: 1234 }, summary, durationSec: 120, costUsd: null, machine: "home", gpu: "RTX 3060", group: "", gitCommit: "abcdef1234567", dirty: false, ...o };
}

test("ranks by validation accuracy (higher is better), failed and metric-less runs last", () => {
  const runs = [run("run-001", 0.1, [0.5, 0.6, 0.62]), run("run-002", 0.01, [0.7, 0.8, 0.9]), run("run-003", 0.001, [0.6, 0.7, 0.75]), { ...run("run-004", 1, []), status: "failed" }];
  assert.equal(reportMetric(runs), "val/accuracy");
  assert.deepEqual(rankRuns(runs, "val/accuracy").map((r) => r.run.name), ["run-002", "run-003", "run-001", "run-004"]);
});

test("the report: ranking with the settings that varied, the best run, evaluation, problems and next steps", () => {
  const best = run("run-003", 0.001, [0.7, 0.8, 0.9, 0.91, 0.92, 0.93, 0.95, 0.96, 0.97, 0.98, 0.99, 0.995]);
  best.summary.failures = {
    seq: 1, ts: 1, type: "failures", split: "test",
    inputs: [{ kind: "vector", values: [1], length: 1 }, { kind: "vector", values: [2], length: 1 }],
    labels: [{ class: 1, name: "dog" }, { class: 1, name: "dog" }],
    predictions: [{ class: 0, p: 0.9 }, { class: 0, p: 0.7 }],
    losses: [2.3, 1.2], shape: [1], classNames: ["cat", "dog"], total: 200, wrong: 9,
  };
  best.summary.metrics["test/accuracy"] = [{ step: 120, value: 0.955, ts: 1 }];
  const bad = { ...run("run-004", 1, [0.1]), status: "failed" };
  bad.summary.diagnostics.push({ seq: 1, ts: 1, type: "diagnostic", kind: "nan", severity: "error", message: "Loss became NaN.", step: 40 });
  const md = buildReport({ project: "pets", runs: [run("run-001", 0.1, [0.5, 0.6]), run("run-002", 0.01, [0.6, 0.7]), best, bad], generatedAt: new Date("2026-11-05T10:00:00Z") });
  assert.match(md, /^# Experiment report: pets/);
  assert.match(md, /By \*\*val\/accuracy\*\* \(higher is better/);
  assert.match(md, /\| # \| Run \| val\/accuracy \| Status \| lr \| Time/, "the setting that varied is a column; bookkeeping (parameters) isn't");
  assert.match(md, /\| 1 \| run-003 \|/);
  assert.match(md, /## Best run: run-003/);
  assert.match(md, /Code: commit abcdef1234/);
  assert.match(md, /\*\*run-003\*\* on the test split \(200 examples, 9 wrong\): test\/accuracy 0\.955/);
  assert.match(md, /\| 1 \| dog \| cat \(90%\) \| 2\.3 \|/);
  assert.match(md, /\*\*run-004\*\* nan at step 40: Loss became NaN\./);
  assert.match(md, /The best lr \(0\.001\) is the smallest value tried: try lower values too\./);
  assert.match(md, /still improving when it stopped/);
  assert.match(md, /Most of the worst mistakes are dog → cat/);
  assert.match(md, /run-004 hit NaN/);
});
