import { test } from "node:test";
import assert from "node:assert/strict";
import { compareGpus, createSummary, forecastCost, forecastRun, gpuSpeed, progressFromLogs, totalStepsFromConfig, type Forecast, type LogLine, type MetricPoint } from "./index.ts";

/** A run that started at t=0 and logs a loss every `every` steps at `rate` steps/s. */
function running(steps: number, rate: number, every = 10) {
  const s = createSummary();
  s.startedAt = 0;
  s.status = "running";
  const pts: MetricPoint[] = [];
  for (let step = 0; step <= steps; step += every) pts.push({ step, value: 1 / (1 + step), ts: step / rate });
  s.metrics["train/loss"] = pts;
  s.latestStep = steps;
  return s;
}

test("total steps come from the most specific config key, or epochs × steps per epoch", () => {
  assert.deepEqual(totalStepsFromConfig({ lr: 1e-3, max_steps: 5000 }), { total: 5000, source: "max_steps in the config" });
  assert.deepEqual(totalStepsFromConfig({ "trainer.max_steps": "2000" }), { total: 2000, source: "max_steps in the config" });
  assert.deepEqual(totalStepsFromConfig({ epochs: 3, steps_per_epoch: 400 }), { total: 1200, source: "epochs × steps_per_epoch in the config" });
  assert.equal(totalStepsFromConfig({ epochs: 3 }), null);
  assert.equal(totalStepsFromConfig({ max_steps: -1 }), null);
});

test("the forecast extrapolates the recent step rate to the configured length", () => {
  const s = running(3000, 5); // 600 s in, 5 steps/s
  const f = forecastRun(s, { max_steps: 12_000 }, 600)!;
  assert.equal(f.currentStep, 3000);
  assert.equal(f.totalSteps, 12_000);
  assert.ok(Math.abs(f.stepsPerSec - 5) < 0.01, `rate ${f.stepsPerSec}`);
  assert.ok(Math.abs(f.remainingSec - 1800) < 5, `remaining ${f.remainingSec}`);
  assert.ok(Math.abs(f.progress - 0.25) < 1e-9);
  assert.ok(Math.abs(f.fullSec - 2400) < 5);

  const c = forecastCost(f, 2.4, "usd");
  assert.ok(Math.abs(c.soFar - 0.4) < 1e-6);
  assert.ok(Math.abs(c.remaining - 1.2) < 0.01);
  assert.ok(Math.abs(c.total - 1.6) < 0.01);
});

test("no forecast before two minutes, without a known length, or past the planned end", () => {
  assert.equal(forecastRun(running(300, 5), { max_steps: 1000 }, 60), null);
  assert.equal(forecastRun(running(3000, 5), {}, 600), null);
  assert.equal(forecastRun(running(3000, 5), { max_steps: 2000 }, 600), null);
});

test("the speed follows recent progress, not the average since the start", () => {
  const s = running(3000, 5);
  // The last 300 s ran twice as fast as before.
  const pts = s.metrics["train/loss"]!;
  const extra: MetricPoint[] = [];
  for (let step = 3010; step <= 6000; step += 10) extra.push({ step, value: 0.1, ts: 600 + (step - 3000) / 10 });
  s.metrics["train/loss"] = [...pts, ...extra];
  s.latestStep = 6000;
  const f = forecastRun(s, { max_steps: 10_000 }, 900)!;
  assert.ok(f.stepsPerSec > 8, `rate ${f.stepsPerSec}`);
});

test("without SDK metrics, a progress bar in the logs gives the position and speed", () => {
  const s = createSummary();
  s.startedAt = 0;
  const logs: LogLine[] = [];
  for (let i = 0; i <= 30; i++) logs.push({ seq: i + 1, ts: 100 + i * 10, stream: "stderr", line: ` ${i}%|███ | ${i * 20}/2000 [00:${i}<01:00, 2.00it/s]` });
  s.logs = logs;
  const bar = progressFromLogs(logs, 600)!;
  assert.equal(bar.current, 600);
  assert.equal(bar.total, 2000);
  assert.ok(Math.abs(bar.stepsPerSec! - 2) < 1e-9);
  const f = forecastRun(s, {}, 400)!;
  assert.equal(f.totalSteps, 2000);
  assert.match(f.totalSource, /progress bar/);
  assert.ok(Math.abs(f.remainingSec - 700) < 1, `remaining ${f.remainingSec}`);
});

test("a new progress bar (next epoch) resets the window instead of mixing totals", () => {
  const logs: LogLine[] = [
    { seq: 1, ts: 0, stream: "stderr", line: "900/1000 [00:10<00:01]" },
    { seq: 2, ts: 10, stream: "stderr", line: "1000/1000 [00:11<00:00]" },
    { seq: 3, ts: 20, stream: "stderr", line: "10/500 [00:01<00:30]" },
  ];
  const bar = progressFromLogs(logs, 600)!;
  assert.equal(bar.total, 500);
  assert.equal(bar.stepsPerSec, null);
});

test("GPU names map to rough speeds; unknown GPUs have none", () => {
  assert.equal(gpuSpeed("NVIDIA A100-SXM4-80GB"), 1);
  assert.equal(gpuSpeed("NVIDIA H100 80GB HBM3"), 2.2);
  assert.equal(gpuSpeed("NVIDIA H100 PCIe"), 1.6);
  assert.equal(gpuSpeed("NVIDIA RTX 6000 Ada Generation"), 0.8);
  assert.equal(gpuSpeed("NVIDIA RTX A6000"), 0.5);
  assert.equal(gpuSpeed("NVIDIA GeForce RTX 4090"), 0.75);
  assert.equal(gpuSpeed("NVIDIA L40S"), 0.85);
  assert.equal(gpuSpeed("Some Future GPU"), null);
});

test("other GPUs: same run priced and timed on each, too-small GPUs left out, a cheaper one recommended", () => {
  const f: Forecast = { currentStep: 1000, totalSteps: 10_000, totalSource: "", stepsPerSec: 1, progress: 0.1, elapsedSec: 1000, remainingSec: 9000, fullSec: 10_000 };
  const offers = [
    { id: "a100", name: "NVIDIA A100-SXM4-80GB", memoryGb: 80, pricePerHour: 190, stock: "High" },
    { id: "l40s", name: "NVIDIA L40S", memoryGb: 48, pricePerHour: 95, stock: "High" },
    { id: "l40s-c", name: "NVIDIA L40S", memoryGb: 48, pricePerHour: 86, stock: "Low" },
    { id: "h100", name: "NVIDIA H100 80GB HBM3", memoryGb: 80, pricePerHour: 330, stock: "Medium" },
    { id: "4090", name: "NVIDIA GeForce RTX 4090", memoryGb: 24, pricePerHour: 69, stock: "High" },
    { id: "gone", name: "NVIDIA RTX A6000", memoryGb: 48, pricePerHour: 49, stock: "None" },
  ];
  const cmp = compareGpus(f, { name: "NVIDIA A100-SXM4-80GB", count: 1, creditsPerHour: 190, peakMemMiBPerGpu: 30_000 }, offers)!;
  assert.ok(Math.abs(cmp.current.fullCredits! - 527.8) < 0.1);
  const names = cmp.options.map((o) => o.offer.id);
  assert.ok(!names.includes("4090"), "24 GB is too small for a 30 GB run");
  assert.ok(!names.includes("gone"), "out of stock");
  assert.ok(!names.includes("a100"), "the current GPU isn't an alternative");
  assert.deepEqual(names, ["l40s-c", "h100"], "cheapest L40S offer only, sorted by cost");
  const l40s = cmp.options[0]!;
  assert.ok(Math.abs(l40s.fullSec - 10_000 / 0.85) < 1);
  assert.ok(l40s.cheaper && !l40s.faster);
  const h100 = cmp.options[1]!;
  assert.ok(h100.faster && Math.abs(h100.speedup - 2.2) < 1e-9);
  assert.equal(cmp.recommended?.offer.id, "l40s-c");
});

test("no comparison for a GPU without a known speed", () => {
  const f: Forecast = { currentStep: 1, totalSteps: 2, totalSource: "", stepsPerSec: 1, progress: 0.5, elapsedSec: 1, remainingSec: 1, fullSec: 2 };
  assert.equal(compareGpus(f, { name: "Mystery", count: 1, creditsPerHour: null, peakMemMiBPerGpu: null }, []), null);
});
