import { test } from "node:test";
import assert from "node:assert/strict";
import { analyzeGraph, applyEvent, createSummary, generateModelCode, healthOf, mainTensor, MAX_WEIGHT_SNAPSHOTS, moduleNames, moduleOf, TEMPLATES, tensorsOf, weightIssues, type WeightsEvent, type WeightTensor } from "./index.ts";

const t = (name: string, o: Partial<WeightTensor> = {}): WeightTensor => ({ name, shape: [8, 4], numel: 32, mean: 0, std: 0.1, absMax: 0.3, gradNorm: 0.01, hist: { min: -0.3, max: 0.3, counts: [1, 2, 1] }, ...o });
const snap = (seq: number, step: number, tensors: WeightTensor[]): WeightsEvent => ({ seq, ts: seq, type: "weights", step, tensors });

test("module names match the generated code, so logged tensors map back to canvas nodes", () => {
  const g = TEMPLATES.find((x) => x.id === "cnn")!.make();
  const names = moduleNames(g);
  const code = generateModelCode(g);
  for (const name of Object.values(names)) assert.match(code, new RegExp(`self\\.${name} = nn\\.`));
  assert.deepEqual(Object.values(names).filter((n) => n.startsWith("conv")), ["conv1", "conv2"]);
  const relu = g.nodes.find((n) => n.type === "ReLU")!;
  assert.equal(names[relu.id], "relu1");
  assert.equal(names[g.nodes.find((n) => n.type === "Input")!.id], undefined, "Input has no module");
  assert.ok(analyzeGraph(g).ok);
});

test("tensors are grouped by their top-level module", () => {
  assert.equal(moduleOf("block1.self_attn.in_proj_weight"), "block1");
  const s = snap(1, 0, [t("conv1.weight", { shape: [32, 3, 3, 3] }), t("conv1.bias", { shape: [32] }), t("conv10.weight")]);
  assert.deepEqual(tensorsOf(s, "conv1").map((x) => x.name), ["conv1.weight", "conv1.bias"]);
  assert.equal(mainTensor(tensorsOf(s, "conv1"))!.name, "conv1.weight");
});

test("issues: NaN, collapsed, exploding, no gradient, vanishing, frozen", () => {
  assert.deepEqual(weightIssues([t("fc1.weight"), t("fc1.bias", { shape: [8], std: 0 })]), [], "healthy, and a constant bias is normal");
  assert.equal(healthOf(weightIssues([t("a.weight", { nonFinite: 3 })])), "error");
  assert.match(weightIssues([t("a.weight", { std: 0 })])[0]!.message, /same/);
  assert.match(weightIssues([t("a.weight", { absMax: 5e4 })])[0]!.message, /blowing up/);
  assert.match(weightIssues([t("a.weight", { gradNorm: 0 })])[0]!.message, /isn't learning/);
  assert.match(weightIssues([t("a.weight", { gradNorm: 1e-12 })])[0]!.message, /vanishing/);
  const first = [t("a.weight")];
  assert.match(weightIssues([t("a.weight")], first, { first: 0, latest: 500 })[0]!.message, /Unchanged since step 0/);
  assert.deepEqual(weightIssues([t("a.weight", { std: 0.12 })], first, { first: 0, latest: 500 }), []);
  assert.deepEqual(weightIssues([t("a.weight")], first, { first: 0, latest: 0 }), [], "the first snapshot can't have moved yet");
});

test("weight history stays bounded but keeps the start and the latest", () => {
  const s = createSummary();
  for (let i = 1; i <= 500; i++) applyEvent(s, snap(i, i * 10, [t("a.weight")]));
  assert.ok(s.weights.length <= MAX_WEIGHT_SNAPSHOTS);
  assert.equal(s.weights[0]!.step, 10);
  assert.equal(s.weights.at(-1)!.step, 5000);
});
