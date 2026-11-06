// The data side of the workflow: a dataset where it lives (on a machine), its profile (EDA), the
// problems the profile shows with suggested fixes, a preprocessing pipeline, and the generated
// scripts: preprocess_<name>.py (pandas, fitted on the training split only) and <name>_loader.py
// (PyTorch DataLoaders).

export type DataFormat = "csv" | "tsv" | "parquet" | "jsonl" | "json" | "images" | "tensors" | "unknown";

export interface DatasetRef {
  id: string;
  name: string;
  machineId: string;
  /** Absolute path on the machine: a file, or a folder of files or images. */
  path: string;
  format: DataFormat;
  /** Column to predict, for tabular data. */
  target?: string;
  steps: PreprocessStep[];
  addedAt: number;
  /** Set when it came from Datasets & models (a Hugging Face or Kaggle download). */
  source?: { hub: "huggingface" | "kaggle"; id: string };
}

// ------------------------------------------------------------ profiles (from converge_data.py)

export interface NumericStats {
  min: number;
  max: number;
  mean: number;
  std: number;
  p01: number;
  p50: number;
  p99: number;
  zeros: number;
  outliers: number;
  integer: boolean;
  hist: { edges: number[]; counts: number[] };
}

export interface ColumnProfile {
  name: string;
  dtype: "numeric" | "boolean" | "categorical" | "text";
  missing: number;
  unique: number;
  sample: string[];
  numeric?: NumericStats;
  top?: { value: string; count: number }[];
  text?: { meanLen: number; maxLen: number; meanWords: number };
  /** |Pearson| with a numeric target; near 1 means the column gives the answer away. */
  targetCorr?: number;
  /** Share of rows whose category always maps to one target value. */
  targetPurity?: number;
}

export interface TabularProfile {
  kind: "tabular";
  format: DataFormat;
  engine: "pandas" | "csv";
  path: string;
  rows: number;
  rowsSampled: number;
  duplicates: number;
  target: string | null;
  columns: ColumnProfile[];
  bytes: number;
  fileCount: number;
}

export interface ImageProfile {
  kind: "images";
  format: "images";
  path: string;
  files: number;
  classes: { name: string; count: number }[];
  splits: string[];
  checked: number;
  corrupt: number;
  sizes: { size: string; count: number }[];
  modes: Record<string, number>;
  pillow: boolean;
  bytes: number;
  fileCount: number;
}

/**
 * Arrays saved with numpy (.npz) or PyTorch (.pt): inputs `x` and optional labels `y`, one file,
 * or train/val/test files in a folder. Any modality fits: token ids, audio, video clips, windows
 * of a time series, latents.
 */
export interface TensorProfile {
  kind: "tensors";
  format: "tensors";
  path: string;
  /** Files by split; a single file is held out for validation by the loader. */
  splits: { name: string; file: string; count: number }[];
  /** Array keys found, e.g. "x" and "y". */
  keys: { x: string; y: string | null };
  /** One example, without the batch dimension. */
  x: { shape: number[]; dtype: string; integer: boolean; min: number | null; max: number | null; mean: number | null; std: number | null };
  y: { shape: number[]; dtype: string; integer: boolean; classes: number | null; counts: { value: string; count: number }[] } | null;
  bytes: number;
  fileCount: number;
}

export type DataProfile = TabularProfile | ImageProfile | TensorProfile;

// ------------------------------------------------------------ preprocessing steps

export type PreprocessStep =
  | { op: "drop_columns"; columns: string[] }
  | { op: "drop_duplicates" }
  | { op: "drop_missing_rows"; columns: string[] }
  | { op: "fill_missing"; columns: string[]; strategy: "mean" | "median" | "mode" | "constant"; value?: string }
  | { op: "clip_outliers"; columns: string[]; lower: number; upper: number }
  | { op: "log1p"; columns: string[] }
  | { op: "encode"; columns: string[]; method: "onehot" | "ordinal" }
  | { op: "scale"; columns: string[]; method: "standard" | "minmax" }
  | { op: "split"; val: number; test: number; stratify: boolean; seed: number }
  | { op: "image_resize"; size: number }
  | { op: "image_augment"; flip: boolean; crop: boolean; colorJitter: boolean }
  | { op: "image_normalize"; mode: "imagenet" | "none" };

export type StepOp = PreprocessStep["op"];

/** Row filters and the split run first; anything learned from the data is fitted on train after the split. */
const ROW_OPS: StepOp[] = ["drop_columns", "drop_duplicates", "drop_missing_rows"];
const FITTED_OPS: StepOp[] = ["fill_missing", "clip_outliers", "log1p", "encode", "scale"];
export const IMAGE_OPS: StepOp[] = ["image_resize", "image_augment", "image_normalize"];

export const STEP_LABEL: Record<StepOp, string> = {
  drop_columns: "Drop columns",
  drop_duplicates: "Drop duplicate rows",
  drop_missing_rows: "Drop rows with missing values",
  fill_missing: "Fill missing values",
  clip_outliers: "Clip outliers",
  log1p: "Log transform",
  encode: "Encode categories",
  scale: "Scale numbers",
  split: "Split train / val / test",
  image_resize: "Resize",
  image_augment: "Augment (training only)",
  image_normalize: "Normalize",
};

export function describeStep(s: PreprocessStep): string {
  const cols = "columns" in s ? (s.columns.length > 3 ? `${s.columns.slice(0, 3).join(", ")} +${s.columns.length - 3}` : s.columns.join(", ")) : "";
  switch (s.op) {
    case "drop_columns":
    case "drop_missing_rows":
    case "log1p":
      return cols;
    case "drop_duplicates":
      return "exact duplicates";
    case "fill_missing":
      return `${cols} with the ${s.strategy === "constant" ? `value ${JSON.stringify(s.value ?? "")}` : s.strategy}`;
    case "clip_outliers":
      return `${cols} to the ${pct(s.lower)}–${pct(s.upper)} percentiles`;
    case "encode":
      return `${cols} as ${s.method === "onehot" ? "one-hot" : "integers"}`;
    case "scale":
      return `${cols} to ${s.method === "standard" ? "mean 0, std 1" : "0–1"}`;
    case "split":
      return `${pct(1 - s.val - s.test)} / ${pct(s.val)} / ${pct(s.test)}${s.stratify ? ", stratified" : ""}, seed ${s.seed}`;
    case "image_resize":
      return `${s.size}×${s.size}`;
    case "image_augment":
      return [s.crop && "random crop", s.flip && "horizontal flip", s.colorJitter && "color jitter"].filter(Boolean).join(", ") || "none";
    case "image_normalize":
      return s.mode === "imagenet" ? "ImageNet mean and std" : "none";
  }
}

const pct = (x: number) => `${Math.round(x * 100)}%`;

// ------------------------------------------------------------ EDA insights

export interface DataInsight {
  severity: "error" | "warning" | "info";
  title: string;
  detail: string;
  column?: string;
  /** A step that addresses it, ready to add to the pipeline. */
  fix?: PreprocessStep;
}

const idLike = (name: string) => /(^|_)(id|uuid|guid|index|idx|key)$/i.test(name) || /^(id|uuid|index|unnamed: ?0)$/i.test(name);

/** Problems the profile shows, most serious first, each with a fix where one fits. */
export function dataInsights(p: DataProfile, steps: PreprocessStep[] = []): DataInsight[] {
  const out: DataInsight[] = [];
  const has = (op: StepOp) => steps.some((s) => s.op === op);
  const covered = (op: StepOp, col: string) => steps.some((s) => s.op === op && "columns" in s && s.columns.includes(col));
  const dropped = (col: string) => covered("drop_columns", col);

  if (p.kind === "images") {
    const counts = p.classes.map((c) => c.count);
    const max = Math.max(...counts, 0);
    const min = Math.min(...counts, max);
    if (p.classes.length <= 1) out.push({ severity: "error", title: "No class folders", detail: "Image classification expects one sub-folder per class, e.g. train/cat/*.jpg and train/dog/*.jpg." });
    if (p.classes.length > 1 && min < max / 5)
      out.push({ severity: "warning", title: "Classes are imbalanced", detail: `The smallest class has ${min} images and the largest ${max}. Use class weights in the loss or oversample the small classes, and judge the model by per-class accuracy.` });
    if (p.corrupt > 0) out.push({ severity: "error", title: `${p.corrupt} of ${p.checked} sampled images can't be opened`, detail: "Corrupt or truncated files crash the data loader mid-epoch. Remove them before training." });
    if (p.sizes.length > 1 && !has("image_resize"))
      out.push({ severity: "warning", title: "Images come in different sizes", detail: `${p.sizes.length} sizes in the sample (most common ${p.sizes[0]!.size}). Batches need one size, so resize them.`, fix: { op: "image_resize", size: 224 } });
    const modes = Object.keys(p.modes);
    if (modes.length > 1) out.push({ severity: "info", title: `Mixed color modes: ${modes.join(", ")}`, detail: "The loader converts everything to RGB, so grayscale and RGBA images become 3-channel." });
    if (!has("image_normalize")) out.push({ severity: "info", title: "Normalize the pixels", detail: "Pretrained models expect ImageNet's mean and std.", fix: { op: "image_normalize", mode: "imagenet" } });
    if (!has("image_augment") && p.files < 50_000) out.push({ severity: "info", title: "Augment a small dataset", detail: `${p.files.toLocaleString()} images is small for training from scratch; random crops and flips reduce overfitting.`, fix: { op: "image_augment", flip: true, crop: true, colorJitter: false } });
    if (!p.pillow) out.push({ severity: "info", title: "Image sizes weren't checked", detail: "Install Pillow on the machine (pip install pillow) to check sizes and find corrupt files." });
    return bySeverity(out);
  }

  if (p.kind === "tensors") {
    const n = p.splits.reduce((a, s) => a + s.count, 0);
    if (!p.y) out.push({ severity: "info", title: "No labels", detail: `Only inputs (${p.keys.x}) were found, so this trains models that rebuild their input (autoencoders) and diffusion models. Save labels as y to train a classifier or regressor.` });
    if (p.y?.classes && p.y.counts.length > 1) {
      const counts = p.y.counts.map((c) => c.count);
      const max = Math.max(...counts);
      const min = Math.min(...counts);
      if (min < max / 5) out.push({ severity: "warning", title: "Classes are imbalanced", detail: `The rarest class has ${min} examples and the most common ${max}. Use class weights or oversampling, and judge the model per class.` });
    }
    if (p.splits.length === 1 && p.splits[0]!.name === "data") out.push({ severity: "info", title: "One file, no validation split", detail: `The loader holds out 10% of the ${n.toLocaleString()} examples for validation. Save train and val files in a folder to choose the split yourself.` });
    if (!p.x.integer && p.x.max != null && p.x.min != null && Math.max(Math.abs(p.x.max), Math.abs(p.x.min)) > 100)
      out.push({ severity: "warning", title: `Inputs range from ${p.x.min.toPrecision(3)} to ${p.x.max.toPrecision(3)}`, detail: "Large raw values slow training or make it diverge. Standardize them (subtract the mean, divide by the std) before saving." });
    return bySeverity(out);
  }

  const n = p.rowsSampled || 1;
  const target = p.target ? p.columns.find((c) => c.name === p.target) : undefined;
  if (!p.target) out.push({ severity: "info", title: "Choose the column to predict", detail: "With a target set, the profile checks class balance and columns that leak the answer, and the split can be stratified." });
  if (target && target.missing > 0) out.push({ severity: "error", title: `The target ${target.name} has ${target.missing} missing values`, detail: "Rows without a label can't be trained on.", column: target.name, fix: { op: "drop_missing_rows", columns: [target.name] } });
  if (target?.top && (target.dtype === "categorical" || target.dtype === "boolean" || (target.numeric?.integer && target.unique <= 20))) {
    const counts = target.top.map((t) => t.count);
    const max = Math.max(...counts);
    const min = Math.min(...counts);
    if (counts.length > 1 && min < max / 5)
      out.push({ severity: "warning", title: `${target.name} is imbalanced`, detail: `The rarest class is ${Math.round((100 * min) / n)}% of the rows. Stratify the split, use class weights, and look at per-class recall rather than accuracy.`, column: target.name });
  }
  if (p.duplicates > 0 && !has("drop_duplicates"))
    out.push({ severity: p.duplicates > n * 0.05 ? "warning" : "info", title: `${p.duplicates.toLocaleString()} duplicate rows in the sample`, detail: "Duplicates can land in both train and validation, making validation look better than it is.", fix: { op: "drop_duplicates" } });

  for (const c of p.columns) {
    if (c.name === p.target || dropped(c.name)) continue;
    const missPct = c.missing / n;
    // A column that gives the answer away: leakage, and a model that will fail in production.
    if ((c.targetCorr !== undefined && Math.abs(c.targetCorr) > 0.98) || (c.targetPurity !== undefined && c.targetPurity > 0.995 && c.unique > 1))
      out.push({ severity: "error", title: `${c.name} predicts ${p.target} almost perfectly`, detail: "That usually means it's computed from the target or recorded after it (leakage). The model would learn it and fail on real data. Drop it unless you're sure it's available at prediction time.", column: c.name, fix: { op: "drop_columns", columns: [c.name] } });
    if (c.unique <= 1) {
      out.push({ severity: "warning", title: `${c.name} has a single value`, detail: "A constant column carries no information.", column: c.name, fix: { op: "drop_columns", columns: [c.name] } });
      continue;
    }
    if (idLike(c.name) && c.unique >= n * 0.95) {
      out.push({ severity: "warning", title: `${c.name} looks like an ID`, detail: "Unique per row, so a model can only memorize it.", column: c.name, fix: { op: "drop_columns", columns: [c.name] } });
      continue;
    }
    if (missPct > 0.5) out.push({ severity: "warning", title: `${c.name} is ${Math.round(missPct * 100)}% missing`, detail: "Mostly empty; filling it invents most of its values. Consider dropping it.", column: c.name, fix: { op: "drop_columns", columns: [c.name] } });
    else if (c.missing > 0 && !covered("fill_missing", c.name) && !covered("drop_missing_rows", c.name))
      out.push({
        severity: "warning",
        title: `${c.name} has ${c.missing.toLocaleString()} missing values (${(missPct * 100).toFixed(1)}%)`,
        detail: c.dtype === "numeric" ? "Fill with the median from the training split (robust to outliers)." : "Fill with the most common value from the training split.",
        column: c.name,
        fix: { op: "fill_missing", columns: [c.name], strategy: c.dtype === "numeric" ? "median" : "mode" },
      });
    if (c.dtype === "categorical" && !covered("encode", c.name)) {
      if (c.unique > 50)
        out.push({ severity: "warning", title: `${c.name} has ${c.unique} categories`, detail: "One-hot encoding would add that many columns. Encode it as integers (for tree models or an embedding), or group rare values.", column: c.name, fix: { op: "encode", columns: [c.name], method: "ordinal" } });
      else out.push({ severity: "info", title: `${c.name} is text categories`, detail: "Neural networks need numbers: one-hot encode it.", column: c.name, fix: { op: "encode", columns: [c.name], method: "onehot" } });
    }
    if (c.dtype === "text") out.push({ severity: "info", title: `${c.name} is free text`, detail: `About ${Math.round(c.text?.meanWords ?? 0)} words per row (longest ${c.text?.maxLen ?? 0} characters). Tokenize it for a text model, or drop it for a tabular one.`, column: c.name });
    const s = c.numeric;
    if (s && c.dtype === "numeric") {
      if (s.min >= 0 && s.p99 > 0 && s.mean > 3 * s.p50 && s.p50 > 0 && !covered("log1p", c.name))
        out.push({ severity: "info", title: `${c.name} is heavily skewed`, detail: `The mean (${fmt(s.mean)}) is far above the median (${fmt(s.p50)}). A log transform makes it easier to learn.`, column: c.name, fix: { op: "log1p", columns: [c.name] } });
      if (s.outliers > n * 0.01 && !covered("clip_outliers", c.name))
        out.push({ severity: "info", title: `${c.name} has outliers`, detail: `${s.outliers.toLocaleString()} values sit far outside the middle 50% (range ${fmt(s.min)} to ${fmt(s.max)}). Clipping to the 1st–99th percentiles keeps them from dominating.`, column: c.name, fix: { op: "clip_outliers", columns: [c.name], lower: 0.01, upper: 0.99 } });
    }
  }

  // Columns this pass already suggests dropping aren't worth scaling.
  const toDrop = new Set(out.flatMap((i) => (i.fix?.op === "drop_columns" ? i.fix.columns : [])));
  const numeric = p.columns.filter((c) => c.dtype === "numeric" && c.name !== p.target && !dropped(c.name) && !toDrop.has(c.name) && c.numeric);
  const scaled = new Set(steps.flatMap((s) => (s.op === "scale" ? s.columns : [])));
  const unscaled = numeric.filter((c) => !scaled.has(c.name));
  if (unscaled.length >= 2) {
    const ranges = unscaled.map((c) => c.numeric!.p99 - c.numeric!.p01).filter((r) => r > 0);
    if (ranges.length >= 2 && Math.max(...ranges) / Math.min(...ranges) > 100)
      out.push({ severity: "warning", title: "Numeric columns are on very different scales", detail: "Neural networks train poorly when one input is in the thousands and another below one. Standardize them (fitted on the training split).", fix: { op: "scale", columns: unscaled.map((c) => c.name), method: "standard" } });
    else
      out.push({ severity: "info", title: `Standardize the ${unscaled.length} numeric columns`, detail: "Neural networks and linear models train faster and more reliably on inputs with mean 0 and std 1. Tree models don't need it.", fix: { op: "scale", columns: unscaled.map((c) => c.name), method: "standard" } });
  }
  if (!has("split"))
    out.push({ severity: "info", title: "Hold out validation and test data", detail: "Split before anything is fitted, so validation stays unseen.", fix: { op: "split", val: 0.1, test: 0.1, stratify: !!target && target.dtype !== "numeric", seed: 0 } });
  return bySeverity(out);
}

const RANK = { error: 0, warning: 1, info: 2 } as const;
const bySeverity = (xs: DataInsight[]) => xs.sort((a, b) => RANK[a.severity] - RANK[b.severity]);

const fmt = (v: number) => (Math.abs(v) >= 1e5 || (Math.abs(v) < 1e-3 && v !== 0) ? v.toExponential(2) : Number(v.toPrecision(4)).toString());

// ------------------------------------------------------------ generated code

export function dataStem(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "") || "dataset";
}

const pyList = (xs: string[]) => `[${xs.map((x) => JSON.stringify(x)).join(", ")}]`;

/**
 * A machine path as Python source. Paths in a home folder become os.path.expanduser("~/..."), so
 * generated code works for another person (their home is /home/<them>), e.g. when a run is shared.
 */
export function pyPath(p: string): string {
  const m = /^\/(?:home\/[^/]+|root|Users\/[^/]+)(\/.*)?$/.exec(p);
  return m ? `os.path.expanduser(${JSON.stringify("~" + (m[1] ?? ""))})` : JSON.stringify(p);
}

/**
 * Python that downloads a dataset again when it isn't on the machine (someone else's machine, a new
 * cloud pod), from where Datasets & models got it. Empty when the source isn't known.
 */
export function fetchDataCode(d: DatasetRef): string[] {
  const src = d.source;
  if (!src) return [];
  if (src.hub === "huggingface") {
    const i = d.path.indexOf(`/${src.id}`);
    const root = i >= 0 ? d.path.slice(0, i + src.id.length + 1) : d.path;
    return [
      `def fetch_data():`,
      `    """Downloads ${src.id} from Hugging Face, where it came from, when it isn't on this machine."""`,
      `    from huggingface_hub import snapshot_download`,
      `    print("Downloading ${src.id} from Hugging Face (not on this machine yet)", flush=True)`,
      `    snapshot_download(repo_id=${JSON.stringify(src.id)}, repo_type="dataset", local_dir=${pyPath(root)})`,
      ``,
      ``,
    ];
  }
  const i = d.path.indexOf(`/datasets/${src.id}`);
  if (i < 0) return [];
  return [
    `def fetch_data():`,
    `    """Downloads ${src.id} from Kaggle, where it came from, when it isn't on this machine."""`,
    `    os.environ.setdefault("KAGGLEHUB_CACHE", ${pyPath(d.path.slice(0, i))})`,
    `    import kagglehub`,
    `    print("Downloading ${src.id} from Kaggle (not on this machine yet)", flush=True)`,
    `    kagglehub.dataset_download(${JSON.stringify(src.id)})`,
    ``,
    ``,
  ];
}

/**
 * Where the processed files go on the machine: <name>_processed/ beside the input, never inside
 * it (a folder dataset would otherwise read its own output back in as more data).
 */
export function processedDir(d: DatasetRef): string {
  const base = d.path.replace(/\/+$/, "");
  const parent = base.includes("/") ? base.replace(/\/[^/]*$/, "") || "/" : ".";
  return `${parent === "/" ? "" : parent}/${dataStem(d.name)}_processed`;
}

/**
 * The preprocessing script. Row filters run first; then the split; then each fitted step learns
 * its statistics on the training split and applies them to every split, so nothing about
 * validation or test leaks into training. `--preview N` processes the first N rows and prints a
 * JSON summary instead of writing files.
 */
export function generatePreprocessCode(d: DatasetRef): string {
  const tab = d.steps.filter((s) => !IMAGE_OPS.includes(s.op));
  const rows = tab.filter((s) => ROW_OPS.includes(s.op));
  const split = tab.find((s): s is Extract<PreprocessStep, { op: "split" }> => s.op === "split");
  // Fitted steps always run fill → clip → log → encode → scale: clipping or logging after
  // scaling would work on already-scaled values, and scaling before encoding misses the dummies.
  const fitted = tab.filter((s) => FITTED_OPS.includes(s.op)).sort((x, y) => FITTED_OPS.indexOf(x.op) - FITTED_OPS.indexOf(y.op));
  const L: string[] = [];
  const add = (...xs: string[]) => L.push(...xs);
  add(
    `"""Preprocessing for ${d.name}, generated by Converlt.`,
    ``,
    `Row filters run first, then the split. Everything learned from the data (fill values,`,
    `percentiles, categories, means) is fitted on the training split only and applied to all`,
    `splits, so validation and test never leak into training. The fitted values are saved in`,
    `preprocess_state.json for use at prediction time.`,
    ``,
    `    python data/preprocess_${dataStem(d.name)}.py                # writes the processed splits`,
    `    python data/preprocess_${dataStem(d.name)}.py --preview 200  # dry run on 200 rows, prints JSON`,
    `"""`,
    `import argparse, glob, json, os`,
    `import numpy as np`,
    `import pandas as pd`,
    `try:`,
    `    import converge`,
    `except ImportError:`,
    `    converge = None`,
    ``,
    `p = argparse.ArgumentParser()`,
    `p.add_argument("--input", default=${pyPath(d.path)})`,
    `p.add_argument("--output", default=${pyPath(processedDir(d))})`,
    `p.add_argument("--preview", type=int, default=0)`,
    `a = p.parse_args()`,
    `TARGET = ${d.target ? JSON.stringify(d.target) : "None"}`,
    ``,
    ``,
    ...fetchDataCode(d),
    `def load(path, nrows=None):`,
    ...(d.source ? [`    if not os.path.exists(path):`, `        fetch_data()`] : []),
    `    # Converlt's own outputs (<name>_processed folders, preprocess_state.json) are never input data.`,
    `    files = [path] if os.path.isfile(path) else sorted(f for f in glob.glob(os.path.join(path, "**", "*"), recursive=True) if f.lower().endswith((".csv", ".tsv", ".parquet", ".pq", ".jsonl", ".ndjson", ".json")) and not any(part.endswith("_processed") for part in os.path.relpath(f, path).split(os.sep)) and os.path.basename(f) != "preprocess_state.json")`,
    `    frames = []`,
    `    for f in files:`,
    `        ext = os.path.splitext(f)[1].lower()`,
    `        if ext in (".parquet", ".pq"):`,
    `            df = pd.read_parquet(f)`,
    `        elif ext in (".jsonl", ".ndjson"):`,
    `            df = pd.read_json(f, lines=True, nrows=nrows)`,
    `        elif ext == ".json":`,
    `            df = pd.read_json(f)`,
    `        else:`,
    `            df = pd.read_csv(f, sep="\\t" if ext == ".tsv" else ",", nrows=nrows, low_memory=False)`,
    `        frames.append(df)`,
    `        if nrows and sum(len(x) for x in frames) >= nrows:`,
    `            break`,
    `    df = pd.concat(frames, ignore_index=True)`,
    `    return df.head(nrows) if nrows else df`,
    ``,
    ``,
    `df = load(a.input, a.preview or None)`,
    `before = df.copy()`,
    `state = {"target": TARGET, "steps": []}`,
    ``,
  );
  if (rows.length) add(`# Row filters`);
  for (const s of rows) {
    if (s.op === "drop_columns") add(`df = df.drop(columns=${pyList(s.columns)}, errors="ignore")`);
    if (s.op === "drop_duplicates") add(`df = df.drop_duplicates().reset_index(drop=True)`);
    if (s.op === "drop_missing_rows") add(`df = df.dropna(subset=${pyList(s.columns)}).reset_index(drop=True)`);
  }
  add(``, `# Split before fitting anything`);
  if (split) {
    add(
      `rng = np.random.default_rng(${split.seed})`,
      `groups = [g.index.to_numpy() for _, g in df.groupby(TARGET, dropna=False)] if ${split.stratify && d.target ? "True" : "False"} else [df.index.to_numpy()]`,
      `parts = {"train": [], "val": [], "test": []}`,
      `for idx in groups:`,
      `    idx = rng.permutation(idx)`,
      `    n_test, n_val = int(round(len(idx) * ${split.test})), int(round(len(idx) * ${split.val}))`,
      `    parts["test"].append(idx[:n_test])`,
      `    parts["val"].append(idx[n_test:n_test + n_val])`,
      `    parts["train"].append(idx[n_test + n_val:])`,
      `splits = {k: df.loc[np.concatenate(v)].reset_index(drop=True) for k, v in parts.items() if sum(len(x) for x in v)}`,
    );
  } else add(`splits = {"data": df}`);
  add(`fit = splits.get("train", next(iter(splits.values())))`, ``);
  if (fitted.length) add(`# Fitted on the training split, applied to every split`);
  for (const s of fitted) {
    const cols = "columns" in s ? pyList(s.columns) : "[]";
    switch (s.op) {
      case "fill_missing": {
        const value =
          s.strategy === "constant"
            ? `${JSON.stringify(s.value ?? "")}`
            : s.strategy === "mode"
              ? `fit[c].mode(dropna=True).iloc[0] if fit[c].notna().any() else None`
              : `float(fit[c].${s.strategy}()) if fit[c].notna().any() else 0.0`;
        add(
          `fills = {c: ${value} for c in ${cols} if c in fit}`,
          `for name in splits:`,
          `    splits[name] = splits[name].fillna(fills)`,
          `state["steps"].append({"op": "fill_missing", "values": fills})`,
        );
        break;
      }
      case "clip_outliers":
        add(
          `bounds = {c: [float(fit[c].quantile(${s.lower})), float(fit[c].quantile(${s.upper}))] for c in ${cols} if c in fit}`,
          `for name in splits:`,
          `    for c, (lo, hi) in bounds.items():`,
          `        splits[name][c] = splits[name][c].clip(lo, hi)`,
          `state["steps"].append({"op": "clip_outliers", "bounds": bounds})`,
        );
        break;
      case "log1p":
        add(
          `for name in splits:`,
          `    for c in ${cols}:`,
          `        if c in splits[name]:`,
          `            splits[name][c] = np.log1p(splits[name][c].clip(lower=0))`,
          `state["steps"].append({"op": "log1p", "columns": ${cols}})`,
        );
        break;
      case "encode":
        if (s.method === "onehot")
          add(
            `cats = {c: sorted(fit[c].dropna().astype(str).unique().tolist()) for c in ${cols} if c in fit}`,
            `for name in splits:`,
            `    s = splits[name]`,
            `    for c, values in cats.items():`,
            `        # Categories unseen in training become all zeros rather than new columns.`,
            `        onehot = pd.get_dummies(pd.Categorical(s[c].astype(str).where(s[c].notna()), categories=values), prefix=c, dtype="float32")`,
            `        onehot.index = s.index`,
            `        s = pd.concat([s.drop(columns=[c]), onehot], axis=1)`,
            `    splits[name] = s`,
            `state["steps"].append({"op": "onehot", "categories": cats})`,
          );
        else
          add(
            `codes = {c: {v: i for i, v in enumerate(sorted(fit[c].dropna().astype(str).unique().tolist()))} for c in ${cols} if c in fit}`,
            `for name in splits:`,
            `    for c, mapping in codes.items():`,
            `        splits[name][c] = splits[name][c].astype(str).map(mapping).fillna(-1).astype("int64")  # unseen: -1`,
            `state["steps"].append({"op": "ordinal", "codes": codes})`,
          );
        break;
      case "scale":
        if (s.method === "standard")
          add(
            `stats = {c: [float(fit[c].mean()), float(fit[c].std(ddof=0)) or 1.0] for c in ${cols} if c in fit}`,
            `for name in splits:`,
            `    for c, (mean, std) in stats.items():`,
            `        splits[name][c] = (splits[name][c] - mean) / std`,
            `state["steps"].append({"op": "standardize", "mean_std": stats})`,
          );
        else
          add(
            `stats = {c: [float(fit[c].min()), float(fit[c].max() - fit[c].min()) or 1.0] for c in ${cols} if c in fit}`,
            `for name in splits:`,
            `    for c, (lo, span) in stats.items():`,
            `        splits[name][c] = (splits[name][c] - lo) / span`,
            `state["steps"].append({"op": "minmax", "min_span": stats})`,
          );
        break;
    }
  }
  if (d.target)
    add(
      ``,
      `# Text labels become class indices, in a fixed order saved with the state.`,
      `if TARGET in fit and not pd.api.types.is_numeric_dtype(fit[TARGET]):`,
      `    classes = sorted(fit[TARGET].dropna().astype(str).unique().tolist())`,
      `    for name in splits:`,
      `        splits[name][TARGET] = splits[name][TARGET].astype(str).map({c: i for i, c in enumerate(classes)})`,
      `    state["classes"] = classes`,
    );
  add(
    ``,
    `def rows(frame, n=8):`,
    `    return json.loads(frame.head(n).to_json(orient="records", default_handler=str))`,
    ``,
    ``,
    `if a.preview:`,
    `    out = next(iter(splits.values()))`,
    `    print(json.dumps({`,
    `        "before": {"columns": [str(c) for c in before.columns], "rows": rows(before), "shape": list(before.shape)},`,
    `        "after": {"columns": [str(c) for c in out.columns], "rows": rows(out), "shape": list(out.shape)},`,
    `        "splits": {k: len(v) for k, v in splits.items()},`,
    `        "missing": int(sum(int(v.isna().sum().sum()) for v in splits.values())),`,
    `        "nonNumeric": [str(c) for c in out.columns if c != TARGET and not pd.api.types.is_numeric_dtype(out[c])],`,
    `    }))`,
    `    raise SystemExit(0)`,
    ``,
    `os.makedirs(a.output, exist_ok=True)`,
    `try:`,
    `    import pyarrow  # noqa: F401`,
    `    ext = "parquet"`,
    `except ImportError:`,
    `    ext = "csv"`,
    `run = converge.run(config={"input": a.input, "output": a.output, "steps": len(state["steps"])}) if converge else None`,
    `if run:`,
    `    run.log_dataset(a.input, name="raw")`,
    `for name, frame in splits.items():`,
    `    path = os.path.join(a.output, "%s.%s" % (name, ext))`,
    `    frame.to_parquet(path, index=False) if ext == "parquet" else frame.to_csv(path, index=False)`,
    `    print("%s: %d rows x %d columns -> %s" % (name, len(frame), frame.shape[1], path))`,
    `    if run:`,
    `        run.log_dataset(path, name=name)`,
    `with open(os.path.join(a.output, "preprocess_state.json"), "w") as f:`,
    `    json.dump(state, f, indent=1, default=str)`,
    `print("done")`,
    ``,
  );
  return L.join("\n");
}

/** DataLoaders for training: the processed splits (tabular) or the image folder with transforms. */
export function generateLoaderCode(d: DatasetRef, p?: DataProfile | null): string {
  const stem = dataStem(d.name);
  if (d.format === "tensors") return tensorLoaderCode(d, p?.kind === "tensors" ? p : null);
  if (d.format === "images") {
    const resize = d.steps.find((s): s is Extract<PreprocessStep, { op: "image_resize" }> => s.op === "image_resize")?.size ?? 224;
    const aug = d.steps.find((s): s is Extract<PreprocessStep, { op: "image_augment" }> => s.op === "image_augment");
    const norm = d.steps.find((s): s is Extract<PreprocessStep, { op: "image_normalize" }> => s.op === "image_normalize")?.mode === "imagenet";
    const classes = p?.kind === "images" ? p.classes.length : null;
    const train = [aug?.crop ? `transforms.RandomResizedCrop(SIZE, scale=(0.6, 1.0))` : `transforms.Resize((SIZE, SIZE))`, aug?.flip && `transforms.RandomHorizontalFlip()`, aug?.colorJitter && `transforms.ColorJitter(0.2, 0.2, 0.2)`, `transforms.ToTensor()`, norm && `NORMALIZE`].filter(Boolean);
    const evalT = [`transforms.Resize((SIZE, SIZE))`, `transforms.ToTensor()`, norm && `NORMALIZE`].filter(Boolean);
    return [
      `"""DataLoaders for ${d.name} (image folder), generated by Converlt.`,
      ``,
      `    from data.${stem}_loader import make_loaders, NUM_CLASSES, INPUT_SHAPE`,
      `    loaders = make_loaders(batch_size=64)`,
      `    for images, labels in loaders["train"]: ...`,
      `"""`,
      `import os`,
      `import torch`,
      `from torch.utils.data import DataLoader, Subset`,
      `from torchvision import datasets, transforms`,
      ``,
      `ROOT = ${pyPath(d.path)}`,
      `SIZE = ${resize}`,
      `INPUT_SHAPE = (3, SIZE, SIZE)`,
      `NUM_CLASSES = ${classes ?? "None  # set after profiling"}`,
      `NORMALIZE = transforms.Normalize([0.485, 0.456, 0.406], [0.229, 0.224, 0.225])`,
      `TRAIN_TRANSFORM = transforms.Compose([${train.join(", ")}])`,
      `EVAL_TRANSFORM = transforms.Compose([${evalT.join(", ")}])`,
      ``,
      ``,
      ...fetchDataCode(d),
      `def make_loaders(batch_size=64, num_workers=None, val_fraction=0.1, seed=0):`,
      ...(d.source ? [`    if not os.path.isdir(ROOT):`, `        fetch_data()`] : []),
      `    # Loading and decoding images is CPU work: parallel workers keep the GPU fed.`,
      `    workers = num_workers if num_workers is not None else min(8, max(2, (os.cpu_count() or 4) // 2))`,
      `    kw = dict(batch_size=batch_size, num_workers=workers, pin_memory=torch.cuda.is_available(), persistent_workers=workers > 0)`,
      `    split = {s: os.path.join(ROOT, s) for s in ("train", "val", "valid", "validation", "test") if os.path.isdir(os.path.join(ROOT, s))}`,
      `    loaders = {}`,
      `    for name in ("val", "valid", "validation", "test"):`,
      `        if name in split:`,
      `            loaders["test" if name == "test" else "val"] = DataLoader(datasets.ImageFolder(split[name], EVAL_TRANSFORM), **kw)`,
      `    train_dir = split.get("train", ROOT)`,
      `    if "val" in loaders:`,
      `        loaders["train"] = DataLoader(datasets.ImageFolder(train_dir, TRAIN_TRANSFORM), shuffle=True, drop_last=True, **kw)`,
      `        return loaders`,
      `    # No validation folder: hold out a fixed random share of the training images, evaluated without augmentation.`,
      `    train_set, eval_set = datasets.ImageFolder(train_dir, TRAIN_TRANSFORM), datasets.ImageFolder(train_dir, EVAL_TRANSFORM)`,
      `    order = torch.randperm(len(train_set), generator=torch.Generator().manual_seed(seed)).tolist()`,
      `    n_val = max(1, int(len(order) * val_fraction))`,
      `    loaders["train"] = DataLoader(Subset(train_set, order[n_val:]), shuffle=True, drop_last=True, **kw)`,
      `    loaders["val"] = DataLoader(Subset(eval_set, order[:n_val]), **kw)`,
      `    return loaders`,
      ``,
    ].join("\n");
  }
  const target = d.target;
  const tp = p?.kind === "tabular" && target ? p.columns.find((c) => c.name === target) : undefined;
  const classification = !tp || tp.dtype !== "numeric" || (tp.numeric?.integer && tp.unique <= 50);
  return [
    `"""DataLoaders for ${d.name}, reading the splits preprocess_${stem}.py wrote. Generated by Converlt.`,
    ``,
    `    from data.${stem}_loader import make_loaders, input_shape`,
    `    loaders = make_loaders(batch_size=256)`,
    `    for features, ${target ? "labels" : "batch"} in loaders["train"]: ...`,
    `"""`,
    `import json`,
    `import os`,
    `import pandas as pd`,
    `import torch`,
    `from torch.utils.data import DataLoader, TensorDataset`,
    ``,
    `DATA_DIR = ${pyPath(processedDir(d))}`,
    `TARGET = ${target ? JSON.stringify(target) : "None"}`,
    `TASK = ${JSON.stringify(classification ? "classification" : "regression")}`,
    ``,
    ``,
    `def read(split):`,
    `    for ext in ("parquet", "csv"):`,
    `        path = os.path.join(DATA_DIR, "%s.%s" % (split, ext))`,
    `        if os.path.exists(path):`,
    `            return pd.read_parquet(path) if ext == "parquet" else pd.read_csv(path)`,
    `    return None`,
    ``,
    ``,
    `def tensors(df):`,
    `    x = df.drop(columns=[TARGET]) if TARGET else df`,
    `    bad = [c for c in x.columns if not pd.api.types.is_numeric_dtype(x[c])]`,
    `    if bad:`,
    `        raise ValueError("these columns aren't numbers yet; encode or drop them in preprocessing: %s" % ", ".join(map(str, bad)))`,
    `    features = torch.tensor(x.to_numpy(dtype="float32"))`,
    `    if not TARGET:`,
    `        return (features,)`,
    `    return features, torch.tensor(df[TARGET].to_numpy(), dtype=torch.long if TASK == "classification" else torch.float32)`,
    ``,
    ``,
    `def input_shape():`,
    `    df = read("train") if read("train") is not None else read("data")`,
    `    return (df.shape[1] - (1 if TARGET else 0),)`,
    ``,
    ``,
    `def class_names():`,
    `    """Label names in class-index order, as preprocessing encoded them (None if it didn't)."""`,
    `    try:`,
    `        with open(os.path.join(DATA_DIR, "preprocess_state.json")) as f:`,
    `            state = json.load(f)`,
    `    except (OSError, ValueError):`,
    `        return None`,
    `    if state.get("classes"):`,
    `        return state["classes"]`,
    `    for step in state.get("steps", []):  # the target was encoded as integers in the pipeline`,
    `        codes = (step.get("codes") or {}).get(TARGET) if step.get("op") == "ordinal" else None`,
    `        if codes:`,
    `            return [v for v, _ in sorted(codes.items(), key=lambda kv: kv[1])]`,
    `    return None`,
    ``,
    ``,
    `def make_loaders(batch_size=256):`,
    `    if not os.path.isdir(DATA_DIR):  # e.g. on another machine: write the processed splits first`,
    `        prep = os.path.join(os.path.dirname(os.path.abspath(__file__)), ${JSON.stringify(`preprocess_${stem}.py`)})`,
    `        if os.path.exists(prep):`,
    `            import subprocess, sys`,
    `            print("Processed data not found at %s; running %s" % (DATA_DIR, prep), flush=True)`,
    `            env = {k: v for k, v in os.environ.items() if k != "CONVERGE_SDK_FILE"}  # its settings aren't the run's`,
    `            subprocess.check_call([sys.executable, prep], env=env)`,
    `    # The data is already in memory as tensors, so worker processes would only add overhead.`,
    `    loaders, names = {}, class_names()`,
    `    for split in ("train", "val", "test", "data"):`,
    `        df = read(split)`,
    `        if df is not None:`,
    `            ds = TensorDataset(*tensors(df))`,
    `            ds.classes = names`,
    `            loaders["train" if split == "data" else split] = DataLoader(ds, batch_size=batch_size, shuffle=split in ("train", "data"), pin_memory=torch.cuda.is_available())`,
    `    return loaders`,
    ``,
  ].join("\n");
}

function tensorLoaderCode(d: DatasetRef, p: TensorProfile | null): string {
  const stem = dataStem(d.name);
  const task = p?.y ? (p.y.classes ? "classification" : "regression") : "none";
  const files = p?.splits.length ? Object.fromEntries(p.splits.map((s) => [s.name, s.file])) : { data: d.path };
  return [
    `"""DataLoaders for ${d.name} (arrays in .npz / .pt files), generated by Converlt.`,
    ``,
    `    from data.${stem}_loader import make_loaders, INPUT_SHAPE, NUM_CLASSES, TASK`,
    `    loaders = make_loaders(batch_size=64)`,
    `    for x${task === "none" ? "" : ", y"} in loaders["train"]: ...`,
    `"""`,
    `import os`,
    `import numpy as np`,
    `import torch`,
    `from torch.utils.data import DataLoader, Subset, TensorDataset`,
    ``,
    `FILES = {${Object.entries(files).map(([k, v]) => `${JSON.stringify(k)}: ${pyPath(v)}`).join(", ")}}`,
    `X_KEY = ${JSON.stringify(p?.keys.x ?? "x")}`,
    `Y_KEY = ${p?.keys.y ? JSON.stringify(p.keys.y) : "None"}`,
    `INPUT_SHAPE = (${(p?.x.shape ?? []).join(", ")}${p?.x.shape.length === 1 ? "," : ""})`,
    `INPUT_DTYPE = ${p?.x.integer ? "torch.long" : "torch.float32"}`,
    `NUM_CLASSES = ${p?.y?.classes ?? "None"}`,
    `TASK = ${JSON.stringify(task)}`,
    ``,
    ``,
    `def load(path):`,
    `    if path.endswith(".npz"):`,
    `        with np.load(path) as f:`,
    `            x, y = f[X_KEY], (f[Y_KEY] if Y_KEY else None)`,
    `        x, y = torch.from_numpy(x), (torch.from_numpy(y) if y is not None else None)`,
    `    else:`,
    `        obj = torch.load(path, weights_only=True)`,
    `        x, y = (obj[X_KEY], obj[Y_KEY] if Y_KEY else None) if isinstance(obj, dict) else (obj[0], obj[1] if len(obj) > 1 else None)`,
    `    x = x.to(INPUT_DTYPE)`,
    `    if y is None:`,
    `        return TensorDataset(x)`,
    `    return TensorDataset(x, y.long() if TASK == "classification" else y.float())`,
    ``,
    ``,
    `def make_loaders(batch_size=64, val_fraction=0.1, seed=0):`,
    `    sets = {name: load(path) for name, path in FILES.items()}`,
    `    if "data" in sets:  # one file: hold out a fixed random share for validation`,
    `        full = sets.pop("data")`,
    `        order = torch.randperm(len(full), generator=torch.Generator().manual_seed(seed)).tolist()`,
    `        n_val = max(1, int(len(order) * val_fraction))`,
    `        sets["train"], sets["val"] = Subset(full, order[n_val:]), Subset(full, order[:n_val])`,
    `    if "valid" in sets or "validation" in sets:`,
    `        sets["val"] = sets.pop("valid", None) or sets.pop("validation")`,
    `    pin = torch.cuda.is_available()`,
    `    return {name: DataLoader(ds, batch_size=batch_size, shuffle=name == "train", drop_last=name == "train" and len(ds) > batch_size, pin_memory=pin) for name, ds in sets.items()}`,
    ``,
  ].join("\n");
}

// ------------------------------------------------------------ what a dataset feeds a model

export type DataTask = "classification" | "regression" | "none";

/** What one example looks like to a model, and what it should predict. */
export interface DataSpec {
  kind: "tabular" | "images" | "tensors";
  /** Without the batch dimension; null until the dataset is profiled. */
  inputShape: number[] | null;
  inputDtype: "float" | "long";
  task: DataTask;
  /** Classes for classification; null otherwise or when unknown. */
  classes: number | null;
  /** Shape of one label: [] for one class or value per example, [L] for one per token/frame. */
  targetShape: number[];
  /** Images come from ToTensor in [0, 1] (not normalized). */
  unitRange: boolean;
  /** For token ids: the largest id + 1, which an Embedding's vocabulary must cover. */
  vocab: number | null;
  /** Why the dataset can't train a model yet, if it can't (not profiled, columns still text...). */
  blockers: string[];
  /** Short description, e.g. "3×64×64 images · 10 classes". */
  summary: string;
}

/** Reads a dataset's profile and preprocessing into what it feeds a model. */
export function datasetSpec(d: DatasetRef, p: DataProfile | null): DataSpec {
  const blockers: string[] = [];
  if (!p) blockers.push(`Profile ${d.name} in Data first (Explore), so its shapes and classes are known.`);
  if (d.format === "images" || p?.kind === "images") {
    const size = d.steps.find((s): s is Extract<PreprocessStep, { op: "image_resize" }> => s.op === "image_resize")?.size ?? 224;
    const normalized = d.steps.some((s) => s.op === "image_normalize" && s.mode === "imagenet");
    const classes = p?.kind === "images" ? p.classes.filter((c) => c.name !== "(no class folder)").length : null;
    if (p?.kind === "images" && !classes) blockers.push(`${d.name} has no class folders: put each class's images in its own folder.`);
    return { kind: "images", inputShape: [3, size, size], inputDtype: "float", task: "classification", classes, targetShape: [], unitRange: !normalized, vocab: null, blockers, summary: `3×${size}×${size} images${classes ? ` · ${classes} classes` : ""}` };
  }
  if (d.format === "tensors" || p?.kind === "tensors") {
    const t = p?.kind === "tensors" ? p : null;
    const task: DataTask = !t?.y ? "none" : t.y.classes ? "classification" : "regression";
    const shape = t ? t.x.shape : null;
    return {
      kind: "tensors",
      inputShape: shape,
      inputDtype: t?.x.integer ? "long" : "float",
      task,
      classes: t?.y?.classes ?? null,
      targetShape: t?.y?.shape ?? [],
      unitRange: false,
      vocab: t?.x.integer && t.x.max != null ? t.x.max + 1 : null,
      blockers,
      summary: t ? `${shape!.join("×")} ${t.x.integer ? "ids" : "arrays"}${task === "classification" ? ` · ${t.y!.classes} classes` : task === "regression" ? ` · predicts ${t.y!.shape.length ? t.y!.shape.join("×") + " values" : "a value"}` : " · no labels"}` : "arrays",
    };
  }
  // Tables: the columns that reach the model after preprocessing.
  const tab = p?.kind === "tabular" ? p : null;
  const target = d.target ? tab?.columns.find((c) => c.name === d.target) : undefined;
  const dropped = new Set(d.steps.flatMap((s) => (s.op === "drop_columns" ? s.columns : [])));
  const onehot = new Set(d.steps.flatMap((s) => (s.op === "encode" && s.method === "onehot" ? s.columns : [])));
  const encoded = new Set(d.steps.flatMap((s) => (s.op === "encode" ? s.columns : [])));
  let features = 0;
  const text: string[] = [];
  for (const c of tab?.columns ?? []) {
    if (c.name === d.target || dropped.has(c.name)) continue;
    if (onehot.has(c.name)) features += Math.max(1, c.unique);
    else {
      features += 1;
      if ((c.dtype === "categorical" || c.dtype === "text") && !encoded.has(c.name)) text.push(c.name);
    }
  }
  if (text.length) blockers.push(`Columns ${text.slice(0, 4).join(", ")}${text.length > 4 ? "…" : ""} are still text: encode or drop them in Data → Preprocess.`);
  const classification = !!target && (target.dtype !== "numeric" || (!!target.numeric?.integer && target.unique <= 50));
  const classes = classification ? target!.unique : null;
  const task: DataTask = !d.target ? "none" : classification ? "classification" : "regression";
  return {
    kind: "tabular",
    inputShape: tab ? [features] : null,
    inputDtype: "float",
    task,
    classes,
    targetShape: [],
    unitRange: false,
    vocab: null,
    blockers,
    summary: tab ? `${features} features${task === "classification" ? ` · ${classes} classes` : task === "regression" ? ` · predicts ${d.target}` : ""}` : "table",
  };
}

/** The step a palette button adds, with sensible defaults for the profiled columns. */
export function defaultStep(op: StepOp, p: DataProfile | null, target?: string): PreprocessStep {
  const cols = p?.kind === "tabular" ? p.columns.filter((c) => c.name !== target) : [];
  const numeric = cols.filter((c) => c.dtype === "numeric").map((c) => c.name);
  const categorical = cols.filter((c) => c.dtype === "categorical").map((c) => c.name);
  const missing = cols.filter((c) => c.missing > 0).map((c) => c.name);
  switch (op) {
    case "drop_columns":
      return { op, columns: [] };
    case "drop_duplicates":
      return { op };
    case "drop_missing_rows":
      return { op, columns: missing };
    case "fill_missing":
      return { op, columns: missing.filter((m) => numeric.includes(m)), strategy: "median" };
    case "clip_outliers":
      return { op, columns: numeric, lower: 0.01, upper: 0.99 };
    case "log1p":
      return { op, columns: [] };
    case "encode":
      return { op, columns: categorical, method: "onehot" };
    case "scale":
      return { op, columns: numeric, method: "standard" };
    case "split":
      return { op, val: 0.1, test: 0.1, stratify: !!target, seed: 0 };
    case "image_resize":
      return { op, size: 224 };
    case "image_augment":
      return { op, flip: true, crop: true, colorJitter: false };
    case "image_normalize":
      return { op, mode: "imagenet" };
  }
}
