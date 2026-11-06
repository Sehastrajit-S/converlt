import { test } from "node:test";
import assert from "node:assert/strict";
import { dataInsights, generateLoaderCode, generatePreprocessCode, processedDir, pyPath, type ColumnProfile, type DatasetRef, type ImageProfile, type TabularProfile } from "./index.ts";

const num = (name: string, o: Partial<ColumnProfile> & { min?: number; max?: number; mean?: number; p50?: number; p01?: number; p99?: number; outliers?: number } = {}): ColumnProfile => ({
  name,
  dtype: "numeric",
  missing: o.missing ?? 0,
  unique: o.unique ?? 500,
  sample: [],
  targetCorr: o.targetCorr,
  numeric: { min: o.min ?? 0, max: o.max ?? 10, mean: o.mean ?? 5, std: 2, p01: o.p01 ?? 0, p50: o.p50 ?? 5, p99: o.p99 ?? 10, zeros: 0, outliers: o.outliers ?? 0, integer: false, hist: { edges: [], counts: [] } },
});
const cat = (name: string, unique: number, missing = 0): ColumnProfile => ({ name, dtype: "categorical", missing, unique, sample: [], top: [{ value: "a", count: 10 }] });

function profile(columns: ColumnProfile[], o: Partial<TabularProfile> = {}): TabularProfile {
  return { kind: "tabular", format: "csv", engine: "pandas", path: "/d/x.csv", rows: 1000, rowsSampled: 1000, duplicates: 0, target: "y", columns, bytes: 1, fileCount: 1, ...o };
}

const target: ColumnProfile = { name: "y", dtype: "boolean", missing: 0, unique: 2, sample: [], top: [{ value: "0", count: 950 }, { value: "1", count: 50 }], numeric: { min: 0, max: 1, mean: 0.05, std: 0.2, p01: 0, p50: 0, p99: 1, zeros: 950, outliers: 0, integer: true, hist: { edges: [], counts: [] } } };

test("EDA finds leakage, IDs, constants, missing values, imbalance, scale gaps and duplicates, each with a fix", () => {
  const p = profile(
    [
      num("customer_id", { unique: 1000, max: 1e6 }),
      num("refund", { unique: 2, targetCorr: 0.99 }),
      cat("country", 1),
      num("income", { missing: 120, min: 0, max: 900_000, mean: 60_000, p50: 40_000, p01: 1000, p99: 400_000 }),
      num("rate", { min: 0, max: 1, mean: 0.5, p50: 0.5, p01: 0, p99: 1 }),
      cat("plan", 3),
      target,
    ],
    { duplicates: 80 },
  );
  const ins = dataInsights(p);
  const titles = ins.map((i) => i.title);
  assert.equal(ins[0]!.severity, "error");
  assert.match(titles[0]!, /refund predicts y almost perfectly/);
  assert.ok(titles.some((t) => /y is imbalanced/.test(t)));
  assert.ok(titles.some((t) => /customer_id looks like an ID/.test(t)));
  assert.ok(titles.some((t) => /country has a single value/.test(t)));
  assert.ok(titles.some((t) => /income has 120 missing/.test(t)));
  assert.ok(titles.some((t) => /80 duplicate rows/.test(t)));
  assert.ok(titles.some((t) => /plan is text categories/.test(t)));
  const scale = ins.find((i) => i.fix?.op === "scale")!;
  assert.ok(scale, "income and rate differ by far more than 100×");
  assert.deepEqual((scale.fix as { columns: string[] }).columns, ["income", "rate"], "IDs and leaks suggested for dropping aren't scaled");
  assert.equal(ins.find((i) => /income has/.test(i.title))!.fix!.op, "fill_missing");
});

test("insights already addressed by the pipeline go away", () => {
  const p = profile([num("a", { missing: 10 }), cat("b", 4), target], { duplicates: 5 });
  const steps = dataInsights(p).filter((i) => i.fix).map((i) => i.fix!);
  const left = dataInsights(p, steps);
  assert.deepEqual(left.map((i) => i.title), ["y is imbalanced"]);
});

test("image folders: imbalance, corrupt files, mixed sizes and color modes", () => {
  const p: ImageProfile = { kind: "images", format: "images", path: "/img", files: 1200, classes: [{ name: "cat", count: 1000 }, { name: "dog", count: 100 }, { name: "fox", count: 100 }], splits: ["train"], checked: 400, corrupt: 3, sizes: [{ size: "640x480", count: 300 }, { size: "320x240", count: 100 }], modes: { RGB: 390, L: 10 }, pillow: true, bytes: 1, fileCount: 1200 };
  const ins = dataInsights(p);
  assert.match(ins[0]!.title, /3 of 400 sampled images can't be opened/);
  assert.ok(ins.some((i) => /imbalanced/.test(i.title)));
  assert.equal(ins.find((i) => /different sizes/.test(i.title))!.fix!.op, "image_resize");
  assert.ok(ins.some((i) => /Mixed color modes/.test(i.title)));
});

const ds = (o: Partial<DatasetRef> = {}): DatasetRef => ({ id: "1", name: "Churn Data", machineId: "m", path: "/data/churn.csv", format: "csv", target: "churned", addedAt: 0, steps: [], ...o });

test("preprocessing: rows first, then split, then fitted steps in a fixed order, all fitted on train", () => {
  const code = generatePreprocessCode(
    ds({
      steps: [
        { op: "scale", columns: ["age"], method: "standard" },
        { op: "split", val: 0.1, test: 0.1, stratify: true, seed: 3 },
        { op: "clip_outliers", columns: ["age"], lower: 0.01, upper: 0.99 },
        { op: "drop_columns", columns: ["id"] },
        { op: "fill_missing", columns: ["age"], strategy: "median" },
      ],
    }),
  );
  const at = (s: string) => {
    const i = code.indexOf(s);
    assert.ok(i >= 0, `missing: ${s}`);
    return i;
  };
  assert.ok(at('df.drop(columns=["id"]') < at("rng = np.random.default_rng(3)"));
  assert.ok(at("rng = np.random.default_rng(3)") < at("fills = "));
  assert.ok(at("fills = ") < at("bounds = ") && at("bounds = ") < at("stats = "), "fill → clip → scale whatever order they were added in");
  assert.match(code, /groupby\(TARGET, dropna=False\)\] if True/);
  assert.match(code, /fit = splits\.get\("train"/);
  assert.match(code, /float\(fit\[c\]\.median\(\)\)/, "statistics come from the training split");
  assert.match(code, /p\.add_argument\("--output", default="\/data\/churn_data_processed"\)/);
});

test("processed data goes next to the input, for files and folders", () => {
  assert.equal(processedDir(ds()), "/data/churn_data_processed");
  assert.equal(processedDir(ds({ path: "/data/shards/" })), "/data/churn_data_processed", "beside a folder, not inside it: it would be read back as data");
  const code = generatePreprocessCode(ds({ path: "/data/shards" }));
  assert.match(code, /not any\(part\.endswith\("_processed"\)/, "older layouts: processed folders inside are skipped");
});

test("loaders: tensors from processed splits for tables; ImageFolder with transforms and workers for images", () => {
  const tab = generateLoaderCode(ds());
  assert.match(tab, /DATA_DIR = "\/data\/churn_data_processed"/);
  assert.match(tab, /TASK = "classification"/);
  assert.match(tab, /aren't numbers yet/);
  const img = generateLoaderCode(ds({ format: "images", path: "/img", steps: [{ op: "image_resize", size: 160 }, { op: "image_augment", flip: true, crop: true, colorJitter: false }, { op: "image_normalize", mode: "imagenet" }] }));
  assert.match(img, /SIZE = 160/);
  assert.match(img, /TRAIN_TRANSFORM = transforms\.Compose\(\[transforms\.RandomResizedCrop\(SIZE, scale=\(0\.6, 1\.0\)\), transforms\.RandomHorizontalFlip\(\), transforms\.ToTensor\(\), NORMALIZE\]\)/);
  assert.match(img, /EVAL_TRANSFORM = transforms\.Compose\(\[transforms\.Resize\(\(SIZE, SIZE\)\), transforms\.ToTensor\(\), NORMALIZE\]\)/, "no augmentation at evaluation");
  assert.match(img, /persistent_workers=workers > 0/);
});

test("generated data paths in a home folder work for another person", () => {
  assert.equal(pyPath("/home/sehas/.converge/hub/hf/datasets/iris"), 'os.path.expanduser("~/.converge/hub/hf/datasets/iris")');
  assert.equal(pyPath("/root/data"), 'os.path.expanduser("~/data")');
  assert.equal(pyPath("/workspace/data"), '"/workspace/data"');
  const loader = generateLoaderCode(ds({ path: "/home/ana/data/churn.csv" }));
  assert.match(loader, /DATA_DIR = os\.path\.expanduser\("~\/data\/churn_data_processed"\)/);
});
