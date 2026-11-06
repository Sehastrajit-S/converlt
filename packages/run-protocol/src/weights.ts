// Reading weight snapshots (run.watch(model)) per layer: which tensors belong to a module, and
// what in them looks wrong — non-finite values, collapsed or exploding weights, no gradient, or
// weights that never moved.
import type { WeightsEvent, WeightTensor } from "./types.ts";

/** "block1.self_attn.in_proj_weight" → "block1". */
export function moduleOf(tensorName: string): string {
  const i = tensorName.indexOf(".");
  return i < 0 ? tensorName : tensorName.slice(0, i);
}

export function tensorsOf(snapshot: WeightsEvent | undefined, module: string): WeightTensor[] {
  return snapshot ? snapshot.tensors.filter((t) => moduleOf(t.name) === module) : [];
}

export type WeightHealth = "ok" | "warning" | "error";

export interface WeightIssue {
  severity: Exclude<WeightHealth, "ok">;
  tensor: string;
  message: string;
}

/** The main weight of a layer (not its bias or norm shift), for headline numbers. */
export function mainTensor(tensors: WeightTensor[]): WeightTensor | undefined {
  return tensors.find((t) => /(^|\.)weight$/.test(t.name) && t.shape.length >= 2) ?? tensors.find((t) => /weight/.test(t.name)) ?? tensors[0];
}

const norm = (t: WeightTensor) => Math.sqrt(t.numel * (t.std * t.std + t.mean * t.mean));

/**
 * Problems in one layer's tensors at `latest`, compared against the run's first snapshot.
 * Biases and norm parameters legitimately start constant, so "collapsed" only applies to
 * multi-dimensional weights.
 */
export function weightIssues(latest: WeightTensor[], first?: WeightTensor[], steps?: { first: number | null; latest: number | null }): WeightIssue[] {
  const out: WeightIssue[] = [];
  for (const t of latest) {
    if (t.nonFinite)
      out.push({ severity: "error", tensor: t.name, message: `${t.nonFinite.toLocaleString("en-US")} of ${t.numel.toLocaleString("en-US")} values are NaN or Inf.` });
    else if (t.shape.length >= 2 && t.numel > 1 && t.std < 1e-8)
      out.push({ severity: "error", tensor: t.name, message: "Every value is the same, so all units compute the same thing. Check the initialization." });
    else if (t.absMax > 1e3) out.push({ severity: "warning", tensor: t.name, message: `Values reach ${t.absMax.toPrecision(3)}: the weights are blowing up. Lower the learning rate or add weight decay.` });
    if (t.gradNorm === 0 && !t.nonFinite)
      out.push({ severity: "warning", tensor: t.name, message: "Gradient is zero: this layer isn't learning. It may be frozen, disconnected from the loss, or behind dead ReLUs." });
    else if (t.gradNorm != null && t.gradNorm > 0 && norm(t) > 0 && t.gradNorm / norm(t) < 1e-7)
      out.push({ severity: "warning", tensor: t.name, message: "Gradient is tiny next to the weights (vanishing gradient). Normalization or residual connections help." });
  }
  // Weights that are bit-for-bit where they started after real training.
  const moved = steps?.first != null && steps.latest != null && steps.latest > steps.first;
  if (first && moved) {
    for (const t of latest) {
      const f = first.find((x) => x.name === t.name);
      if (!f || t.gradNorm === 0 || t.nonFinite) continue;
      const same = f.mean === t.mean && f.std === t.std && f.hist.min === t.hist.min && f.hist.max === t.hist.max;
      if (same) out.push({ severity: "warning", tensor: t.name, message: `Unchanged since step ${steps!.first}. Is it frozen (requires_grad=False) or missing from the optimizer?` });
    }
  }
  return out.sort((a, b) => (a.severity === b.severity ? 0 : a.severity === "error" ? -1 : 1));
}

export function healthOf(issues: WeightIssue[]): WeightHealth {
  return issues.some((i) => i.severity === "error") ? "error" : issues.length ? "warning" : "ok";
}
