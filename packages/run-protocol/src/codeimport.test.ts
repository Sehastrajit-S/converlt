import { test } from "node:test";
import assert from "node:assert/strict";
import { analyzeGraph, generateModelCode, importedToGraph, LAYERS, type ImportedGraph } from "./index.ts";

const imported = (extra: ImportedGraph["nodes"] = []): ImportedGraph => ({
  name: "SmallNet",
  nodes: [
    { id: "i1", type: "Input", params: { shape: "3,32,32", dtype: "float" } },
    { id: "i2", type: "Conv2d", params: { out_channels: 8, kernel_size: 3, stride: 1, padding: 1, dilation: 1, bias: false, groups: 1 } },
    { id: "i3", type: "ReLU", params: {} },
    { id: "i4", type: "Add", params: {} },
    { id: "i5", type: "AdaptiveAvgPool2d", params: { output_size: 1 } },
    { id: "i6", type: "Flatten", params: {} },
    ...extra,
    { id: "i7", type: "Output", params: { loss: "auto" } },
  ],
  edges: [
    { from: "i1", to: "i2" },
    { from: "i2", to: "i3" },
    { from: "i3", to: "i4" },
    { from: "i2", to: "i4" },
    { from: "i4", to: "i5" },
    { from: "i5", to: "i6" },
    ...(extra.length ? [{ from: "i6", to: extra[0]!.id }, { from: extra[0]!.id, to: "i7" }] : [{ from: "i6", to: "i7" }]),
  ],
});

test("imported graphs are laid out by depth, with branches side by side", () => {
  const s = importedToGraph(imported(), 216);
  assert.ok(s.ok, s.errors.join("; "));
  assert.equal(s.graph.name, "small net");
  const y = (id: string) => s.graph.nodes.find((n) => n.id === id)!.y;
  assert.ok(y("i1") < y("i2") && y("i2") < y("i3") && y("i3") < y("i4"), "each layer below its input");
  assert.equal(s.graphParams, 3 * 8 * 9, "no bias: weights only");
  assert.equal(s.graphParams, s.torchParams, "matches what PyTorch counted");
  assert.match(generateModelCode(s.graph), /nn\.Conv2d\(3, 8, kernel_size=3, stride=1, padding=1, bias=False\)/);
});

test("code the builder can't express is kept as a block with its measured shape, and blocks code generation", () => {
  const s = importedToGraph(imported([{ id: "c1", type: "Custom", params: { what: "head (MyHead)", shape: "10", params: 90 } }]), 306, ["head (MyHead)"]);
  assert.ok(s.ok, s.errors.join("; "));
  assert.equal(s.graphParams, 216 + 90);
  assert.deepEqual(analyzeGraph(s.graph).nodes.i7!.shape, [10]);
  assert.throws(() => generateModelCode(s.graph), /comes from your code as is \(head \(MyHead\)\)/);
  assert.ok(!LAYERS.filter((l) => !l.hidden).some((l) => l.type === "Custom"), "not offered in the palette");
});

test("pools take padding (ResNet's stem: 3×3 max pool, stride 2, padding 1)", () => {
  const s = importedToGraph({
    name: "stem",
    nodes: [
      { id: "a", type: "Input", params: { shape: "64,32,32" } },
      { id: "b", type: "MaxPool2d", params: { kernel_size: 3, stride: 2, padding: 1 } },
      { id: "c", type: "Output", params: {} },
    ],
    edges: [{ from: "a", to: "b" }, { from: "b", to: "c" }],
  }, 0);
  assert.deepEqual(analyzeGraph(s.graph).nodes.b!.shape, [64, 16, 16]);
  assert.match(generateModelCode(s.graph), /nn\.MaxPool2d\(3, stride=2, padding=1\)/);
});
