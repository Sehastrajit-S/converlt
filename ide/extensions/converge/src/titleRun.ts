// The run the Converlt IDE's title bar shows: the newest live run, else one that ended in the
// last few minutes, with its progress, time left, loss and most serious problem.
import { forecastRun, isTerminal, primaryMetricKey, seriesStats, type DiagnosticEvent } from "@converge/run-protocol";
import type { ConvergeService } from "@converge/core";

export interface TitleRun {
  id: string;
  name: string;
  status: string;
  progress: number | null;
  etaSec: number | null;
  metric: { key: string; value: number | null } | null;
  problem: { severity: "error" | "warning"; text: string } | null;
  others: number;
}

const RECENT_SEC = 600;

const PROBLEM: Record<DiagnosticEvent["kind"], string> = {
  nan: "NaN loss",
  oom: "Out of GPU memory",
  dataloader: "Data loader is the bottleneck",
  perf: "GPU underused",
  stall: "No output: may be stalled",
  exception: "Crashed",
  exit: "Exited with an error",
  launch: "Couldn't start",
};

export function titleRun(service: ConvergeService, now = Date.now() / 1000): TitleRun | null {
  const runs = service.listRuns();
  const live = runs.filter((r) => !isTerminal(r.status));
  const pick = live[0] ?? runs.find((r) => isTerminal(r.status) && r.endedAt !== null && now - r.endedAt < RECENT_SEC);
  if (!pick) return null;
  const v = service.getRun(pick.runId);
  if (!v) return null;
  const s = v.summary;
  const f = pick.status === "running" ? forecastRun(s, v.effectiveConfig, now) : null;
  const key = primaryMetricKey(Object.keys(s.metrics));
  const worst = s.diagnostics.find((d) => d.severity === "error") ?? s.diagnostics.find((d) => d.severity === "warning");
  return {
    id: pick.runId,
    name: pick.name,
    status: pick.status,
    progress: f?.progress ?? null,
    etaSec: f?.remainingSec ?? null,
    metric: key ? { key, value: seriesStats(s.metrics[key]).last } : null,
    problem: worst ? { severity: worst.severity === "error" ? "error" : "warning", text: `${PROBLEM[worst.kind] ?? worst.kind}${worst.step != null ? ` at step ${worst.step.toLocaleString()}` : ""}` } : null,
    others: Math.max(0, live.length - (isTerminal(pick.status) ? 0 : 1)),
  };
}
