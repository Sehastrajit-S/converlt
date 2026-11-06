// Before a run: how much GPU memory and time it should need, and which machine to run it on.
// Builder designs are estimated from their layer shapes; any other script from its earlier runs.
// These are estimates for choosing a machine, not promises: they're shown as "about".
import { gpuSpeed } from "./forecast.ts";
import { analyzeGraph, paramNum, type GraphAnalysis, type ModelGraph } from "./modelgraph.ts";
import { tokenizeCommand } from "./args.ts";

export interface JobEstimate {
  /** Peak GPU memory for training, MiB, including the CUDA context. */
  memMiB: number;
  params: number;
  /** Training FLOPs for the whole run (forward + backward), when the step count is known. */
  flops: number | null;
  steps: number | null;
  /** Where the numbers come from, e.g. "layer shapes, batch 64, 470 steps". */
  basis: string;
  /** Earlier run this is based on, for estimates from history. */
  fromRun?: string;
  /** Measured duration of that run and the GPU it ran on (for scaling to other GPUs). */
  measured?: { seconds: number; gpu: string | null };
}

const CUDA_CONTEXT_MIB = 450;
/** Weights, gradients and AdamW's two moments, fp32. */
const BYTES_PER_PARAM = 16;
/** Usable training throughput of an A100 on small and medium models (mixed precision, real efficiency). */
const A100_FLOPS = 60e12;
/** Kernel launches, the optimizer and data loading: a floor per step that small models never get under. */
const STEP_OVERHEAD_SEC = 0.004;
const CONV = new Set(["Conv1d", "Conv2d", "Conv3d", "ConvTranspose2d"]);
const prod = (s: number[]) => s.reduce((a, b) => a * b, 1);

/** Steps the generated training script takes (its --epochs 0 default: about 500 steps, at least 10 epochs). */
export function builderSteps(samples: number, batch: number, epochs = 0, maxSteps = 0): number {
  const perEpoch = Math.max(1, Math.ceil(samples / batch));
  const e = epochs || Math.min(1000, Math.max(10, Math.ceil(500 / perEpoch)));
  const total = e * perEpoch;
  return maxSteps ? Math.min(total, maxSteps) : total;
}

/**
 * Memory and compute of training a builder design. `samples` is the training split's size (null
 * when unknown: then only memory is estimated).
 */
export function estimateDesign(g: ModelGraph, opts: { batch: number; samples: number | null; epochs?: number }, a: GraphAnalysis = analyzeGraph(g)): JobEstimate | null {
  if (!a.ok) return null;
  const byId = new Map(g.nodes.map((n) => [n.id, n]));
  const inputOf = new Map<string, string>();
  for (const e of g.edges) if (!inputOf.has(e.to)) inputOf.set(e.to, e.from);
  let actElems = 0;
  let attnElems = 0;
  let fwdMacs = 0;
  for (const id of a.order) {
    const n = byId.get(id);
    const info = a.nodes[id];
    if (!n || !info?.shape) continue;
    const size = prod(info.shape);
    // Activations kept for the backward pass; in-place-able layers still keep their output.
    if (n.type !== "Input" && n.type !== "Reshape" && n.type !== "Flatten" && n.type !== "Permute") actElems += size;
    const positions = CONV.has(n.type) ? size / Math.max(1, info.shape[0]!) : size / Math.max(1, info.shape.at(-1)!);
    if (info.params && n.type !== "Embedding" && n.type !== "PositionEmbedding") fwdMacs += info.params * positions;
    if (n.type === "MultiheadAttention" || n.type === "TransformerEncoderLayer") {
      const src = inputOf.get(id);
      const s = (src && a.nodes[src]?.shape) || info.shape;
      const seq = s.length >= 2 ? s[0]! : 1;
      const d = s.at(-1)!;
      const heads = paramNum(n.type === "MultiheadAttention" ? n.params.num_heads : n.params.nhead, 1);
      attnElems += heads * seq * seq * 2; // scores and softmax
      fwdMacs += 2 * seq * seq * d; // QKᵀ and attention × V
      if (n.type === "TransformerEncoderLayer") actElems += size * 6; // norms, projections, feed-forward
    }
  }
  const b = Math.max(1, opts.batch);
  const actBytes = (actElems + attnElems) * b * 4 * 1.5; // fp32 plus autograd bookkeeping
  const memMiB = Math.ceil(CUDA_CONTEXT_MIB + (a.totalParams * BYTES_PER_PARAM + actBytes) / 2 ** 20);
  const steps = opts.samples ? builderSteps(opts.samples, b, opts.epochs ?? 0) : null;
  const flops = steps !== null ? 3 * 2 * fwdMacs * b * steps : null;
  return {
    memMiB,
    params: a.totalParams,
    flops,
    steps,
    basis: `layer shapes, batch ${b}${steps !== null ? `, ${steps.toLocaleString("en-US")} steps` : ""}`,
  };
}

/** Seconds to train on one GPU of this kind ("cpu" and "mps" are understood too); null if unknown. */
export function estimateSeconds(e: JobEstimate, gpu: string | null): number | null {
  if (e.measured) {
    if (e.measured.gpu === gpu) return e.measured.seconds;
    const from = gpuSpeed(e.measured.gpu);
    const to = gpuSpeed(gpu);
    return from && to ? e.measured.seconds * (from / to) : null;
  }
  if (e.flops === null || e.steps === null) return null;
  const rate = gpu === "cpu" ? 0.15e12 : gpu === "mps" ? 3e12 : (gpuSpeed(gpu) ?? 0.25) * A100_FLOPS;
  const overhead = gpu === "cpu" ? STEP_OVERHEAD_SEC / 2 : STEP_OVERHEAD_SEC;
  return e.flops / rate + e.steps * overhead;
}

/** The script a command runs ("train.py"), to match it with earlier runs. */
export function commandScript(command: string): string | null {
  const t = tokenizeCommand(command);
  const i = t.findIndex((x) => /\.py$/.test(x));
  return i >= 0 ? t[i]! : null;
}

export interface PastRun {
  name: string;
  command: string;
  status: string;
  peakGpuMemMiB: number | null;
  durationSec: number | null;
  gpu: string | null;
}

/** From the latest finished run of the same script: its peak memory and duration. */
export function estimateFromHistory(command: string, past: PastRun[]): JobEstimate | null {
  const script = commandScript(command);
  if (!script) return null;
  const same = past.filter((r) => commandScript(r.command) === script && r.status === "completed" && r.durationSec);
  const exact = same.find((r) => r.command.trim() === command.trim());
  const r = exact ?? same[0];
  if (!r) return null;
  return {
    memMiB: r.peakGpuMemMiB ?? 0,
    params: 0,
    flops: null,
    steps: null,
    basis: `${r.name}${exact ? "" : " (same script, other settings)"}`,
    fromRun: r.name,
    measured: { seconds: r.durationSec!, gpu: r.gpu },
  };
}

export interface MachineCandidate {
  id: string;
  name: string;
  /** Reachable and set up for training. */
  ready: boolean;
  /** Runs it is running now. */
  busy: number;
  gpus: { name: string; memTotalMiB: number; memUsedMiB: number }[];
  /** Credits (or dollars) per hour; null or 0 for the user's own hardware. */
  pricePerHour: number | null;
  /** Apple silicon GPU (no CUDA GPUs listed). */
  mps?: boolean;
}

export interface MachineChoice {
  machine: MachineCandidate;
  seconds: number | null;
  /** Fits in the free memory of its GPU (or is CPU). */
  fits: boolean;
  cost: number | null;
  reason: string;
}

const short = (s: number) => (s < 90 ? `${Math.max(1, Math.round(s))}s` : s < 5400 ? `${Math.round(s / 60)} min` : `${(s / 3600).toFixed(1)} h`);
export const fmtSeconds = short;

/**
 * Every machine ranked for this job: ones it fits on first, then idle before busy, then fastest
 * (paid machines only when they're at least twice as fast as the best free one).
 */
export function rankMachines(e: JobEstimate | null, machines: MachineCandidate[]): MachineChoice[] {
  const need = e?.memMiB ?? 0;
  const choices = machines
    .filter((m) => m.ready)
    .map((m): MachineChoice => {
      const gpu = m.gpus.length ? m.gpus.reduce((x, y) => (y.memTotalMiB - y.memUsedMiB > x.memTotalMiB - x.memUsedMiB ? y : x)) : null;
      const free = gpu ? gpu.memTotalMiB - gpu.memUsedMiB : null;
      const kind = gpu?.name ?? (m.mps ? "mps" : "cpu");
      const seconds = e ? estimateSeconds(e, kind) : null;
      const fits = free === null || need === 0 || need * 1.15 <= free;
      const paid = !!m.pricePerHour && m.pricePerHour > 0;
      const cost = paid && seconds !== null ? (seconds / 3600) * m.pricePerHour! : null;
      const parts = [gpu ? `${gpu.name}, ${Math.round((free ?? 0) / 1024)} GB free` : kind === "mps" ? "Apple GPU" : "CPU only"];
      if (!fits) parts.push(`needs about ${Math.ceil((need * 1.15) / 1024)} GB`);
      if (m.busy) parts.push(`${m.busy} run${m.busy > 1 ? "s" : ""} already running`);
      if (seconds !== null) parts.push(`about ${short(seconds)}`);
      if (cost !== null) parts.push(`about ${cost.toFixed(2)} credits`);
      return { machine: m, seconds, fits, cost, reason: parts.join(" · ") };
    });
  const score = (c: MachineChoice) => {
    let s = c.seconds ?? (c.machine.gpus.length ? 1e6 : 1e7);
    // Paying only when it at least halves the time.
    if (c.cost) s *= 2;
    if (c.machine.busy) s += 1e9 * c.machine.busy;
    if (!c.fits) s += 1e12;
    return s;
  };
  return choices.sort((x, y) => score(x) - score(y));
}
