import { test } from "node:test";
import assert from "node:assert/strict";
import {
  analyzeGraph,
  datasetSpec,
  designDataIssues,
  fitToData,
  generateLoaderCode,
  generateTrainCode,
  TEMPLATES,
  templatesFitting,
  trainMode,
  type ColumnProfile,
  type DatasetRef,
  type DataSpec,
  type ImageProfile,
  type ModelGraph,
  type TabularProfile,
  type TensorProfile,
} from "./index.ts";

const tpl = (id: string): ModelGraph => TEMPLATES.find((t) => t.id === id)!.make();
const ref = (o: Partial<DatasetRef>): DatasetRef => ({ id: "d1", name: "Pets", machineId: "m", path: "/data/pets", format: "images", steps: [], addedAt: 0, ...o });

const images: ImageProfile = { kind: "images", format: "images", path: "/data/pets", files: 900, classes: [{ name: "cat", count: 300 }, { name: "dog", count: 300 }, { name: "fox", count: 300 }], splits: ["train", "val"], checked: 100, corrupt: 0, sizes: [], modes: { RGB: 100 }, pillow: true, bytes: 1, fileCount: 900 };
const col = (name: string, o: Partial<ColumnProfile>): ColumnProfile => ({ name, dtype: "numeric", missing: 0, unique: 100, sample: [], ...o });
const table: TabularProfile = {
  kind: "tabular", format: "csv", engine: "pandas", path: "/data/churn.csv", rows: 1000, rowsSampled: 1000, duplicates: 0, target: "churned", bytes: 1, fileCount: 1,
  columns: [col("age", {}), col("plan", { dtype: "categorical", unique: 3 }), col("id", { unique: 1000 }), col("churned", { dtype: "boolean", unique: 2, numeric: { min: 0, max: 1, mean: 0.2, std: 0.4, p01: 0, p50: 0, p99: 1, zeros: 800, outliers: 0, integer: true, hist: { edges: [], counts: [] } } })],
};
const tokens: TensorProfile = { kind: "tensors", format: "tensors", path: "/data/reviews.npz", splits: [{ name: "data", file: "/data/reviews.npz", count: 5000 }], keys: { x: "x", y: "y" }, x: { shape: [200], dtype: "int64", integer: true, min: 0, max: 29999, mean: null, std: null }, y: { shape: [], dtype: "int64", integer: true, classes: 2, counts: [] }, bytes: 1, fileCount: 1 };

test("what each kind of dataset feeds a model", () => {
  const img = datasetSpec(ref({ steps: [{ op: "image_resize", size: 64 }] }), images);
  assert.deepEqual([img.inputShape, img.task, img.classes, img.unitRange], [[3, 64, 64], "classification", 3, true]);

  const tab = datasetSpec(ref({ name: "Churn", format: "csv", target: "churned", steps: [{ op: "drop_columns", columns: ["id"] }, { op: "encode", columns: ["plan"], method: "onehot" }] }), table);
  assert.deepEqual([tab.inputShape, tab.task, tab.classes, tab.blockers], [[4], "classification", 2, []], "age + 3 one-hot plan columns; id dropped; target excluded");
  const raw = datasetSpec(ref({ name: "Churn", format: "csv", target: "churned" }), table);
  assert.match(raw.blockers[0]!, /plan.*still text/);

  const tok = datasetSpec(ref({ name: "Reviews", format: "tensors" }), tokens);
  assert.deepEqual([tok.inputShape, tok.inputDtype, tok.task, tok.classes, tok.vocab], [[200], "long", "classification", 2, 30000]);

  assert.match(datasetSpec(ref({}), null).blockers[0]!, /Profile Pets/);
});

test("fit to data: Input, vocabulary and last layer follow the dataset", () => {
  const cnn = fitToData(tpl("cnn"), datasetSpec(ref({ steps: [{ op: "image_resize", size: 64 }] }), images));
  const a = analyzeGraph(cnn.graph);
  assert.ok(a.ok);
  assert.deepEqual(a.nodes[cnn.graph.nodes.find((n) => n.type === "Output")!.id]!.shape, [3]);
  assert.deepEqual(cnn.changes, ["Input → 3×64×64", "Last Linear → 3 outputs"]);

  const spec = datasetSpec(ref({ name: "Reviews", format: "tensors" }), tokens);
  const lstm = fitToData(tpl("lstm"), spec);
  assert.ok(lstm.changes.includes("Embedding vocabulary → 30000"));
  assert.deepEqual(designDataIssues(lstm.graph, analyzeGraph(lstm.graph), spec, "Reviews"), []);

  // An autoencoder's last layer follows the input, not the labels.
  const ae = fitToData(tpl("tab-autoencoder"), { ...spec, inputShape: [20], inputDtype: "float", vocab: null });
  const aa = analyzeGraph(ae.graph);
  assert.equal(trainMode(ae.graph, aa, { ...spec, inputShape: [20], inputDtype: "float" }), "reconstruct");
  assert.deepEqual(aa.nodes[ae.graph.nodes.find((n) => n.type === "Output")!.id]!.shape, [20]);
});

test("templates that fit a dataset: tables get tabular models, images get image models", () => {
  const tab = datasetSpec(ref({ name: "Churn", format: "csv", target: "churned", steps: [{ op: "drop_columns", columns: ["id"] }, { op: "encode", columns: ["plan"], method: "onehot" }] }), table);
  const forTable = templatesFitting(tab, "Churn").map((t) => t.id);
  assert.ok(["mlp", "resmlp", "logreg", "ft-transformer"].every((id) => forTable.includes(id)), forTable.join(","));
  assert.ok(!forTable.includes("cnn") && !forTable.includes("vit"), "no image models for a table");
  const img = datasetSpec(ref({ steps: [{ op: "image_resize", size: 64 }] }), images);
  const forImages = templatesFitting(img, "Pets").map((t) => t.id);
  assert.ok(["cnn", "resnet", "vit", "vgg"].every((id) => forImages.includes(id)), forImages.join(","));
  assert.ok(!forImages.includes("mlp"));
  assert.deepEqual(templatesFitting(datasetSpec(ref({}), null), "Pets"), [], "nothing until it's profiled");
});

test("design and data that don't fit are explained", () => {
  const spec = datasetSpec(ref({ steps: [{ op: "image_resize", size: 64 }] }), images);
  const g = tpl("cnn");
  const issues = designDataIssues(g, analyzeGraph(g), spec, "Pets");
  assert.match(issues[0]!, /Pets gives \[B, 3, 64, 64\], but the Input is \[B, 3, 32, 32\]/);
  assert.match(issues[1]!, /3 classes, but the output gives 10 scores/);
  const unlabeled: DataSpec = { ...spec, task: "none", classes: null };
  const f = fitToData(g, unlabeled).graph;
  assert.match(designDataIssues(f, analyzeGraph(f), unlabeled, "Pets").join(" "), /no labels: only models that rebuild their input/);
});

test("training scripts read the dataset's loader: no synthetic data", () => {
  const spec = datasetSpec(ref({ steps: [{ op: "image_resize", size: 64 }] }), images);
  const g = fitToData(tpl("cnn"), spec).graph;
  const code = generateTrainCode(g, { name: "Pets", loaderStem: "pets", spec });
  assert.match(code, /from data\.pets_loader import make_loaders/);
  assert.match(code, /for epoch in range\(args\.epochs\):/);
  assert.match(code, /"val\/accuracy"/);
  assert.match(code, /torch\.save\(raw\.state_dict\(\), "checkpoints\/cnn_classifier\.pt"\)/);
  // Ready for several GPUs: torchrun's environment turns on DDP, a sampler per GPU, and one logger.
  assert.match(code, /world = int\(os\.environ\.get\("WORLD_SIZE", "1"\)\)/);
  assert.match(code, /DistributedDataParallel\(raw/);
  assert.match(code, /DistributedSampler\(train_loader\.dataset, num_replicas=world, rank=rank/);
  assert.match(code, /train_loader\.sampler\.set_epoch\(epoch\)/);
  assert.match(code, /if converge and main else None/);
  assert.match(code, /device = "mps"/, "Apple silicon GPUs");
  assert.doesNotMatch(code, /torch\.randn\(|torch\.randint\(|make_batch|synthetic/, "nothing made up");
  assert.throws(() => generateTrainCode(tpl("cnn"), { name: "Pets", loaderStem: "pets", spec }), /Pets gives/);

  const ddpm = fitToData(tpl("ddpm"), spec).graph;
  const diff = generateTrainCode(ddpm, { name: "Pets", loaderStem: "pets", spec });
  assert.match(diff, /return x\.float\(\) \* 2 - 1/, "images in [0, 1] become [-1, 1]");
  assert.match(diff, /x0 = scale\(unpack\(batch\)\[0\]\)/);
  assert.match(diff, /p\.add_argument\("--sample"/);
});

test("array loader: one file holds out validation; integer inputs stay ids", () => {
  const code = generateLoaderCode(ref({ name: "Reviews", format: "tensors", path: "/data/reviews.npz" }), tokens);
  assert.match(code, /FILES = \{"data":"\/data\/reviews\.npz"\}/);
  assert.match(code, /INPUT_DTYPE = torch\.long/);
  assert.match(code, /NUM_CLASSES = 2/);
  assert.match(code, /sets\["train"\], sets\["val"\] = Subset/);
});
