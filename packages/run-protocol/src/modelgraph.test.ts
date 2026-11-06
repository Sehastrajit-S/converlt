import { test } from "node:test";
import assert from "node:assert/strict";
import { analyzeGraph, className, defaultParams, generateModelCode, TEMPLATES, type LayerType, type ModelGraph } from "./index.ts";

const tpl = (id: string) => TEMPLATES.find((t) => t.id === id)!.make();
const outShape = (g: ModelGraph) => analyzeGraph(g).nodes[g.nodes.find((n) => n.type === "Output")!.id]!.shape;

test("templates are valid, with shapes and parameter counts PyTorch agrees with", () => {
  const expected: Record<string, { params: number; out: number[] }> = {
    mlp: { params: 784 * 256 + 256 + 256 * 128 + 128 + 128 * 10 + 10, out: [10] },
    cnn: { params: 896 + 64 + 18_496 + 128 + 650, out: [10] },
    // Embedding + bidirectional LSTM (2 × 4 × (256·128 + 256·256 + 2·256)) + Linear.
    lstm: { params: 20_000 * 128 + 2 * 4 * (256 * 128 + 256 * 256 + 512) + 512 * 2 + 2, out: [2] },
    // Embedding + learned positions + 2 pre-norm blocks (attention 4E²+4E, MLP, two LayerNorms) + LayerNorm + head.
    transformer: { params: 8000 * 256 + 256 * 256 + 2 * (4 * 256 * 256 + 4 * 256 + (256 * 1024 + 1024) + (1024 * 256 + 256) + 4 * 256) + 512 + (256 * 8000 + 8000), out: [256, 8000] },
  };
  for (const [id, want] of Object.entries(expected)) {
    const g = tpl(id);
    const a = analyzeGraph(g);
    assert.ok(a.ok, `${id}: ${a.errors.join(", ")} ${Object.values(a.nodes).map((n) => n.error).filter(Boolean).join(", ")}`);
    assert.equal(a.totalParams, want.params, id);
    assert.deepEqual(outShape(g), want.out, id);
  }
  assert.ok(analyzeGraph(tpl("resnet")).ok);
});

test("conv and pool shapes follow PyTorch's formulas", () => {
  const g = tpl("cnn");
  const a = analyzeGraph(g);
  const shapes = g.nodes.map((n) => a.nodes[n.id]!.shape?.join("x"));
  assert.deepEqual(shapes.slice(0, 6), ["3x32x32", "32x32x32", "32x32x32", "32x32x32", "32x16x16", "64x16x16"]);
  const conv = g.nodes[1]!;
  conv.params.padding = 0;
  conv.params.stride = 2;
  assert.equal(analyzeGraph(g).nodes[conv.id]!.shape!.join("x"), "32x15x15");
});

function graph(types: [LayerType, Record<string, unknown>?][], extraEdges: [number, number][] = []): ModelGraph {
  const nodes = types.map(([t, p], i) => ({ id: `k${i}`, type: t, params: { ...defaultParams(t), ...(p as object) }, x: 0, y: i * 90 }));
  return { name: "t", nodes, edges: [...nodes.slice(1).map((n, i) => ({ from: nodes[i]!.id, to: n.id })), ...extraEdges.map(([a, b]) => ({ from: `k${a}`, to: `k${b}` }))] };
}

test("mistakes are reported on the layer that has them", () => {
  const conv = analyzeGraph(graph([["Input", { shape: "784" }], ["Conv2d"], ["Output"]]));
  assert.match(conv.nodes.k1!.error!, /needs \[channels, height, width\], got \[B, 784\]/);
  assert.equal(conv.ok, false);

  const emb = analyzeGraph(graph([["Input", { shape: "16" }], ["Embedding"], ["Output"]]));
  assert.match(emb.nodes.k1!.error!, /token ids/);

  const heads = analyzeGraph(graph([["Input", { shape: "10,100" }], ["MultiheadAttention", { num_heads: 8 }], ["Output"]]));
  assert.match(heads.nodes.k1!.error!, /must divide by the number of heads/);

  const add = analyzeGraph(graph([["Input", { shape: "64" }], ["Linear", { out_features: 32 }], ["Add"], ["Output"]], [[0, 2]]));
  assert.match(add.nodes.k2!.error!, /same shape/);

  const big = analyzeGraph(graph([["Input", { shape: "3,4,4" }], ["Conv2d", { kernel_size: 7, padding: 0 }], ["Output"]]));
  assert.match(big.nodes.k1!.error!, /larger than the input/);
});

test("graph-level problems: loops, missing ends, and stray layers", () => {
  const loop = analyzeGraph(graph([["Input", { shape: "8" }], ["Linear", { out_features: 8 }], ["Add"], ["Output"]], [[2, 1]]));
  assert.ok(loop.errors.some((e) => /loop/.test(e)));
  const none = analyzeGraph({ name: "t", nodes: [], edges: [] });
  assert.ok(none.errors.some((e) => /Add an Input/.test(e)));
  const stray = graph([["Input", { shape: "8" }], ["Output"]]);
  stray.nodes.push({ id: "lonely", type: "ReLU", params: {}, x: 0, y: 0 });
  assert.match(analyzeGraph(stray).nodes.lonely!.error!, /needs an input/);
  // Wired in but leading nowhere:
  const dead = graph([["Input", { shape: "8" }], ["Output"], ["ReLU"]]);
  dead.edges = [{ from: "k0", to: "k1" }, { from: "k0", to: "k2" }];
  assert.match(analyzeGraph(dead).nodes.k2!.error!, /doesn.t lead to the Output/);
});

test("generated code: inferred sizes, readable names, and a residual keeps its input", () => {
  const code = generateModelCode(tpl("resnet"));
  assert.match(code, /class ResidualNet\(nn\.Module\):/);
  assert.match(code, /self\.conv1 = nn\.Conv2d\(3, 64, kernel_size=3, stride=1, padding=1\)/);
  assert.match(code, /self\.fc1 = nn\.Linear\(64, 10\)/);
  // The stem output feeds two layers, so the branch writes to a new variable and the Add sums both.
  assert.match(code, /x2 = self\.conv2\(x\)/);
  assert.match(code, /x = x2 \+ x|x = x \+ x2|x3 = x2 \+ x|x3 = x \+ x2/);
  assert.match(code, /INPUT_SHAPE = \(3, 32, 32\)/);

  const lstm = generateModelCode(tpl("lstm"));
  assert.match(lstm, /nn\.LSTM\(128, 256, num_layers=1, batch_first=True, bidirectional=True\)/);
  assert.match(lstm, /x = self\.lstm1\(x\)\[0\]/);
  assert.match(lstm, /x = x\[:, -1\]/);
  assert.match(lstm, /INPUT_DTYPE = torch\.long/);

  const gpt = generateModelCode(tpl("transformer"));
  assert.match(gpt, /generate_square_subsequent_mask\(x\.size\(1\), device=x\.device\), is_causal=True/, "GPT blocks are causal");
  assert.match(gpt, /x = x \+ self\.pos1\(torch\.arange\(x\.size\(1\), device=x\.device\)\)/);
});

test("every template is valid", () => {
  for (const t of TEMPLATES) {
    const a = analyzeGraph(t.make());
    assert.ok(a.ok, `${t.id}: ${a.errors.join(", ")} ${Object.values(a.nodes).map((n) => n.error).filter(Boolean).join(", ")}`);
  }
});

test("diffusion: a Timestep input and broadcast conditioning", () => {
  const g = tpl("ddpm");
  const a = analyzeGraph(g);
  assert.ok(a.ok, a.errors.join(", "));
  const code = generateModelCode(g, a);
  assert.match(code, /class TimestepEmbedding\(nn\.Module\)/);
  assert.match(code, /def forward\(self, x, t\):/);
  assert.match(code, /temb = self\.time1\(t\)/);
  assert.match(code, /\.reshape\(\w+\.size\(0\), -1, 1, 1\)/, "a channel vector is added to every pixel");
  assert.match(code, /^TIMESTEPS = 1000$/m);
  assert.match(generateModelCode(tpl("dit")), /\.unsqueeze\(1\)/, "and to every token");
  // A Timestep left unconnected is flagged; two are not allowed.
  const loose = graph([["Input", { shape: "8" }], ["Output"]]);
  loose.nodes.push({ id: "ts", type: "Timestep", params: defaultParams("Timestep"), x: 0, y: 0 });
  assert.match(analyzeGraph(loose).nodes.ts!.error!, /doesn.t lead to the Output/);
  // Vectors broadcast only where they line up.
  const bad = graph([["Input", { shape: "64,8,8" }], ["Add"], ["Output"]]);
  bad.nodes.push({ id: "v", type: "Timestep", params: { dim: 32, steps: 10 }, x: 0, y: 0 });
  bad.edges.push({ from: "v", to: "k1" });
  assert.match(analyzeGraph(bad).nodes.k1!.error!, /same shape/);
});

test("new layers: 3-D, transposed and dilated convolutions, groups, upsampling, reshape and permute", () => {
  const shape = (types: [LayerType, Record<string, unknown>?][]) => {
    const a = analyzeGraph(graph(types));
    return { s: a.nodes[`k${types.length - 2}`]!.shape?.join("x"), e: Object.values(a.nodes).map((n) => n.error).filter(Boolean)[0], p: a.totalParams };
  };
  assert.equal(shape([["Input", { shape: "3,16,64,64" }], ["Conv3d", { out_channels: 8, stride: 2 }], ["Output"]]).s, "8x8x32x32");
  assert.equal(shape([["Input", { shape: "64,8,8" }], ["ConvTranspose2d", { out_channels: 32 }], ["Output"]]).s, "32x16x16");
  assert.equal(shape([["Input", { shape: "8,96" }], ["Conv1d", { out_channels: 8, padding: 4, dilation: 4 }], ["Output"]]).s, "8x96");
  const dw = shape([["Input", { shape: "32,8,8" }], ["Conv2d", { out_channels: 32, groups: 32 }], ["Output"]]);
  assert.equal(dw.p, 32 * 9 + 32, "depthwise: one 3×3 filter per channel");
  assert.match(shape([["Input", { shape: "30,8,8" }], ["Conv2d", { out_channels: 32, groups: 4 }], ["Output"]]).e!, /groups/);
  assert.equal(shape([["Input", { shape: "4,8,8" }], ["Upsample"], ["Output"]]).s, "4x16x16");
  assert.equal(shape([["Input", { shape: "192,8,8" }], ["Reshape", { shape: "192,-1" }], ["Output"]]).s, "192x64");
  assert.match(shape([["Input", { shape: "10" }], ["Reshape", { shape: "3,-1" }], ["Output"]]).e!, /can't split 10/);
  assert.equal(shape([["Input", { shape: "192,64" }], ["Permute", { order: "1,0" }], ["Output"]]).s, "64x192");
  assert.match(shape([["Input", { shape: "192,64" }], ["Permute", { order: "0,0" }], ["Output"]]).e!, /each of 0..1 once/);
  assert.equal(shape([["Input", { shape: "64,1024" }], ["AdaptiveAvgPool3d"], ["Output"]]).e, "needs [channels, frames, height, width], got [B, 64, 1024]");
});

test("no code for a broken graph", () => {
  assert.throws(() => generateModelCode(graph([["Input", { shape: "784" }], ["Conv2d"], ["Output"]])), /Fix the highlighted layers/);
});

test("class names come from the model name", () => {
  assert.equal(className("my cool-net v2"), "MyCoolNetV2");
  assert.equal(className("3d unet"), "Model3dUnet");
  assert.equal(className(""), "Model");
});

test("templates are grouped by data type, then sorted by model", async () => {
  const { templateGroups } = await import("./index.ts");
  assert.deepEqual(
    templateGroups().map((g) => g.data),
    ["Text", "Tabular", "Images", "Video", "Audio", "Time series", "Generative"],
  );
  for (const g of templateGroups()) {
    const models = g.templates.map((t) => t.model!);
    assert.deepEqual(models, [...models].sort((a, b) => a.localeCompare(b)), `${g.data} is sorted by model`);
  }
  assert.equal(templateGroups().reduce((n, g) => n + g.templates.length, 0), TEMPLATES.length - 1, "every template but Blank is in a group");
});
