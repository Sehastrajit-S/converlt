// The model builder's graph: layers dropped on a canvas and wired together. This module checks
// the graph (shapes flow, ports fit, no cycles), counts parameters, and writes the PyTorch module
// and a quick training script. Shapes leave out the batch dimension.

export type LayerType =
  | "Input"
  | "Linear"
  | "Conv1d"
  | "Conv2d"
  | "Conv3d"
  | "ConvTranspose2d"
  | "Upsample"
  | "MaxPool1d"
  | "MaxPool2d"
  | "MaxPool3d"
  | "AvgPool2d"
  | "AdaptiveAvgPool1d"
  | "AdaptiveAvgPool2d"
  | "AdaptiveAvgPool3d"
  | "Reshape"
  | "Permute"
  | "PositionEmbedding"
  | "BatchNorm"
  | "LayerNorm"
  | "Dropout"
  | "ReLU"
  | "GELU"
  | "SiLU"
  | "LeakyReLU"
  | "Tanh"
  | "Sigmoid"
  | "Softmax"
  | "Flatten"
  | "Embedding"
  | "LSTM"
  | "GRU"
  | "MultiheadAttention"
  | "TransformerEncoderLayer"
  | "SequencePool"
  | "Add"
  | "Concat"
  | "Timestep"
  | "Custom"
  | "Output";

export type ParamValue = number | string | boolean;

export interface LayerNode {
  id: string;
  type: LayerType;
  params: Record<string, ParamValue>;
  x: number;
  y: number;
}

export interface Edge {
  from: string;
  to: string;
}

export interface ModelGraph {
  name: string;
  nodes: LayerNode[];
  edges: Edge[];
  /** Id of the Data-section dataset this model trains on. */
  dataset?: string;
}

export interface ParamSpec {
  key: string;
  label: string;
  kind: "int" | "float" | "bool" | "choice" | "shape";
  default: ParamValue;
  choices?: string[];
  min?: number;
  hint?: string;
}

export interface LayerSpec {
  type: LayerType;
  group: "Input / output" | "Dense" | "Convolution" | "Pooling" | "Normalization" | "Activation" | "Sequence" | "Shape" | "Combine";
  label: string;
  /** One line for the palette. */
  blurb: string;
  params: ParamSpec[];
  /** Inputs it takes: 0 (Input), 1, or many (Add, Concat). */
  inputs: 0 | 1 | "many";
  /** Not offered in the palette (blocks imported from code). */
  hidden?: boolean;
}

const int = (key: string, label: string, d: number, min = 1, hint?: string): ParamSpec => ({ key, label, kind: "int", default: d, min, hint });
const conv = (): ParamSpec[] => [int("out_channels", "Out channels", 32), int("kernel_size", "Kernel", 3), int("stride", "Stride", 1), int("padding", "Padding", 1, 0), int("dilation", "Dilation", 1), { key: "bias", label: "Bias", kind: "bool", default: true }];
const pool = (): ParamSpec[] => [int("kernel_size", "Kernel", 2), int("stride", "Stride", 2), int("padding", "Padding", 0, 0)];

export const LAYERS: LayerSpec[] = [
  { type: "Input", group: "Input / output", label: "Input", blurb: "Shape of one example", inputs: 0, params: [{ key: "shape", label: "Shape (no batch)", kind: "shape", default: "3,32,32", hint: "e.g. 784 · 3,224,224 · 128 for token ids" }, { key: "dtype", label: "Data", kind: "choice", default: "float", choices: ["float", "token ids"] }] },
  {
    type: "Timestep",
    group: "Input / output",
    label: "Timestep",
    blurb: "Diffusion step t, as a vector",
    inputs: 0,
    params: [int("dim", "Embedding size", 128, 2, "Even; add it (through a Linear sized to the channels) to feature maps or tokens"), int("steps", "Diffusion steps", 1000, 1, "T: noise levels the training script samples from")],
  },
  {
    type: "Output",
    group: "Input / output",
    label: "Output",
    blurb: "What forward() returns",
    inputs: 1,
    params: [{ key: "loss", label: "Training loss", kind: "choice", default: "auto", choices: ["auto", "classify", "binary", "regress", "reconstruct"], hint: "What the quick training script fits. Auto: classes for one vector, tokens for token-id models, rebuilding the input when the shapes match." }],
  },
  { type: "Linear", group: "Dense", label: "Linear", blurb: "Fully connected layer", inputs: 1, params: [int("out_features", "Out features", 128), { key: "bias", label: "Bias", kind: "bool", default: true }] },
  { type: "Dropout", group: "Dense", label: "Dropout", blurb: "Randomly zero activations", inputs: 1, params: [{ key: "p", label: "Probability", kind: "float", default: 0.1, min: 0 }] },
  { type: "Flatten", group: "Dense", label: "Flatten", blurb: "Collapse to one dimension", inputs: 1, params: [] },
  { type: "Conv2d", group: "Convolution", label: "Conv2d", blurb: "2-D convolution over images", inputs: 1, params: [...conv(), int("groups", "Groups", 1, 1, "Equal to the input channels for a depthwise convolution")] },
  { type: "Conv1d", group: "Convolution", label: "Conv1d", blurb: "1-D convolution over signals", inputs: 1, params: conv() },
  { type: "Conv3d", group: "Convolution", label: "Conv3d", blurb: "3-D convolution over video or volumes", inputs: 1, params: conv() },
  { type: "ConvTranspose2d", group: "Convolution", label: "ConvTranspose2d", blurb: "Learned upsampling (decoders, generators)", inputs: 1, params: [int("out_channels", "Out channels", 32), int("kernel_size", "Kernel", 4), int("stride", "Stride", 2), int("padding", "Padding", 1, 0), { key: "bias", label: "Bias", kind: "bool", default: true }] },
  { type: "Upsample", group: "Convolution", label: "Upsample", blurb: "Enlarge by repeating values", inputs: 1, params: [int("scale_factor", "Scale", 2)] },
  { type: "MaxPool1d", group: "Pooling", label: "MaxPool1d", blurb: "Downsample a signal by max", inputs: 1, params: pool() },
  { type: "MaxPool2d", group: "Pooling", label: "MaxPool2d", blurb: "Downsample by max", inputs: 1, params: pool() },
  { type: "MaxPool3d", group: "Pooling", label: "MaxPool3d", blurb: "Downsample video by max", inputs: 1, params: pool() },
  { type: "AvgPool2d", group: "Pooling", label: "AvgPool2d", blurb: "Downsample by mean", inputs: 1, params: pool() },
  { type: "AdaptiveAvgPool1d", group: "Pooling", label: "AdaptiveAvgPool1d", blurb: "Pool a signal to a fixed length", inputs: 1, params: [int("output_size", "Output size", 1)] },
  { type: "AdaptiveAvgPool2d", group: "Pooling", label: "AdaptiveAvgPool2d", blurb: "Pool to a fixed size", inputs: 1, params: [int("output_size", "Output size", 1)] },
  { type: "AdaptiveAvgPool3d", group: "Pooling", label: "AdaptiveAvgPool3d", blurb: "Pool video to a fixed size", inputs: 1, params: [int("time_size", "Frames", 1), int("output_size", "Height × width", 1)] },
  { type: "BatchNorm", group: "Normalization", label: "BatchNorm", blurb: "Normalize over the batch", inputs: 1, params: [] },
  { type: "LayerNorm", group: "Normalization", label: "LayerNorm", blurb: "Normalize the last dimension", inputs: 1, params: [] },
  { type: "ReLU", group: "Activation", label: "ReLU", blurb: "max(0, x)", inputs: 1, params: [] },
  { type: "GELU", group: "Activation", label: "GELU", blurb: "Smooth ReLU, used in transformers", inputs: 1, params: [] },
  { type: "SiLU", group: "Activation", label: "SiLU", blurb: "x · sigmoid(x)", inputs: 1, params: [] },
  { type: "LeakyReLU", group: "Activation", label: "LeakyReLU", blurb: "ReLU with a small negative slope", inputs: 1, params: [{ key: "negative_slope", label: "Slope", kind: "float", default: 0.01, min: 0 }] },
  { type: "Tanh", group: "Activation", label: "Tanh", blurb: "Squash to (-1, 1)", inputs: 1, params: [] },
  { type: "Sigmoid", group: "Activation", label: "Sigmoid", blurb: "Squash to (0, 1)", inputs: 1, params: [] },
  { type: "Softmax", group: "Activation", label: "Softmax", blurb: "Probabilities over the last dimension", inputs: 1, params: [] },
  { type: "Embedding", group: "Sequence", label: "Embedding", blurb: "Token ids to vectors", inputs: 1, params: [int("num_embeddings", "Vocabulary", 10000), int("embedding_dim", "Dimension", 256)] },
  { type: "LSTM", group: "Sequence", label: "LSTM", blurb: "Recurrent layer over a sequence", inputs: 1, params: [int("hidden_size", "Hidden size", 128), int("num_layers", "Layers", 1), { key: "bidirectional", label: "Bidirectional", kind: "bool", default: false }] },
  { type: "GRU", group: "Sequence", label: "GRU", blurb: "Lighter recurrent layer", inputs: 1, params: [int("hidden_size", "Hidden size", 128), int("num_layers", "Layers", 1), { key: "bidirectional", label: "Bidirectional", kind: "bool", default: false }] },
  { type: "MultiheadAttention", group: "Sequence", label: "Self-attention", blurb: "Multi-head self-attention", inputs: 1, params: [int("num_heads", "Heads", 8)] },
  {
    type: "TransformerEncoderLayer",
    group: "Sequence",
    label: "Transformer block",
    blurb: "Attention + MLP, pre-norm",
    inputs: 1,
    params: [int("nhead", "Heads", 8), int("dim_feedforward", "MLP size", 1024), { key: "dropout", label: "Dropout", kind: "float", default: 0.1, min: 0 }, { key: "causal", label: "Causal (GPT-style)", kind: "bool", default: false, hint: "Each position sees only earlier ones, for next-token prediction" }],
  },
  { type: "PositionEmbedding", group: "Sequence", label: "Position embedding", blurb: "Adds where each token is (learned)", inputs: 1, params: [] },
  { type: "SequencePool", group: "Sequence", label: "Pool sequence", blurb: "One vector per sequence", inputs: 1, params: [{ key: "mode", label: "Take", kind: "choice", default: "mean", choices: ["mean", "last", "first"] }] },
  { type: "Reshape", group: "Shape", label: "Reshape", blurb: "Same values, new shape", inputs: 1, params: [{ key: "shape", label: "Shape (no batch)", kind: "shape", default: "-1", hint: "e.g. 256,4,4 · 64,-1 (-1 fills in the rest)" }] },
  { type: "Permute", group: "Shape", label: "Permute", blurb: "Reorder dimensions", inputs: 1, params: [{ key: "order", label: "Order (no batch)", kind: "shape", default: "1,0", hint: "1,0 turns [channels, length] into [length, channels]" }] },
  {
    type: "Custom",
    group: "Combine",
    label: "From your code",
    blurb: "Imported as is: the builder can't express it",
    inputs: "many",
    hidden: true,
    params: [
      { key: "what", label: "Code", kind: "choice", default: "", choices: [] },
      { key: "shape", label: "Output shape (no batch)", kind: "shape", default: "" },
      { key: "params", label: "Parameters", kind: "int", default: 0, min: 0 },
    ],
  },
  { type: "Add", group: "Combine", label: "Add", blurb: "Sum inputs (residual)", inputs: "many", params: [] },
  { type: "Concat", group: "Combine", label: "Concat", blurb: "Join inputs along a dimension", inputs: "many", params: [{ key: "dim", label: "Dimension", kind: "int", default: -1, min: -8, hint: "Of the shape without batch; -1 is the last" }] },
];

export const LAYER: Record<LayerType, LayerSpec> = Object.fromEntries(LAYERS.map((l) => [l.type, l])) as Record<LayerType, LayerSpec>;

export function defaultParams(type: LayerType): Record<string, ParamValue> {
  return Object.fromEntries(LAYER[type].params.map((p) => [p.key, p.default]));
}

// ------------------------------------------------------------ analysis

export interface NodeInfo {
  /** Output shape without the batch dimension; null when it can't be worked out. */
  shape: number[] | null;
  dtype: "float" | "long";
  params: number;
  error: string | null;
}

export interface GraphAnalysis {
  nodes: Record<string, NodeInfo>;
  /** Nodes in the order forward() computes them. */
  order: string[];
  totalParams: number;
  /** Problems with the graph as a whole: no input, a cycle, nothing reaching the output... */
  errors: string[];
  ok: boolean;
}

export const paramNum = (v: ParamValue | undefined, d: number): number => (typeof v === "number" && Number.isFinite(v) ? v : typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v)) ? Number(v) : d);
const num = paramNum;
const prod = (s: number[]) => s.reduce((a, b) => a * b, 1);
export const fmtShape = (s: number[] | null) => (s ? `[B, ${s.join(", ")}]` : "?");

export function parseShape(v: ParamValue | undefined): number[] | null {
  const parts = String(v ?? "").split(/[,x×\s]+/).filter(Boolean).map(Number);
  return parts.length && parts.every((n) => Number.isInteger(n) && n > 0) ? parts : null;
}

function recurrentParams(cell: 4 | 3, input: number, hidden: number, layers: number, dirs: number): number {
  let total = 0;
  for (let l = 0; l < layers; l++) {
    const inp = l === 0 ? input : hidden * dirs;
    total += dirs * cell * (hidden * inp + hidden * hidden + 2 * hidden);
  }
  return total;
}

/** Rank (without batch) each spatial layer expects: [channels, ...space]. */
const RANK: Partial<Record<LayerType, number>> = {
  Conv1d: 2, MaxPool1d: 2, AdaptiveAvgPool1d: 2,
  Conv2d: 3, MaxPool2d: 3, AvgPool2d: 3, AdaptiveAvgPool2d: 3, ConvTranspose2d: 3,
  Conv3d: 4, MaxPool3d: 4, AdaptiveAvgPool3d: 4,
};
const RANK_NAME: Record<number, string> = { 2: "[channels, length]", 3: "[channels, height, width]", 4: "[channels, frames, height, width]" };

function spatial(s: number[], rank: number): number[] {
  if (s.length !== rank) throw new Error(`needs ${RANK_NAME[rank]}, got ${fmtShape(s)}`);
  return s;
}

/** Reshape target with at most one -1, checked against the input size. */
function reshapeTarget(v: ParamValue | undefined, total: number): number[] {
  const parts = String(v ?? "").split(/[,x×\s]+/).filter(Boolean).map(Number);
  if (!parts.length || parts.some((n) => !Number.isInteger(n) || (n < 1 && n !== -1)) || parts.filter((n) => n === -1).length > 1) throw new Error("shape must be positive integers, with at most one -1");
  const known = prod(parts.filter((n) => n !== -1));
  if (parts.includes(-1)) {
    if (total % known) throw new Error(`can't split ${total} values into ${parts.join(", ")}`);
    return parts.map((n) => (n === -1 ? total / known : n));
  }
  if (known !== total) throw new Error(`${parts.join("×")} = ${known} values, but the input has ${total}`);
  return parts;
}

function permOrder(v: ParamValue | undefined, rank: number): number[] {
  const order = String(v ?? "").split(/[,\s]+/).filter(Boolean).map(Number);
  const ok = order.length === rank && [...order].sort((a, b) => a - b).every((x, i) => x === i);
  if (!ok) throw new Error(`order must list each of 0..${rank - 1} once for a ${rank}-D input`);
  return order;
}

/**
 * A vector added to a bigger tensor, as conditioning (e.g. a timestep embedding): per channel
 * of a feature map [C, ...space], or per feature of every token in a sequence [L, D].
 */
function broadcastsInto(v: number[], s: number[]): boolean {
  if (v.length !== 1 || s.length < 2) return false;
  return s.length === 2 ? s[1] === v[0] : s[0] === v[0];
}

/** One layer's output shape and parameter count from its input shapes. Throws a readable message. */
function layerShape(n: LayerNode, ins: NodeInfo[]): Omit<NodeInfo, "error"> {
  const p = n.params;
  const one = () => {
    if (ins.length !== 1) throw new Error(ins.length ? "takes exactly one input" : "needs an input");
    return ins[0]!;
  };
  const float = (i: NodeInfo) => {
    if (i.dtype !== "float") throw new Error("needs float inputs; token ids go into an Embedding first");
    return i.shape!;
  };
  switch (n.type) {
    case "Input": {
      const s = parseShape(p.shape);
      if (!s) throw new Error("shape must be positive integers, e.g. 3,32,32");
      return { shape: s, dtype: p.dtype === "token ids" ? "long" : "float", params: 0 };
    }
    case "Output":
      return { ...one(), params: 0 };
    case "Linear": {
      const s = float(one());
      const out = num(p.out_features, 1);
      const inF = s.at(-1)!;
      return { shape: [...s.slice(0, -1), out], dtype: "float", params: inF * out + (p.bias === false ? 0 : out) };
    }
    case "Conv1d":
    case "Conv2d":
    case "Conv3d": {
      const s = spatial(float(one()), RANK[n.type]!);
      const [c, ...space] = s as [number, ...number[]];
      const k = num(p.kernel_size, 3), st = num(p.stride, 1), pad = num(p.padding, 0), dil = num(p.dilation, 1), out = num(p.out_channels, 1);
      const groups = n.type === "Conv2d" ? num(p.groups, 1) : 1;
      if (c % groups || out % groups) throw new Error(`groups (${groups}) must divide the input channels (${c}) and out channels (${out})`);
      const dims = space.map((d) => Math.floor((d + 2 * pad - dil * (k - 1) - 1) / st) + 1);
      if (dims.some((d) => d < 1)) throw new Error(`kernel ${k} is larger than the input ${space.join("×")}`);
      return { shape: [out, ...dims], dtype: "float", params: (c / groups) * out * k ** space.length + (p.bias === false ? 0 : out) };
    }
    case "ConvTranspose2d": {
      const [c, ...space] = spatial(float(one()), 3) as [number, ...number[]];
      const k = num(p.kernel_size, 4), st = num(p.stride, 2), pad = num(p.padding, 0), out = num(p.out_channels, 1);
      const dims = space.map((d) => (d - 1) * st - 2 * pad + k);
      if (dims.some((d) => d < 1)) throw new Error("padding is too large for this kernel");
      return { shape: [out, ...dims], dtype: "float", params: c * out * k * k + (p.bias === false ? 0 : out) };
    }
    case "Upsample": {
      const s = float(one());
      if (s.length < 2 || s.length > 4) throw new Error(`needs [channels, ...] with 1 to 3 spatial dimensions, got ${fmtShape(s)}`);
      const f = num(p.scale_factor, 2);
      return { shape: [s[0]!, ...s.slice(1).map((d) => d * f)], dtype: "float", params: 0 };
    }
    case "MaxPool1d":
    case "MaxPool2d":
    case "MaxPool3d":
    case "AvgPool2d": {
      const [c, ...space] = spatial(float(one()), RANK[n.type]!) as [number, ...number[]];
      const k = num(p.kernel_size, 2), st = num(p.stride, k), pad = num(p.padding, 0);
      if (pad * 2 > k) throw new Error(`padding ${pad} is more than half the kernel ${k}`);
      const dims = space.map((d) => Math.floor((d + 2 * pad - k) / st) + 1);
      if (dims.some((d) => d < 1)) throw new Error(`kernel ${k} is larger than the input ${space.join("×")}`);
      return { shape: [c, ...dims], dtype: "float", params: 0 };
    }
    case "AdaptiveAvgPool1d":
    case "AdaptiveAvgPool2d":
    case "AdaptiveAvgPool3d": {
      const s = spatial(float(one()), RANK[n.type]!);
      const o = num(p.output_size, 1);
      const dims = n.type === "AdaptiveAvgPool1d" ? [o] : n.type === "AdaptiveAvgPool2d" ? [o, o] : [num(p.time_size, 1), o, o];
      return { shape: [s[0]!, ...dims], dtype: "float", params: 0 };
    }
    case "BatchNorm": {
      const s = float(one());
      if (s.length > 4) throw new Error("works on up to 4 dimensions");
      return { shape: s, dtype: "float", params: 2 * s[0]! };
    }
    case "Reshape": {
      const s = float(one());
      const want = reshapeTarget(p.shape, prod(s));
      return { shape: want, dtype: "float", params: 0 };
    }
    case "Permute": {
      const s = one().shape!;
      const order = permOrder(p.order, s.length);
      return { shape: order.map((i) => s[i]!), dtype: one().dtype, params: 0 };
    }
    case "PositionEmbedding": {
      const s = float(one());
      if (s.length !== 2) throw new Error(`needs a sequence [length, features], got ${fmtShape(s)}`);
      return { shape: s, dtype: "float", params: s[0]! * s[1]! };
    }
    case "LayerNorm": {
      const s = float(one());
      return { shape: s, dtype: "float", params: 2 * s.at(-1)! };
    }
    case "Dropout":
    case "ReLU":
    case "GELU":
    case "SiLU":
    case "LeakyReLU":
    case "Tanh":
    case "Sigmoid":
    case "Softmax":
      return { shape: float(one()), dtype: "float", params: 0 };
    case "Flatten":
      return { shape: [prod(float(one()))], dtype: "float", params: 0 };
    case "Embedding": {
      const i = one();
      if (i.dtype !== "long") throw new Error("needs token ids: set the Input's data to \"token ids\"");
      const d = num(p.embedding_dim, 1);
      return { shape: [...i.shape!, d], dtype: "float", params: num(p.num_embeddings, 1) * d };
    }
    case "LSTM":
    case "GRU": {
      const s = float(one());
      if (s.length !== 2) throw new Error(`needs a sequence [length, features], got ${fmtShape(s)}`);
      const h = num(p.hidden_size, 1), layers = num(p.num_layers, 1), dirs = p.bidirectional ? 2 : 1;
      return { shape: [s[0]!, h * dirs], dtype: "float", params: recurrentParams(n.type === "LSTM" ? 4 : 3, s[1]!, h, layers, dirs) };
    }
    case "MultiheadAttention":
    case "TransformerEncoderLayer": {
      const s = float(one());
      if (s.length !== 2) throw new Error(`needs a sequence [length, features], got ${fmtShape(s)}`);
      const e = s[1]!;
      const heads = num(n.type === "MultiheadAttention" ? p.num_heads : p.nhead, 1);
      if (e % heads) throw new Error(`features (${e}) must divide by the number of heads (${heads})`);
      const attn = 4 * e * e + 4 * e;
      if (n.type === "MultiheadAttention") return { shape: s, dtype: "float", params: attn };
      const f = num(p.dim_feedforward, 1);
      return { shape: s, dtype: "float", params: attn + (e * f + f) + (f * e + e) + 4 * e };
    }
    case "SequencePool": {
      const s = float(one());
      if (s.length < 2) throw new Error(`needs a sequence [length, features], got ${fmtShape(s)}`);
      return { shape: s.slice(1), dtype: "float", params: 0 };
    }
    case "Add": {
      if (ins.length < 2) throw new Error("needs two or more inputs");
      const shapes = ins.map(float);
      const s = shapes.reduce((m, x) => (x.length > m.length ? x : m));
      for (const x of shapes) {
        if (fmtShape(x) === fmtShape(s) || broadcastsInto(x, s)) continue;
        throw new Error(`inputs must have the same shape: ${shapes.map(fmtShape).join(" vs ")}`);
      }
      return { shape: s, dtype: "float", params: 0 };
    }
    case "Custom": {
      // Shape and parameters were measured by running the original code.
      const s = parseShape(p.shape);
      if (!s) throw new Error("no output shape recorded");
      return { shape: s, dtype: "float", params: num(p.params, 0) };
    }
    case "Timestep": {
      const d = num(p.dim, 128);
      if (d % 2) throw new Error("embedding size must be even (half sine, half cosine)");
      return { shape: [d], dtype: "float", params: 2 * (d * d + d) };
    }
    case "Concat": {
      if (ins.length < 2) throw new Error("needs two or more inputs");
      const shapes = ins.map(float);
      const rank = shapes[0]!.length;
      const d = num(p.dim, -1);
      const axis = d < 0 ? rank + d : d;
      if (axis < 0 || axis >= rank) throw new Error(`dimension ${d} is out of range for ${fmtShape(shapes[0]!)}`);
      for (const s of shapes) if (s.length !== rank || s.some((v, i) => i !== axis && v !== shapes[0]![i])) throw new Error(`inputs must match except along dimension ${d}: ${shapes.map(fmtShape).join(" vs ")}`);
      const out = [...shapes[0]!];
      out[axis] = shapes.reduce((a, s) => a + s[axis]!, 0);
      return { shape: out, dtype: "float", params: 0 };
    }
  }
}

export function analyzeGraph(g: ModelGraph): GraphAnalysis {
  const errors: string[] = [];
  const byId = new Map(g.nodes.map((n) => [n.id, n]));
  const inputsOf = new Map<string, string[]>(g.nodes.map((n) => [n.id, []]));
  for (const e of g.edges) if (byId.has(e.from) && byId.has(e.to)) inputsOf.get(e.to)!.push(e.from);

  const inputs = g.nodes.filter((n) => n.type === "Input");
  const outputs = g.nodes.filter((n) => n.type === "Output");
  if (inputs.length !== 1) errors.push(inputs.length ? "Use a single Input." : "Add an Input to say what one example looks like.");
  if (outputs.length !== 1) errors.push(outputs.length ? "Use a single Output." : "Add an Output and connect the last layer to it.");
  const timesteps = g.nodes.filter((n) => n.type === "Timestep");
  if (timesteps.length > 1) errors.push("Use a single Timestep.");

  // Kahn's algorithm; whatever is left over sits on a cycle.
  const indeg = new Map(g.nodes.map((n) => [n.id, inputsOf.get(n.id)!.length]));
  const queue = g.nodes.filter((n) => indeg.get(n.id) === 0).map((n) => n.id);
  const order: string[] = [];
  while (queue.length) {
    const id = queue.shift()!;
    order.push(id);
    for (const e of g.edges) if (e.from === id && indeg.has(e.to)) {
      indeg.set(e.to, indeg.get(e.to)! - 1);
      if (indeg.get(e.to) === 0) queue.push(e.to);
    }
  }
  if (order.length < g.nodes.length) errors.push("The graph has a loop. Layers must feed forward only.");

  const nodes: Record<string, NodeInfo> = {};
  for (const id of order) {
    const n = byId.get(id)!;
    const ins = inputsOf.get(id)!.map((i) => nodes[i]!);
    if (ins.some((i) => !i.shape)) {
      nodes[id] = { shape: null, dtype: "float", params: 0, error: null };
      continue;
    }
    try {
      nodes[id] = { ...layerShape(n, ins), error: null };
    } catch (e) {
      nodes[id] = { shape: null, dtype: "float", params: 0, error: e instanceof Error ? e.message : String(e) };
    }
  }
  for (const n of g.nodes) nodes[n.id] ??= { shape: null, dtype: "float", params: 0, error: "on a loop" };

  // Everything must lie on a path from the Input (or the diffusion Timestep) to the Output.
  if (inputs.length === 1 && outputs.length === 1) {
    const reach = (starts: string[], next: (id: string) => string[]) => {
      const seen = new Set(starts);
      const stack = [...starts];
      while (stack.length) for (const x of next(stack.pop()!)) if (!seen.has(x)) (seen.add(x), stack.push(x));
      return seen;
    };
    const fromIn = reach([inputs[0]!.id, ...timesteps.map((n) => n.id)], (id) => g.edges.filter((e) => e.from === id).map((e) => e.to));
    const toOut = reach([outputs[0]!.id], (id) => inputsOf.get(id) ?? []);
    if (!reach([inputs[0]!.id], (id) => g.edges.filter((e) => e.from === id).map((e) => e.to)).has(outputs[0]!.id)) errors.push("Nothing connects the Input to the Output yet.");
    for (const n of g.nodes) if (!fromIn.has(n.id) || !toOut.has(n.id)) nodes[n.id]!.error ??= !fromIn.has(n.id) ? "not connected to the Input" : "doesn't lead to the Output";
  }
  const totalParams = g.nodes.reduce((a, n) => a + nodes[n.id]!.params, 0);
  const ok = !errors.length && g.nodes.every((n) => !nodes[n.id]!.error);
  return { nodes, order, totalParams, errors, ok };
}

// ------------------------------------------------------------ code

export function className(name: string): string {
  const words = name.replace(/[^A-Za-z0-9]+/g, " ").trim().split(/\s+/).filter(Boolean);
  const cls = words.map((w) => w[0]!.toUpperCase() + w.slice(1)).join("") || "Model";
  return /^\d/.test(cls) ? `Model${cls}` : cls;
}

export function fileStem(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "") || "model";
}

/** The nn.Module constructor for a layer, with inferred input sizes; null for layers that are plain operations. */
function moduleExpr(n: LayerNode, input: NodeInfo | undefined): string | null {
  const p = n.params;
  const s = input?.shape ?? [];
  switch (n.type) {
    case "Linear":
      return `nn.Linear(${s.at(-1)}, ${num(p.out_features, 1)}${p.bias === false ? ", bias=False" : ""})`;
    case "Conv1d":
    case "Conv2d":
    case "Conv3d": {
      const dil = num(p.dilation, 1);
      const groups = n.type === "Conv2d" ? num(p.groups, 1) : 1;
      return `nn.${n.type}(${s[0]}, ${num(p.out_channels, 1)}, kernel_size=${num(p.kernel_size, 3)}, stride=${num(p.stride, 1)}, padding=${num(p.padding, 0)}${dil !== 1 ? `, dilation=${dil}` : ""}${groups !== 1 ? `, groups=${groups}` : ""}${p.bias === false ? ", bias=False" : ""})`;
    }
    case "ConvTranspose2d":
      return `nn.ConvTranspose2d(${s[0]}, ${num(p.out_channels, 1)}, kernel_size=${num(p.kernel_size, 4)}, stride=${num(p.stride, 2)}, padding=${num(p.padding, 0)}${p.bias === false ? ", bias=False" : ""})`;
    case "Upsample":
      return `nn.Upsample(scale_factor=${num(p.scale_factor, 2)}, mode="nearest")`;
    case "MaxPool1d":
    case "MaxPool2d":
    case "MaxPool3d":
    case "AvgPool2d":
      return `nn.${n.type}(${num(p.kernel_size, 2)}, stride=${num(p.stride, num(p.kernel_size, 2))}${num(p.padding, 0) ? `, padding=${num(p.padding, 0)}` : ""})`;
    case "AdaptiveAvgPool1d":
    case "AdaptiveAvgPool2d":
      return `nn.${n.type}(${num(p.output_size, 1)})`;
    case "AdaptiveAvgPool3d":
      return `nn.AdaptiveAvgPool3d((${num(p.time_size, 1)}, ${num(p.output_size, 1)}, ${num(p.output_size, 1)}))`;
    case "BatchNorm":
      return `nn.BatchNorm${s.length === 4 ? "3d" : s.length === 3 ? "2d" : "1d"}(${s[0]})`;
    case "PositionEmbedding":
      return `nn.Embedding(${s[0]}, ${s[1]})`;
    case "Timestep":
      return `TimestepEmbedding(${num(p.dim, 128)})`;
    case "LayerNorm":
      return `nn.LayerNorm(${s.at(-1)})`;
    case "Dropout":
      return `nn.Dropout(${num(p.p, 0.1)})`;
    case "ReLU":
    case "GELU":
    case "SiLU":
    case "Tanh":
    case "Sigmoid":
      return `nn.${n.type}()`;
    case "LeakyReLU":
      return `nn.LeakyReLU(${num(p.negative_slope, 0.01)})`;
    case "Softmax":
      return "nn.Softmax(dim=-1)";
    case "Flatten":
      return "nn.Flatten()";
    case "Embedding":
      return `nn.Embedding(${num(p.num_embeddings, 1)}, ${num(p.embedding_dim, 1)})`;
    case "LSTM":
    case "GRU":
      return `nn.${n.type}(${s[1]}, ${num(p.hidden_size, 1)}, num_layers=${num(p.num_layers, 1)}, batch_first=True${p.bidirectional ? ", bidirectional=True" : ""})`;
    case "MultiheadAttention":
      return `nn.MultiheadAttention(${s[1]}, ${num(p.num_heads, 1)}, batch_first=True)`;
    case "TransformerEncoderLayer":
      return `nn.TransformerEncoderLayer(${s[1]}, ${num(p.nhead, 1)}, dim_feedforward=${num(p.dim_feedforward, 1)}, dropout=${num(p.dropout, 0.1)}, batch_first=True, norm_first=True)`;
    default:
      return null;
  }
}

const ATTR_PREFIX: Partial<Record<LayerType, string>> = {
  Linear: "fc", Conv1d: "conv", Conv2d: "conv", Conv3d: "conv", ConvTranspose2d: "deconv", Upsample: "up", PositionEmbedding: "pos", Timestep: "time",
  MaxPool1d: "pool", MaxPool2d: "pool", MaxPool3d: "pool", AvgPool2d: "pool", AdaptiveAvgPool1d: "gap", AdaptiveAvgPool2d: "gap", AdaptiveAvgPool3d: "gap", BatchNorm: "bn", LayerNorm: "norm",
  Dropout: "drop", Embedding: "embed", LSTM: "lstm", GRU: "gru", MultiheadAttention: "attn", TransformerEncoderLayer: "block", Flatten: "flatten",
};

/**
 * The attribute each layer gets in the generated module (node id → e.g. "conv2"), which is
 * also the prefix of its parameter names in the trained model ("conv2.weight").
 */
export function moduleNames(g: ModelGraph, a: GraphAnalysis = analyzeGraph(g)): Record<string, string> {
  const byId = new Map(g.nodes.map((n) => [n.id, n]));
  const firstInput = (id: string) => g.edges.find((e) => e.to === id)?.from ?? "";
  const counts = new Map<string, number>();
  const out: Record<string, string> = {};
  for (const id of a.order) {
    const n = byId.get(id);
    if (!n || !moduleExpr(n, a.nodes[firstInput(id)])) continue;
    const prefix = ATTR_PREFIX[n.type] ?? n.type.toLowerCase();
    const k = (counts.get(prefix) ?? 0) + 1;
    counts.set(prefix, k);
    out[id] = `${prefix}${k}`;
  }
  return out;
}

const TIMESTEP_EMBEDDING = [
  `class TimestepEmbedding(nn.Module):`,
  `    """The diffusion step as a vector: sinusoidal features, then a small MLP."""`,
  ``,
  `    def __init__(self, dim):`,
  `        super().__init__()`,
  `        self.dim = dim`,
  `        self.mlp = nn.Sequential(nn.Linear(dim, dim), nn.SiLU(), nn.Linear(dim, dim))`,
  ``,
  `    def forward(self, t):`,
  `        half = self.dim // 2`,
  `        freqs = torch.exp(-math.log(10000) * torch.arange(half, device=t.device) / half)`,
  `        angles = t.float()[:, None] * freqs[None]`,
  `        return self.mlp(torch.cat([angles.sin(), angles.cos()], dim=-1))`,
  ``,
];

/** The model as a self-contained PyTorch module. Requires an `ok` analysis. */
export function generateModelCode(g: ModelGraph, a: GraphAnalysis = analyzeGraph(g)): string {
  if (!a.ok) throw new Error(a.errors[0] ?? "Fix the highlighted layers first.");
  const custom = g.nodes.filter((n) => n.type === "Custom");
  if (custom.length)
    throw new Error(`${custom.length} block${custom.length === 1 ? " comes" : "s come"} from your code as is (${custom.slice(0, 3).map((n) => String(n.params.what)).join(", ")}${custom.length > 3 ? "…" : ""}), so Converlt can't write this model. Replace ${custom.length === 1 ? "it" : "them"} with builder layers to generate code, or train your original code.`);
  const byId = new Map(g.nodes.map((n) => [n.id, n]));
  const inputsOf = (id: string) => g.edges.filter((e) => e.to === id).map((e) => e.from);
  const consumers = (id: string) => g.edges.filter((e) => e.from === id).length;
  const cls = className(g.name);
  const attr = new Map(Object.entries(moduleNames(g, a)));
  const init: string[] = [];
  for (const id of a.order) {
    const expr = moduleExpr(byId.get(id)!, a.nodes[inputsOf(id)[0] ?? ""]);
    if (expr) init.push(`        self.${attr.get(id)} = ${expr}`);
  }

  // A layer writes back into its input's variable when nothing else reads that variable.
  const varOf = new Map<string, string>();
  let fresh = 1;
  const newVar = () => (fresh++ === 1 ? "x" : `x${fresh - 1}`);
  const lines: string[] = [];
  let ret = "x";
  for (const id of a.order) {
    const n = byId.get(id)!;
    const ins = inputsOf(id).map((i) => varOf.get(i)!);
    if (n.type === "Input") {
      varOf.set(id, newVar());
      continue;
    }
    if (n.type === "Output") {
      ret = ins[0]!;
      continue;
    }
    if (n.type === "Timestep") {
      varOf.set(id, "temb");
      lines.push(`        temb = self.${attr.get(id)}(t)  # ${fmtShape(a.nodes[id]!.shape)}`);
      continue;
    }
    const reuse = ins.length === 1 && consumers(inputsOf(id)[0]!) === 1;
    const out = reuse ? ins[0]! : newVar();
    varOf.set(id, out);
    const m = attr.get(id);
    let expr: string;
    switch (n.type) {
      case "LSTM":
      case "GRU":
        expr = `self.${m}(${ins[0]})[0]`;
        break;
      case "MultiheadAttention":
        expr = `self.${m}(${ins[0]}, ${ins[0]}, ${ins[0]}, need_weights=False)[0]`;
        break;
      case "TransformerEncoderLayer":
        expr = n.params.causal ? `self.${m}(${ins[0]}, src_mask=nn.Transformer.generate_square_subsequent_mask(${ins[0]}.size(1), device=${ins[0]}.device), is_causal=True)` : `self.${m}(${ins[0]})`;
        break;
      case "PositionEmbedding":
        expr = `${ins[0]} + self.${m}(torch.arange(${ins[0]}.size(1), device=${ins[0]}.device))`;
        break;
      case "Reshape":
        expr = `${ins[0]}.reshape(${ins[0]}.size(0), ${a.nodes[id]!.shape!.join(", ")})`;
        break;
      case "Permute":
        expr = `${ins[0]}.permute(0, ${permOrder(n.params.order, a.nodes[id]!.shape!.length).map((i) => i + 1).join(", ")})`;
        break;
      case "SequencePool":
        expr = n.params.mode === "last" ? `${ins[0]}[:, -1]` : n.params.mode === "first" ? `${ins[0]}[:, 0]` : `${ins[0]}.mean(dim=1)`;
        break;
      case "Add": {
        // A vector (e.g. the timestep embedding) is broadcast over channels or tokens.
        const out = a.nodes[id]!.shape!;
        expr = inputsOf(id)
          .map((src, k) => {
            const v = ins[k]!;
            if (a.nodes[src]!.shape!.length !== 1 || out.length === 1) return v;
            return out.length === 2 ? `${v}.unsqueeze(1)` : `${v}.reshape(${v}.size(0), -1${", 1".repeat(out.length - 1)})`;
          })
          .join(" + ");
        break;
      }
      case "Concat": {
        const rank = a.nodes[id]!.shape!.length;
        const d = num(n.params.dim, -1);
        expr = `torch.cat([${ins.join(", ")}], dim=${(d < 0 ? rank + d : d) + 1})`;
        break;
      }
      default:
        expr = `self.${m}(${ins[0]})`;
    }
    lines.push(`        ${out} = ${expr}  # ${fmtShape(a.nodes[id]!.shape)}`);
  }
  const input = g.nodes.find((n) => n.type === "Input")!;
  const inInfo = a.nodes[input.id]!;
  const time = g.nodes.find((n) => n.type === "Timestep");
  return [
    `"""${g.name}: built with the Converlt model builder.`,
    ``,
    `Input ${fmtShape(inInfo.shape)}${inInfo.dtype === "long" ? " (token ids)" : ""}${time ? " and diffusion step t [B]" : ""} → output ${fmtShape(a.nodes[g.nodes.find((n) => n.type === "Output")!.id]!.shape)} · ${a.totalParams.toLocaleString("en-US")} parameters.`,
    `Edit the design in Converlt → Model Builder; changes made here are overwritten when it's saved again.`,
    `"""`,
    ...(time ? [`import math`] : []),
    `import torch`,
    `from torch import nn`,
    ``,
    ...(time ? TIMESTEP_EMBEDDING : []),
    ``,
    `class ${cls}(nn.Module):`,
    `    def __init__(self):`,
    `        super().__init__()`,
    ...(init.length ? init : ["        pass"]),
    ``,
    `    def forward(self, x${time ? ", t" : ""}):`,
    ...lines,
    `        return ${ret}`,
    ``,
    ``,
    `INPUT_SHAPE = (${inInfo.shape!.join(", ")}${inInfo.shape!.length === 1 ? "," : ""})`,
    `INPUT_DTYPE = ${inInfo.dtype === "long" ? "torch.long" : "torch.float32"}`,
    `PARAMETERS = ${a.totalParams}`,
    ...(time ? [`TIMESTEPS = ${num(time.params.steps, 1000)}`] : []),
    ``,
  ].join("\n");
}

// ------------------------------------------------------------ templates

let uid = 0;
const node = (type: LayerType, x: number, y: number, params: Record<string, ParamValue> = {}): LayerNode => ({ id: `n${++uid}`, type, params: { ...defaultParams(type), ...params }, x, y });

/** Chains layers top to bottom, connecting each to the next. */
function chain(name: string, layers: [LayerType, Record<string, ParamValue>?][]): ModelGraph {
  const nodes = layers.map(([t, p], i) => node(t, 80, 40 + i * 92, p));
  return { name, nodes, edges: nodes.slice(1).map((n, i) => ({ from: nodes[i]!.id, to: n.id })) };
}

type Spec = [key: string, type: LayerType, params?: Record<string, ParamValue>, from?: string | string[]];

/**
 * A graph from a list of layers. Each layer takes the previous one unless `from` names others
 * (residuals, branches, skip connections). Layers are laid out in rows by depth.
 */
function dag(name: string, specs: Spec[]): ModelGraph {
  const ids = new Map<string, string>();
  const depth = new Map<string, number>();
  const perRow = new Map<number, number>();
  const nodes: LayerNode[] = [];
  const edges: Edge[] = [];
  specs.forEach(([key, type, params, from], i) => {
    const srcs = from === undefined ? (i ? [specs[i - 1]![0]] : []) : Array.isArray(from) ? from : [from];
    const d = srcs.length ? Math.max(...srcs.map((s) => depth.get(s)!)) + 1 : 0;
    const col = perRow.get(d) ?? 0;
    perRow.set(d, col + 1);
    const n = node(type, 80 + col * 250, 40 + d * 92, params);
    ids.set(key, n.id);
    depth.set(key, d);
    nodes.push(n);
    for (const s of srcs) edges.push({ from: ids.get(s)!, to: n.id });
  });
  return { name, nodes, edges };
}

const T = "token ids";
const blocks = (n: number, p: Record<string, ParamValue>): Spec[] => Array.from({ length: n }, (_, i): Spec => [`block${i}`, "TransformerEncoderLayer", p]);
/** Conv → BatchNorm → ReLU. */
const cbr = (k: string, type: "Conv1d" | "Conv2d" | "Conv3d", p: Record<string, ParamValue>, from?: string): Spec[] => [[`${k}c`, type, p, from], [`${k}b`, "BatchNorm"], [`${k}r`, "ReLU"]];
/** Patches/tubelets as tokens: [D, ...grid] → [tokens, D], plus learned positions. */
const tokens = (d: number): Spec[] => [["flat", "Reshape", { shape: `${d},-1` }], ["tokens", "Permute", { order: "1,0" }], ["pos", "PositionEmbedding"]];
const head = (classes: number, pool: "mean" | "first" | "last" = "mean"): Spec[] => [["norm", "LayerNorm"], ["pool", "SequencePool", { mode: pool }], ["head", "Linear", { out_features: classes }], ["out", "Output"]];

/** Data types in picker order. */
export const TEMPLATE_DATA = ["Text", "Tabular", "Images", "Video", "Audio", "Time series", "Generative"] as const;
export type TemplateData = (typeof TEMPLATE_DATA)[number];

export interface ModelTemplate {
  id: string;
  label: string;
  /** What the model takes in; the picker groups by this. */
  data?: TemplateData;
  /** The architecture, sorted within its group. */
  model?: string;
  make: () => ModelGraph;
}

export const TEMPLATES: ModelTemplate[] = [
  { id: "blank", label: "Blank", make: () => chain("my model", [["Input", { shape: "784" }], ["Output"]]) },

  // ---------------------------------------------------------------- text (token ids)
  {
    id: "fasttext",
    label: "Bag-of-embeddings text classifier",
    data: "Text",
    model: "fastText",
    make: () => dag("fasttext classifier", [["in", "Input", { shape: "256", dtype: T }], ["emb", "Embedding", { num_embeddings: 20000, embedding_dim: 128 }], ["pool", "SequencePool", { mode: "mean" }], ["head", "Linear", { out_features: 4 }], ["out", "Output"]]),
  },
  {
    id: "textcnn",
    label: "Text CNN, kernels 3/5/7 (Kim)",
    data: "Text",
    model: "TextCNN",
    make: () =>
      dag("text cnn", [
        ["in", "Input", { shape: "256", dtype: T }], ["emb", "Embedding", { num_embeddings: 20000, embedding_dim: 128 }], ["chan", "Permute", { order: "1,0" }],
        ["k3", "Conv1d", { out_channels: 100, kernel_size: 3, padding: 1 }, "chan"], ["k5", "Conv1d", { out_channels: 100, kernel_size: 5, padding: 2 }, "chan"], ["k7", "Conv1d", { out_channels: 100, kernel_size: 7, padding: 3 }, "chan"],
        ["r3", "ReLU", {}, "k3"], ["r5", "ReLU", {}, "k5"], ["r7", "ReLU", {}, "k7"],
        ["cat", "Concat", { dim: 0 }, ["r3", "r5", "r7"]], ["gap", "AdaptiveAvgPool1d"], ["flat", "Flatten"], ["drop", "Dropout", { p: 0.5 }], ["head", "Linear", { out_features: 2 }], ["out", "Output"],
      ]),
  },
  {
    id: "lstm",
    label: "LSTM text classifier",
    data: "Text",
    model: "LSTM",
    make: () => chain("lstm classifier", [["Input", { shape: "128", dtype: "token ids" }], ["Embedding", { num_embeddings: 20000, embedding_dim: 128 }], ["LSTM", { hidden_size: 256, bidirectional: true }], ["SequencePool", { mode: "last" }], ["Linear", { out_features: 2 }], ["Output"]]),
  },
  {
    id: "bilstm-tagger",
    label: "BiLSTM token tagger (NER, POS)",
    data: "Text",
    model: "BiLSTM",
    make: () => dag("bilstm tagger", [["in", "Input", { shape: "128", dtype: T }], ["emb", "Embedding", { num_embeddings: 20000, embedding_dim: 128 }], ["lstm", "LSTM", { hidden_size: 128, bidirectional: true }], ["drop", "Dropout", { p: 0.3 }], ["tags", "Linear", { out_features: 9 }], ["out", "Output"]]),
  },
  {
    id: "bert",
    label: "Transformer encoder classifier (BERT-style)",
    data: "Text",
    model: "BERT",
    make: () =>
      dag("bert classifier", [["in", "Input", { shape: "128", dtype: T }], ["emb", "Embedding", { num_embeddings: 30000, embedding_dim: 256 }], ["pos", "PositionEmbedding"], ["drop", "Dropout", { p: 0.1 }], ...blocks(4, { nhead: 8, dim_feedforward: 1024 }), ...head(2, "first")]),
  },

  // ---------------------------------------------------------------- tabular (feature vectors)
  {
    id: "logreg",
    label: "Logistic regression (binary)",
    data: "Tabular",
    model: "Logistic regression",
    make: () => dag("logistic regression", [["in", "Input", { shape: "32" }], ["fc", "Linear", { out_features: 1 }], ["out", "Output"]]),
  },
  {
    id: "mlp",
    label: "MLP classifier",
    data: "Tabular",
    model: "MLP",
    make: () => chain("mlp classifier", [["Input", { shape: "784" }], ["Linear", { out_features: 256 }], ["ReLU"], ["Dropout", { p: 0.2 }], ["Linear", { out_features: 128 }], ["ReLU"], ["Linear", { out_features: 10 }], ["Output"]]),
  },
  {
    id: "mlp-regressor",
    label: "MLP regressor",
    data: "Tabular",
    model: "MLP regressor",
    make: () => dag("mlp regressor", [["in", "Input", { shape: "16" }], ["fc1", "Linear", { out_features: 128 }], ["a1", "SiLU"], ["fc2", "Linear", { out_features: 64 }], ["a2", "SiLU"], ["fc3", "Linear", { out_features: 1 }], ["out", "Output", { loss: "regress" }]]),
  },
  {
    id: "resmlp",
    label: "Residual MLP",
    data: "Tabular",
    model: "ResNet-MLP",
    make: () =>
      dag("residual mlp", [
        ["in", "Input", { shape: "64" }], ["stem", "Linear", { out_features: 256 }],
        ["n1", "LayerNorm"], ["l1", "Linear", { out_features: 256 }], ["g1", "GELU"], ["d1", "Dropout", { p: 0.1 }], ["l2", "Linear", { out_features: 256 }], ["add1", "Add", {}, ["l2", "stem"]],
        ["n2", "LayerNorm"], ["l3", "Linear", { out_features: 256 }], ["g2", "GELU"], ["d2", "Dropout", { p: 0.1 }], ["l4", "Linear", { out_features: 256 }], ["add2", "Add", {}, ["l4", "add1"]],
        ["norm", "LayerNorm"], ["head", "Linear", { out_features: 2 }], ["out", "Output"],
      ]),
  },
  {
    id: "wide-deep",
    label: "Wide & Deep (binary)",
    data: "Tabular",
    model: "Wide & Deep",
    make: () =>
      dag("wide and deep", [
        ["in", "Input", { shape: "64" }], ["wide", "Linear", { out_features: 1 }, "in"], ["d1", "Linear", { out_features: 256 }, "in"], ["r1", "ReLU"], ["d2", "Linear", { out_features: 128 }], ["r2", "ReLU"], ["d3", "Linear", { out_features: 1 }],
        ["add", "Add", {}, ["wide", "d3"]], ["out", "Output"],
      ]),
  },
  {
    id: "ft-transformer",
    label: "Feature-token transformer",
    data: "Tabular",
    model: "FT-Transformer",
    make: () => dag("ft transformer", [["in", "Input", { shape: "32" }], ["cols", "Reshape", { shape: "-1,1" }], ["tok", "Linear", { out_features: 64 }], ...blocks(3, { nhead: 8, dim_feedforward: 256 }), ...head(2)]),
  },
  {
    id: "tab-autoencoder",
    label: "Autoencoder for anomaly detection",
    data: "Tabular",
    model: "Autoencoder",
    make: () =>
      dag("tabular autoencoder", [["in", "Input", { shape: "64" }], ["e1", "Linear", { out_features: 32 }], ["a1", "ReLU"], ["code", "Linear", { out_features: 8 }], ["a2", "ReLU"], ["d1", "Linear", { out_features: 32 }], ["a3", "ReLU"], ["d2", "Linear", { out_features: 64 }], ["out", "Output"]]),
  },

  // ---------------------------------------------------------------- images [channels, height, width]
  {
    id: "lenet",
    label: "LeNet-5 digits",
    data: "Images",
    model: "LeNet-5",
    make: () =>
      dag("lenet5", [
        ["in", "Input", { shape: "1,28,28" }], ["c1", "Conv2d", { out_channels: 6, kernel_size: 5, padding: 2 }], ["t1", "Tanh"], ["p1", "AvgPool2d"], ["c2", "Conv2d", { out_channels: 16, kernel_size: 5, padding: 0 }], ["t2", "Tanh"], ["p2", "AvgPool2d"],
        ["flat", "Flatten"], ["f1", "Linear", { out_features: 120 }], ["t3", "Tanh"], ["f2", "Linear", { out_features: 84 }], ["t4", "Tanh"], ["head", "Linear", { out_features: 10 }], ["out", "Output"],
      ]),
  },
  {
    id: "cnn",
    label: "CNN image classifier",
    data: "Images",
    model: "CNN",
    make: () =>
      chain("cnn classifier", [
        ["Input", { shape: "3,32,32" }], ["Conv2d", { out_channels: 32 }], ["BatchNorm"], ["ReLU"], ["MaxPool2d"],
        ["Conv2d", { out_channels: 64 }], ["BatchNorm"], ["ReLU"], ["MaxPool2d"], ["AdaptiveAvgPool2d"], ["Flatten"], ["Linear", { out_features: 10 }], ["Output"],
      ]),
  },
  {
    id: "vgg",
    label: "VGG-style, 3 stages",
    data: "Images",
    model: "VGG",
    make: () =>
      dag("vgg net", [
        ["in", "Input", { shape: "3,64,64" }],
        ...[64, 128, 256].flatMap((c, i): Spec[] => [...cbr(`s${i}a`, "Conv2d", { out_channels: c }), ...cbr(`s${i}b`, "Conv2d", { out_channels: c }), [`s${i}p`, "MaxPool2d"]]),
        ["gap", "AdaptiveAvgPool2d"], ["flat", "Flatten"], ["drop", "Dropout", { p: 0.5 }], ["head", "Linear", { out_features: 10 }], ["out", "Output"],
      ]),
  },
  {
    id: "resnet",
    label: "Residual block",
    data: "Images",
    model: "ResNet",
    make: () => {
      const g = chain("residual net", [["Input", { shape: "3,32,32" }], ["Conv2d", { out_channels: 64 }], ["BatchNorm"], ["ReLU"]]);
      const stem = g.nodes.at(-1)!;
      const c1 = node("Conv2d", 300, 408, { out_channels: 64 }), b1 = node("BatchNorm", 300, 500), r1 = node("ReLU", 300, 592), c2 = node("Conv2d", 300, 684, { out_channels: 64 }), b2 = node("BatchNorm", 300, 776);
      const add = node("Add", 80, 868), r2 = node("ReLU", 80, 960), gap = node("AdaptiveAvgPool2d", 80, 1052), fl = node("Flatten", 80, 1144), fc = node("Linear", 80, 1236, { out_features: 10 }), out = node("Output", 80, 1328);
      g.nodes.push(c1, b1, r1, c2, b2, add, r2, gap, fl, fc, out);
      const seq = [stem, c1, b1, r1, c2, b2, add, r2, gap, fl, fc, out];
      g.edges.push(...seq.slice(1).map((n, i) => ({ from: seq[i]!.id, to: n.id })), { from: stem.id, to: add.id });
      return g;
    },
  },
  {
    id: "mobilenet",
    label: "MobileNet-style, depthwise separable",
    data: "Images",
    model: "MobileNet",
    make: () =>
      dag("mobile net", [
        ["in", "Input", { shape: "3,96,96" }], ...cbr("stem", "Conv2d", { out_channels: 32, stride: 2 }),
        ...cbr("dw1", "Conv2d", { out_channels: 32, groups: 32 }), ...cbr("pw1", "Conv2d", { out_channels: 64, kernel_size: 1, padding: 0 }),
        ...cbr("dw2", "Conv2d", { out_channels: 64, groups: 64, stride: 2 }), ...cbr("pw2", "Conv2d", { out_channels: 128, kernel_size: 1, padding: 0 }),
        ...cbr("dw3", "Conv2d", { out_channels: 128, groups: 128 }), ...cbr("pw3", "Conv2d", { out_channels: 128, kernel_size: 1, padding: 0 }),
        ["gap", "AdaptiveAvgPool2d"], ["flat", "Flatten"], ["head", "Linear", { out_features: 10 }], ["out", "Output"],
      ]),
  },
  {
    id: "vit",
    label: "Vision Transformer, 8×8 patches",
    data: "Images",
    model: "ViT",
    make: () => dag("vision transformer", [["in", "Input", { shape: "3,64,64" }], ["patch", "Conv2d", { out_channels: 192, kernel_size: 8, stride: 8, padding: 0 }], ...tokens(192), ...blocks(4, { nhead: 6, dim_feedforward: 768 }), ...head(10)]),
  },
  {
    id: "unet",
    label: "U-Net segmentation",
    data: "Images",
    model: "U-Net",
    make: () => unet("unet segmentation", "3,64,64", 2, "regress"),
  },

  // ---------------------------------------------------------------- video [channels, frames, height, width]
  {
    id: "c3d",
    label: "3D CNN action recognition (C3D-style)",
    data: "Video",
    model: "3D CNN",
    make: () =>
      dag("video 3d cnn", [
        ["in", "Input", { shape: "3,16,64,64" }], ...cbr("s1", "Conv3d", { out_channels: 32 }), ["p1", "MaxPool3d"], ...cbr("s2", "Conv3d", { out_channels: 64 }), ["p2", "MaxPool3d"], ...cbr("s3", "Conv3d", { out_channels: 128 }),
        ["gap", "AdaptiveAvgPool3d"], ["flat", "Flatten"], ["head", "Linear", { out_features: 10 }], ["out", "Output"],
      ]),
  },
  {
    id: "cnn-lstm-video",
    label: "CNN features + LSTM over frames",
    data: "Video",
    model: "CNN + LSTM",
    make: () =>
      dag("video cnn lstm", [
        ["in", "Input", { shape: "3,16,64,64" }], ...cbr("s1", "Conv3d", { out_channels: 32 }), ...cbr("s2", "Conv3d", { out_channels: 64, stride: 2 }),
        ["frames", "AdaptiveAvgPool3d", { time_size: 8, output_size: 1 }], ["seq", "Reshape", { shape: "64,8" }], ["time", "Permute", { order: "1,0" }],
        ["lstm", "LSTM", { hidden_size: 128 }], ["last", "SequencePool", { mode: "last" }], ["head", "Linear", { out_features: 10 }], ["out", "Output"],
      ]),
  },
  {
    id: "video-vit",
    label: "Video transformer, 8×8×8 tubelets",
    data: "Video",
    model: "Video ViT",
    make: () => dag("video transformer", [["in", "Input", { shape: "3,16,64,64" }], ["tubelet", "Conv3d", { out_channels: 192, kernel_size: 8, stride: 8, padding: 0 }], ...tokens(192), ...blocks(4, { nhead: 6, dim_feedforward: 768 }), ...head(10)]),
  },

  // ---------------------------------------------------------------- audio
  {
    id: "m5",
    label: "1-D CNN on raw waveform (M5), 1 s at 16 kHz",
    data: "Audio",
    model: "1-D CNN",
    make: () =>
      dag("waveform cnn", [
        ["in", "Input", { shape: "1,16000" }], ...cbr("s1", "Conv1d", { out_channels: 128, kernel_size: 80, stride: 4, padding: 0 }), ["p1", "MaxPool1d", { kernel_size: 4, stride: 4 }],
        ...cbr("s2", "Conv1d", { out_channels: 128 }), ["p2", "MaxPool1d", { kernel_size: 4, stride: 4 }], ...cbr("s3", "Conv1d", { out_channels: 256 }), ["p3", "MaxPool1d", { kernel_size: 4, stride: 4 }],
        ["gap", "AdaptiveAvgPool1d"], ["flat", "Flatten"], ["head", "Linear", { out_features: 35 }], ["out", "Output"],
      ]),
  },
  {
    id: "spec-cnn",
    label: "CNN on mel spectrogram (sound events)",
    data: "Audio",
    model: "Spectrogram CNN",
    make: () =>
      dag("spectrogram cnn", [
        ["in", "Input", { shape: "1,64,128" }], ...cbr("s1", "Conv2d", { out_channels: 32 }), ["p1", "MaxPool2d"], ...cbr("s2", "Conv2d", { out_channels: 64 }), ["p2", "MaxPool2d"], ...cbr("s3", "Conv2d", { out_channels: 128 }),
        ["gap", "AdaptiveAvgPool2d"], ["flat", "Flatten"], ["drop", "Dropout", { p: 0.3 }], ["head", "Linear", { out_features: 50 }], ["out", "Output"],
      ]),
  },
  {
    id: "crnn",
    label: "CRNN: CNN + GRU over time",
    data: "Audio",
    model: "CRNN",
    make: () =>
      dag("audio crnn", [
        ["in", "Input", { shape: "1,64,128" }], ...cbr("s1", "Conv2d", { out_channels: 32 }), ["p1", "MaxPool2d"], ...cbr("s2", "Conv2d", { out_channels: 64 }), ["p2", "MaxPool2d"],
        ["frames", "Reshape", { shape: "1024,32" }], ["time", "Permute", { order: "1,0" }], ["gru", "GRU", { hidden_size: 128, bidirectional: true }], ["pool", "SequencePool", { mode: "mean" }], ["head", "Linear", { out_features: 10 }], ["out", "Output"],
      ]),
  },
  {
    id: "ast",
    label: "Audio spectrogram transformer, 16×16 patches",
    data: "Audio",
    model: "AST",
    make: () => dag("audio transformer", [["in", "Input", { shape: "1,128,128" }], ["patch", "Conv2d", { out_channels: 192, kernel_size: 16, stride: 16, padding: 0 }], ...tokens(192), ...blocks(4, { nhead: 6, dim_feedforward: 768 }), ...head(50)]),
  },
  {
    id: "asr",
    label: "Speech recognition encoder, characters per frame",
    data: "Audio",
    model: "Conformer-lite",
    make: () =>
      dag("speech encoder", [
        ["in", "Input", { shape: "80,400" }], ["sub1", "Conv1d", { out_channels: 256, stride: 2 }], ["g1", "GELU"], ["sub2", "Conv1d", { out_channels: 256, stride: 2 }], ["g2", "GELU"],
        ["time", "Permute", { order: "1,0" }], ["pos", "PositionEmbedding"], ...blocks(4, { nhead: 4, dim_feedforward: 1024 }), ["norm", "LayerNorm"], ["chars", "Linear", { out_features: 32 }], ["out", "Output", { loss: "classify" }],
      ]),
  },

  // ---------------------------------------------------------------- time series [steps, features]
  {
    id: "lstm-forecast",
    label: "LSTM forecaster, 24 steps ahead",
    data: "Time series",
    model: "LSTM",
    make: () => dag("lstm forecaster", [["in", "Input", { shape: "96,8" }], ["lstm", "LSTM", { hidden_size: 128, num_layers: 2 }], ["last", "SequencePool", { mode: "last" }], ["head", "Linear", { out_features: 24 }], ["out", "Output", { loss: "regress" }]]),
  },
  {
    id: "gru-classify",
    label: "BiGRU sequence classifier (activity recognition)",
    data: "Time series",
    model: "GRU",
    make: () => dag("gru classifier", [["in", "Input", { shape: "128,9" }], ["gru", "GRU", { hidden_size: 64, bidirectional: true }], ["pool", "SequencePool", { mode: "mean" }], ["head", "Linear", { out_features: 6 }], ["out", "Output"]]),
  },
  {
    id: "tcn",
    label: "Dilated CNN forecaster (TCN-style)",
    data: "Time series",
    model: "TCN",
    make: () =>
      dag("tcn forecaster", [
        ["in", "Input", { shape: "96,8" }], ["chan", "Permute", { order: "1,0" }],
        ...[1, 2, 4, 8].flatMap((d): Spec[] => [[`c${d}`, "Conv1d", { out_channels: 64, padding: d, dilation: d }], [`r${d}`, "ReLU"]]),
        ["gap", "AdaptiveAvgPool1d"], ["flat", "Flatten"], ["head", "Linear", { out_features: 24 }], ["out", "Output", { loss: "regress" }],
      ]),
  },
  {
    id: "fcn-ts",
    label: "Fully convolutional classifier",
    data: "Time series",
    model: "FCN",
    make: () =>
      dag("fcn classifier", [
        ["in", "Input", { shape: "128,3" }], ["chan", "Permute", { order: "1,0" }], ...cbr("s1", "Conv1d", { out_channels: 128, kernel_size: 7, padding: 3 }), ...cbr("s2", "Conv1d", { out_channels: 256, kernel_size: 5, padding: 2 }),
        ...cbr("s3", "Conv1d", { out_channels: 128 }), ["gap", "AdaptiveAvgPool1d"], ["flat", "Flatten"], ["head", "Linear", { out_features: 5 }], ["out", "Output"],
      ]),
  },
  {
    id: "ts-transformer",
    label: "Transformer forecaster, 24 steps ahead",
    data: "Time series",
    model: "Transformer",
    make: () =>
      dag("transformer forecaster", [["in", "Input", { shape: "96,8" }], ["proj", "Linear", { out_features: 128 }], ["pos", "PositionEmbedding"], ...blocks(3, { nhead: 8, dim_feedforward: 512 }), ["norm", "LayerNorm"], ["last", "SequencePool", { mode: "last" }], ["head", "Linear", { out_features: 24 }], ["out", "Output", { loss: "regress" }]]),
  },

  // ---------------------------------------------------------------- generative
  {
    id: "conv-autoencoder",
    label: "Convolutional autoencoder",
    data: "Generative",
    model: "Autoencoder",
    make: () =>
      dag("conv autoencoder", [
        ["in", "Input", { shape: "3,32,32" }], ["e1", "Conv2d", { out_channels: 32, stride: 2 }], ["a1", "ReLU"], ["e2", "Conv2d", { out_channels: 64, stride: 2 }], ["a2", "ReLU"],
        ["d1", "ConvTranspose2d", { out_channels: 32 }], ["a3", "ReLU"], ["d2", "ConvTranspose2d", { out_channels: 3 }], ["px", "Sigmoid"], ["out", "Output"],
      ]),
  },
  {
    id: "dcgan-g",
    label: "DCGAN generator, noise → 32×32 image",
    data: "Generative",
    model: "GAN generator",
    make: () =>
      dag("dcgan generator", [
        ["in", "Input", { shape: "100" }], ["proj", "Linear", { out_features: 4096 }], ["grid", "Reshape", { shape: "256,4,4" }], ["b0", "BatchNorm"], ["r0", "ReLU"],
        ["u1", "ConvTranspose2d", { out_channels: 128 }], ["b1", "BatchNorm"], ["r1", "ReLU"], ["u2", "ConvTranspose2d", { out_channels: 64 }], ["b2", "BatchNorm"], ["r2", "ReLU"],
        ["u3", "ConvTranspose2d", { out_channels: 3 }], ["px", "Tanh"], ["out", "Output", { loss: "regress" }],
      ]),
  },
  {
    id: "dcgan-d",
    label: "DCGAN discriminator, real vs fake",
    data: "Generative",
    model: "GAN discriminator",
    make: () =>
      dag("dcgan discriminator", [
        ["in", "Input", { shape: "3,32,32" }], ["c1", "Conv2d", { out_channels: 64, kernel_size: 4, stride: 2 }], ["l1", "LeakyReLU", { negative_slope: 0.2 }],
        ["c2", "Conv2d", { out_channels: 128, kernel_size: 4, stride: 2 }], ["b2", "BatchNorm"], ["l2", "LeakyReLU", { negative_slope: 0.2 }],
        ["c3", "Conv2d", { out_channels: 256, kernel_size: 4, stride: 2 }], ["b3", "BatchNorm"], ["l3", "LeakyReLU", { negative_slope: 0.2 }],
        ["flat", "Flatten"], ["real", "Linear", { out_features: 1 }], ["out", "Output", { loss: "binary" }],
      ]),
  },
  {
    id: "unet-denoiser",
    label: "U-Net denoiser, one noise level",
    data: "Generative",
    model: "U-Net denoiser",
    make: () => unet("unet denoiser", "3,32,32", 3, "auto"),
  },
  {
    id: "ddpm",
    label: "DDPM: time-conditioned U-Net, 32×32 images",
    data: "Generative",
    model: "Diffusion (DDPM)",
    make: () =>
      dag("ddpm unet", [
        ["in", "Input", { shape: "3,32,32" }], ["time", "Timestep", { dim: 128 }, []],
        ["e1", "Conv2d", { out_channels: 64 }, "in"], ["t1", "Linear", { out_features: 64 }, "time"], ["a1", "Add", {}, ["e1", "t1"]], ["r1", "SiLU"], ["p1", "MaxPool2d"],
        ["e2", "Conv2d", { out_channels: 128 }], ["t2", "Linear", { out_features: 128 }, "time"], ["a2", "Add", {}, ["e2", "t2"]], ["r2", "SiLU"], ["p2", "MaxPool2d"],
        ["mid", "Conv2d", { out_channels: 256 }], ["t3", "Linear", { out_features: 256 }, "time"], ["a3", "Add", {}, ["mid", "t3"]], ["r3", "SiLU"],
        ["u2", "Upsample"], ["cat2", "Concat", { dim: 0 }, ["u2", "r2"]], ["d2", "Conv2d", { out_channels: 128 }], ["r4", "SiLU"],
        ["u1", "Upsample"], ["cat1", "Concat", { dim: 0 }, ["u1", "r1"]], ["d1", "Conv2d", { out_channels: 64 }], ["r5", "SiLU"],
        ["noise", "Conv2d", { out_channels: 3, kernel_size: 1, padding: 0 }], ["out", "Output"],
      ]),
  },
  {
    id: "dit",
    label: "Diffusion Transformer on 4×32×32 latents (DiT-style)",
    data: "Generative",
    model: "Diffusion Transformer (DiT)",
    make: () =>
      dag("diffusion transformer", [
        ["in", "Input", { shape: "4,32,32" }], ["time", "Timestep", { dim: 256 }, []],
        ["patch", "Conv2d", { out_channels: 256, kernel_size: 2, stride: 2, padding: 0 }, "in"], ...tokens(256), ["cond", "Add", {}, ["pos", "time"]],
        ...blocks(4, { nhead: 8, dim_feedforward: 1024 }), ["norm", "LayerNorm"],
        // Un-patchify: each token's 4·2·2 values back to its 2×2 patch of the 4×32×32 latent.
        ["unpatch", "Linear", { out_features: 16 }], ["chan", "Permute", { order: "1,0" }], ["split", "Reshape", { shape: "4,2,2,16,16" }], ["interleave", "Permute", { order: "0,3,1,4,2" }], ["latent", "Reshape", { shape: "4,32,32" }],
        ["out", "Output"],
      ]),
  },
  {
    id: "transformer",
    label: "GPT-style language model (causal)",
    data: "Generative",
    model: "GPT",
    make: () =>
      dag("tiny gpt", [["in", "Input", { shape: "256", dtype: T }], ["emb", "Embedding", { num_embeddings: 8000, embedding_dim: 256 }], ["pos", "PositionEmbedding"], ...blocks(2, { nhead: 8, dim_feedforward: 1024, causal: true }), ["norm", "LayerNorm"], ["lm", "Linear", { out_features: 8000 }], ["out", "Output"]]),
  },
  {
    id: "char-rnn",
    label: "Character-level LSTM text generator",
    data: "Generative",
    model: "Char-RNN",
    make: () => dag("char rnn", [["in", "Input", { shape: "128", dtype: T }], ["emb", "Embedding", { num_embeddings: 128, embedding_dim: 64 }], ["lstm", "LSTM", { hidden_size: 512, num_layers: 2 }], ["next", "Linear", { out_features: 128 }], ["out", "Output"]]),
  },
];

/** Encoder → bottleneck → decoder, with skip connections joining matching resolutions. */
function unet(name: string, shape: string, outChannels: number, loss: string): ModelGraph {
  return dag(name, [
    ["in", "Input", { shape }], ["e1", "Conv2d", { out_channels: 32 }], ["r1", "ReLU"], ["p1", "MaxPool2d"], ["e2", "Conv2d", { out_channels: 64 }], ["r2", "ReLU"], ["p2", "MaxPool2d"],
    ["mid", "Conv2d", { out_channels: 128 }], ["r3", "ReLU"], ["u2", "Upsample"], ["cat2", "Concat", { dim: 0 }, ["u2", "r2"]], ["d2", "Conv2d", { out_channels: 64 }], ["r4", "ReLU"],
    ["u1", "Upsample"], ["cat1", "Concat", { dim: 0 }, ["u1", "r1"]], ["d1", "Conv2d", { out_channels: 32 }], ["r5", "ReLU"], ["head", "Conv2d", { out_channels: outChannels, kernel_size: 1, padding: 0 }], ["out", "Output", { loss }],
  ]);
}

/** Templates for the picker: grouped by data type (in TEMPLATE_DATA order), then sorted by model. Blank stays separate. */
export function templateGroups(): { data: TemplateData; templates: ModelTemplate[] }[] {
  return TEMPLATE_DATA.map((data) => ({ data, templates: TEMPLATES.filter((t) => t.data === data).sort((a, b) => (a.model ?? a.label).localeCompare(b.model ?? b.label)) })).filter((g) => g.templates.length);
}
