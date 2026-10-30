import { test } from "node:test";
import assert from "node:assert/strict";
import {
  applyEvent,
  canTransition,
  createSummary,
  diffConfigs,
  displayStatus,
  downsample,
  estimateCost,
  parseCliHyperparameters,
  parseEventLines,
  primaryMetricKey,
  seriesStats,
  sharedMetricKeys,
  summarize,
  tokenizeCommand,
} from "./index.ts";
import type { RunEvent } from "./index.ts";

test("lifecycle transitions", () => {
  assert.ok(canTransition("created", "preparing"));
  assert.ok(canTransition("running", "cancelling"));
  assert.ok(canTransition("running", "unknown"));
  assert.ok(canTransition("unknown", "completed"));
  assert.ok(!canTransition("completed", "running"));
  assert.ok(!canTransition("failed", "unknown"));
});

test("lost connection shows unknown, never failed", () => {
  assert.equal(displayStatus("running", { phase: "launched", updatedAt: 0 }, "lost"), "unknown");
  assert.equal(displayStatus("running", { phase: "launched", updatedAt: 0 }, "reconnecting"), "running");
  assert.equal(displayStatus("completed", null, "lost"), "completed");
  assert.equal(displayStatus(null, { phase: "launch_failed", updatedAt: 0 }, "idle"), "failed");
  assert.equal(displayStatus(null, { phase: "preparing", updatedAt: 0 }, "idle"), "preparing");
});

test("summary folds events and dedupes replays", () => {
  const events: RunEvent[] = [
    { seq: 1, ts: 100, type: "status", status: "running", pid: 42 },
    { seq: 2, ts: 101, type: "metric", step: 0, values: { "train/loss": 1.5 } },
    { seq: 3, ts: 102, type: "metric", step: 1, values: { "train/loss": "NaN" } },
    { seq: 4, ts: 103, type: "log", stream: "stderr", line: "boom" },
    {
      seq: 5,
      ts: 104,
      type: "telemetry",
      gpus: [{ index: 0, name: "A100", memUsedMiB: 1000, memTotalMiB: 40000, utilPct: 50, tempC: 60, powerW: 200 }],
      host: { load1: 1, cpuCount: 8, memUsedMiB: 1, memTotalMiB: 2, diskFreeGiB: 3 },
    },
    { seq: 6, ts: 105, type: "diagnostic", kind: "oom", severity: "error", message: "OOM", data: { line: "x" } },
    { seq: 7, ts: 106, type: "diagnostic", kind: "oom", severity: "error", message: "OOM", data: { allocatedMiB: 9 } },
    { seq: 8, ts: 110, type: "status", status: "failed", exitCode: 1 },
  ];
  const s = summarize([...events, ...events]); // replayed twice
  assert.equal(s.status, "failed");
  assert.equal(s.exitCode, 1);
  assert.equal(s.startedAt, 100);
  assert.equal(s.endedAt, 110);
  assert.equal(s.lastSeq, 8);
  assert.deepEqual(
    s.metrics["train/loss"]!.map((p) => p.value),
    [1.5, null],
  );
  assert.equal(s.logs.length, 1);
  assert.equal(s.peakGpuMemMiB, 1000);
  assert.equal(s.diagnostics.length, 1);
  assert.deepEqual(s.diagnostics[0]!.data, { line: "x", allocatedMiB: 9 });
});

test("metric without step continues the series", () => {
  const s = createSummary();
  applyEvent(s, { seq: 1, ts: 1, type: "metric", step: null, values: { acc: 0.1 } });
  applyEvent(s, { seq: 2, ts: 2, type: "metric", step: null, values: { acc: 0.2 } });
  assert.deepEqual(s.metrics.acc!.map((p) => p.step), [0, 1]);
});

test("parseEventLines tolerates torn lines", () => {
  const evs = parseEventLines('{"seq":1,"ts":1,"type":"log","stream":"stdout","line":"a"}\n{"seq":2,"ts"');
  assert.equal(evs.length, 1);
});

test("cli hyperparameters", () => {
  assert.deepEqual(parseCliHyperparameters("python train.py --lr 0.0001 --batch-size=32 --amp --name 'my run' --wd -1e-4"), {
    lr: 0.0001,
    batch_size: 32,
    amp: true,
    name: "my run",
    wd: -0.0001,
  });
  assert.deepEqual(parseCliHyperparameters("source .venv/bin/activate --x 1 && python t.py --epochs 3"), { epochs: 3 });
  assert.deepEqual(tokenizeCommand(`a "b c" d\\ e`), ["a", "b c", "d e"]);
});

test("config diff orders differing keys first", () => {
  const rows = diffConfigs([
    { lr: 0.1, opt: { name: "adam", beta: 0.9 } },
    { lr: 0.01, opt: { name: "adam", beta: 0.9 }, extra: 1 },
  ]);
  assert.deepEqual(
    rows.map((r) => [r.key, r.differs]),
    [
      ["extra", true],
      ["lr", true],
      ["opt.beta", false],
      ["opt.name", false],
    ],
  );
});

test("helpers", () => {
  assert.deepEqual(sharedMetricKeys([["a", "b"], ["b", "c"]]), ["b"]);
  assert.equal(primaryMetricKey(["acc", "val/loss", "train/loss"]), "train/loss");
  assert.equal(downsample([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 4).length, 4);
  assert.deepEqual(downsample([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 4).at(-1), 10);
  const st = seriesStats([
    { step: 0, value: 3, ts: 0 },
    { step: 1, value: null, ts: 0 },
    { step: 2, value: 1, ts: 0 },
  ]);
  assert.deepEqual(st, { last: 1, min: 1, max: 3, count: 3, lastStep: 2 });
  assert.deepEqual(estimateCost(2, 0, 1800), { hours: 0.5, usd: 1 });
  assert.equal(estimateCost(undefined, 0, 3600).usd, null);
});
