// How long a run will take and what it will cost, and what the same run would take on other GPUs.
// Progress comes from the steps the run logs (or its progress bar); the length of the run comes
// from its config. Speeds of other GPUs are rough, from public training benchmarks, and always
// labelled as estimates.
import { primaryMetricKey, type LogLine, type RunSummary } from "./summary.ts";

export interface Forecast {
  currentStep: number;
  totalSteps: number;
  /** Where the total came from, e.g. "max_steps in the config". */
  totalSource: string;
  stepsPerSec: number;
  /** 0–1. */
  progress: number;
  elapsedSec: number;
  remainingSec: number;
  /** Seconds the whole run takes at the current speed. */
  fullSec: number;
}

/** Config keys that give the run's length in optimizer steps, most specific first. */
const TOTAL_KEYS = ["total_steps", "max_steps", "num_training_steps", "train_steps", "num_steps", "max_iters", "num_iterations", "iterations", "steps"];
const EPOCH_KEYS = ["epochs", "num_epochs", "num_train_epochs", "max_epochs", "n_epochs"];
const PER_EPOCH_KEYS = ["steps_per_epoch", "iters_per_epoch", "batches_per_epoch"];

function positiveInt(v: unknown): number | null {
  const n = typeof v === "string" ? Number(v) : v;
  return typeof n === "number" && Number.isFinite(n) && n >= 1 ? Math.round(n) : null;
}

/** The run's length in steps from its config, with the key it came from. */
export function totalStepsFromConfig(config: Record<string, unknown>): { total: number; source: string } | null {
  const lower = new Map(Object.entries(config).map(([k, v]) => [k.toLowerCase().replace(/^.*[./]/, ""), v]));
  for (const k of TOTAL_KEYS) {
    const n = positiveInt(lower.get(k));
    if (n) return { total: n, source: `${k} in the config` };
  }
  for (const e of EPOCH_KEYS) {
    const epochs = positiveInt(lower.get(e));
    if (!epochs) continue;
    for (const p of PER_EPOCH_KEYS) {
      const per = positiveInt(lower.get(p));
      if (per) return { total: epochs * per, source: `${e} × ${p} in the config` };
    }
  }
  return null;
}

// tqdm and similar: " 45%|████▌     | 450/1000 [00:10<00:12, 44.1it/s]"
const BAR_RE = /(\d+)\/(\d+)\s*\[\d/;

/** Progress from the newest progress bar in the logs: its position, total, and rate over the window. */
export function progressFromLogs(logs: LogLine[], windowSec: number): { current: number; total: number; stepsPerSec: number | null; ts: number } | null {
  let last: { n: number; total: number; ts: number } | null = null;
  let first: { n: number; ts: number } | null = null;
  for (let i = logs.length - 1; i >= 0; i--) {
    const l = logs[i]!;
    const m = BAR_RE.exec(l.line);
    if (!m) continue;
    const n = Number(m[1]);
    const total = Number(m[2]);
    if (!(total > 0) || n > total) continue;
    if (!last) {
      last = { n, total, ts: l.ts };
      continue;
    }
    if (total !== last.total || n > last.n || last.ts - l.ts > windowSec) break;
    first = { n, ts: l.ts };
  }
  if (!last) return null;
  const rate = first && last.ts - first.ts >= 20 && last.n > first.n ? (last.n - first.n) / (last.ts - first.ts) : null;
  return { current: last.n, total: last.total, stepsPerSec: rate, ts: last.ts };
}

/**
 * The forecast for a running run, or null until there's enough to go on: a known length, and at
 * least a couple of minutes of progress. `config` is the effective config (command-line + SDK).
 */
export function forecastRun(s: RunSummary, config: Record<string, unknown>, now: number): Forecast | null {
  if (s.startedAt === null) return null;
  const elapsed = (s.endedAt ?? now) - s.startedAt;
  if (elapsed < 120) return null;
  const window = Math.min(900, Math.max(120, elapsed / 2));

  const fromConfig = totalStepsFromConfig(config);
  const key = primaryMetricKey(Object.keys(s.metrics));
  const series = key ? s.metrics[key]! : [];
  let current: number | null = null;
  let rate: number | null = null;
  let lastTs = now;
  if (fromConfig && series.length >= 4) {
    const last = series[series.length - 1]!;
    const firstIdx = series.findIndex((p) => p.ts >= last.ts - window);
    const first = series[Math.max(0, firstIdx)]!;
    if (last.ts - first.ts >= 60 && last.step > first.step) {
      current = Math.max(last.step, s.latestStep ?? 0);
      rate = (last.step - first.step) / (last.ts - first.ts);
      lastTs = last.ts;
    }
  }
  let total = fromConfig?.total ?? null;
  let source = fromConfig?.source ?? "";
  if (rate === null) {
    const bar = progressFromLogs(s.logs, window);
    if (bar?.stepsPerSec) {
      current = bar.current;
      rate = bar.stepsPerSec;
      lastTs = bar.ts;
      // The bar's own position only means something against the bar's own total; it often counts one epoch.
      if (fromConfig?.total !== bar.total) {
        total = bar.total;
        source = "the progress bar (it may cover one epoch, not the whole run)";
      }
    }
  }
  if (rate === null || current === null || total === null || !(rate > 0)) return null;
  // Past the planned length (or a config that undercounts): nothing sensible to forecast.
  if (current >= total) return null;
  const stepsLeft = total - current;
  const remainingSec = Math.max(0, stepsLeft / rate - Math.max(0, now - lastTs));
  return {
    currentStep: current,
    totalSteps: total,
    totalSource: source,
    stepsPerSec: rate,
    progress: current / total,
    elapsedSec: elapsed,
    remainingSec,
    fullSec: total / rate,
  };
}

// ------------------------------------------------------------ cost

export interface CostForecast {
  /** "credits" on Converlt Cloud pods, "usd" on machines with a user-entered hourly rate. */
  unit: "credits" | "usd";
  perHour: number;
  soFar: number;
  remaining: number;
  total: number;
}

export function forecastCost(f: Forecast, perHour: number, unit: CostForecast["unit"]): CostForecast {
  const soFar = (f.elapsedSec / 3600) * perHour;
  const remaining = (f.remainingSec / 3600) * perHour;
  return { unit, perHour, soFar, remaining, total: soFar + remaining };
}

// ------------------------------------------------------------ other GPUs

/**
 * Rough training speed relative to an A100 (= 1), blended from public mixed-precision training
 * benchmarks. Memory bandwidth and model size shift it, so treat any comparison as an estimate.
 */
const GPU_SPEED: [RegExp, number][] = [
  [/B200/i, 3.6],
  [/GH200|H200/i, 2.4],
  [/H100.*NVL/i, 2.0],
  [/H100.*PCIe/i, 1.6],
  [/H100/i, 2.2],
  [/MI300X/i, 2.0],
  [/A100/i, 1.0],
  [/RTX PRO 6000/i, 1.3],
  [/L40S/i, 0.85],
  [/L40\b/i, 0.7],
  [/RTX 6000 Ada/i, 0.8],
  [/RTX 5000 Ada/i, 0.55],
  [/RTX 4000 Ada/i, 0.3],
  [/RTX 2000 Ada/i, 0.2],
  [/RTX 5090/i, 1.05],
  [/RTX 5080/i, 0.6],
  [/RTX 4090/i, 0.75],
  [/RTX 4080/i, 0.5],
  [/RTX 3090/i, 0.45],
  [/RTX 3080/i, 0.35],
  [/A6000/i, 0.5],
  [/A5000/i, 0.35],
  [/A4500/i, 0.3],
  [/A4000/i, 0.25],
  [/A40\b/i, 0.5],
  [/A30\b/i, 0.55],
  [/A10G?\b/i, 0.3],
  [/L4\b/i, 0.25],
  [/V100/i, 0.4],
  [/T4\b/i, 0.12],
];

export function gpuSpeed(name: string | null | undefined): number | null {
  if (!name) return null;
  for (const [re, speed] of GPU_SPEED) if (re.test(name)) return speed;
  return null;
}

export interface GpuOfferLike {
  id: string;
  name: string;
  memoryGb: number;
  /** Credits per GPU per hour. */
  pricePerHour: number;
  stock?: string | null;
}

export interface GpuOption {
  offer: GpuOfferLike;
  count: number;
  /** Speed relative to the run's current GPU (2 = twice as fast). */
  speedup: number;
  /** The whole run, start to finish, on this GPU. */
  fullSec: number;
  /** Credits for the whole run. */
  fullCredits: number;
  faster: boolean;
  cheaper: boolean;
}

export interface GpuComparison {
  current: { name: string; count: number; fullSec: number; fullCredits: number | null };
  options: GpuOption[];
  /** The option to suggest first: the cheapest that is at most 1.5× slower, if it saves money. */
  recommended: GpuOption | null;
}

/**
 * The same run on other rentable GPUs. `currentCreditsPerHour` is the current machine's price in
 * credits (null when unknown); `peakMemMiBPerGpu` filters out GPUs too small for the run.
 */
export function compareGpus(
  f: Forecast,
  current: { name: string; count: number; creditsPerHour: number | null; peakMemMiBPerGpu: number | null },
  offers: GpuOfferLike[],
): GpuComparison | null {
  const base = gpuSpeed(current.name);
  if (!base) return null;
  const count = Math.max(1, current.count);
  const curCredits = current.creditsPerHour !== null ? (f.fullSec / 3600) * current.creditsPerHour : null;
  const cheapest = new Map<string, GpuOfferLike>();
  for (const o of offers) {
    if (o.stock === "None" || !(o.pricePerHour > 0)) continue;
    if (current.peakMemMiBPerGpu !== null && o.memoryGb * 1024 < current.peakMemMiBPerGpu * 1.1) continue;
    const prev = cheapest.get(o.name);
    if (!prev || o.pricePerHour < prev.pricePerHour) cheapest.set(o.name, o);
  }
  const options: GpuOption[] = [];
  for (const o of cheapest.values()) {
    const speed = gpuSpeed(o.name);
    if (!speed || o.name === current.name) continue;
    const speedup = speed / base;
    const fullSec = f.fullSec / speedup;
    const fullCredits = (fullSec / 3600) * o.pricePerHour * count;
    options.push({
      offer: o,
      count,
      speedup,
      fullSec,
      fullCredits,
      faster: speedup > 1.1,
      cheaper: curCredits !== null && fullCredits < curCredits * 0.9,
    });
  }
  options.sort((a, b) => a.fullCredits - b.fullCredits);
  const recommended = options.find((o) => o.speedup >= 1 / 1.5 && (curCredits === null || o.fullCredits < curCredits * 0.9)) ?? null;
  return { current: { name: current.name, count, fullSec: f.fullSec, fullCredits: curCredits }, options, recommended };
}
