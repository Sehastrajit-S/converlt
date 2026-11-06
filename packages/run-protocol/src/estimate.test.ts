import { test } from "node:test";
import assert from "node:assert/strict";
import { builderSteps, estimateDesign, estimateFromHistory, estimateSeconds, rankMachines, TEMPLATES, type MachineCandidate } from "./index.ts";

const tpl = (id: string) => TEMPLATES.find((t) => t.id === id)!.make();

test("steps follow the training script's own rule: about 500 steps, at least 10 epochs", () => {
  assert.equal(builderSteps(120, 64), 500, "2 batches per epoch → 250 epochs");
  assert.equal(builderSteps(64_000, 64), 10_000, "1000 batches per epoch → 10 epochs");
  assert.equal(builderSteps(64_000, 64, 2), 2000);
  assert.equal(builderSteps(64_000, 64, 0, 300), 300);
});

test("design estimates grow with the model and the batch, and give a time per GPU", () => {
  const small = estimateDesign(tpl("mlp"), { batch: 64, samples: 50_000 })!;
  const big = estimateDesign(tpl("resnet"), { batch: 64, samples: 50_000 })!;
  assert.ok(small.memMiB < big.memMiB);
  assert.ok(small.memMiB >= 450, "includes the CUDA context");
  const bigBatch = estimateDesign(tpl("resnet"), { batch: 256, samples: 50_000 })!;
  assert.ok(bigBatch.memMiB > big.memMiB);
  const t3060 = estimateSeconds(big, "NVIDIA GeForce RTX 3060")!;
  const tH100 = estimateSeconds(big, "NVIDIA H100 80GB HBM3")!;
  assert.ok(t3060 > tH100 && tH100 > 0);
  assert.ok(estimateSeconds(big, "cpu")! > t3060);
  assert.equal(estimateDesign(tpl("mlp"), { batch: 64, samples: null })!.flops, null, "no data size: memory only");
});

test("history: the last finished run of the same script, scaled to another GPU", () => {
  const past = [
    { name: "run-003", command: "python train.py --lr 1", status: "failed", peakGpuMemMiB: 900, durationSec: 5, gpu: "RTX 3060" },
    { name: "run-002", command: "python train.py --lr 2", status: "completed", peakGpuMemMiB: 2048, durationSec: 600, gpu: "NVIDIA A100-SXM4-80GB" },
  ];
  const e = estimateFromHistory("python train.py --lr 3", past)!;
  assert.equal(e.fromRun, "run-002");
  assert.equal(e.memMiB, 2048);
  assert.equal(estimateSeconds(e, "NVIDIA A100-SXM4-80GB"), 600);
  assert.ok(estimateSeconds(e, "NVIDIA H100 80GB HBM3")! < 600);
  assert.equal(estimateFromHistory("python other.py", past), null);
});

test("machine choice: fits first, idle before busy, free hardware unless paying halves the time", () => {
  const e = estimateDesign(tpl("vgg"), { batch: 64, samples: 50_000 })!;
  const m = (o: Partial<MachineCandidate> & { id: string }): MachineCandidate => ({ name: o.id, ready: true, busy: 0, gpus: [], pricePerHour: null, ...o });
  const gpu = (name: string, gb: number, usedGb = 0) => [{ name, memTotalMiB: gb * 1024, memUsedMiB: usedGb * 1024 }];
  const ranked = rankMachines(e, [
    m({ id: "tiny", gpus: gpu("NVIDIA GeForce RTX 3060", 12, 11.9) }),
    m({ id: "home", gpus: gpu("NVIDIA GeForce RTX 3060", 12) }),
    m({ id: "busy", gpus: gpu("NVIDIA GeForce RTX 4090", 24), busy: 1 }),
    m({ id: "cloud", gpus: gpu("NVIDIA H100 80GB HBM3", 80), pricePerHour: 300 }),
    m({ id: "laptop" }),
    m({ id: "off", ready: false, gpus: gpu("NVIDIA H100 80GB HBM3", 80) }),
  ]);
  assert.deepEqual(ranked.map((c) => c.machine.id).slice(0, 2), ["cloud", "home"], "the H100 is far more than twice as fast");
  assert.ok(!ranked.find((c) => c.machine.id === "tiny")!.fits);
  assert.equal(ranked.at(-1)!.machine.id, "tiny");
  assert.ok(!ranked.some((c) => c.machine.id === "off"));
  const cheap = rankMachines(e, [m({ id: "cloud", gpus: gpu("NVIDIA GeForce RTX 4090", 24), pricePerHour: 50 }), m({ id: "home", gpus: gpu("NVIDIA GeForce RTX 3090", 24) })]);
  assert.equal(cheap[0]!.machine.id, "home", "a 4090 isn't twice a 3090: not worth paying for");
});
