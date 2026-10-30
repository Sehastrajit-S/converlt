import type {
  ArtifactEvent,
  DiagnosticEvent,
  EnvEvent,
  GpuSample,
  RunEvent,
  RunStatus,
  TelemetryEvent,
} from "./types.ts";

export interface MetricPoint {
  step: number;
  /** null for non-finite values (NaN/Inf), so series stay JSON-safe. */
  value: number | null;
  ts: number;
}

export interface TelemetryPoint {
  ts: number;
  memUsedMiB: number;
  memTotalMiB: number;
  utilPct: number | null;
}

export interface LogLine {
  seq: number;
  ts: number;
  stream: "stdout" | "stderr";
  line: string;
}

export interface RunSummary {
  status: RunStatus | null;
  exitCode: number | null;
  reason: string | null;
  startedAt: number | null;
  endedAt: number | null;
  lastSeq: number;
  lastEventAt: number | null;
  metrics: Record<string, MetricPoint[]>;
  latestStep: number | null;
  config: Record<string, unknown>;
  env: Omit<EnvEvent, "seq" | "ts" | "type"> | null;
  latestTelemetry: { gpus: GpuSample[]; host: TelemetryEvent["host"]; ts: number } | null;
  telemetry: TelemetryPoint[];
  peakGpuMemMiB: number | null;
  diagnostics: DiagnosticEvent[];
  artifacts: ArtifactEvent[];
  logs: LogLine[];
  logCount: number;
}

export const MAX_LOG_LINES = 5000;
const MAX_TELEMETRY_POINTS = 4000;

export function createSummary(): RunSummary {
  return {
    status: null,
    exitCode: null,
    reason: null,
    startedAt: null,
    endedAt: null,
    lastSeq: 0,
    lastEventAt: null,
    metrics: {},
    latestStep: null,
    config: {},
    env: null,
    latestTelemetry: null,
    telemetry: [],
    peakGpuMemMiB: null,
    diagnostics: [],
    artifacts: [],
    logs: [],
    logCount: 0,
  };
}

export function parseMetricValue(raw: unknown): number | null {
  if (typeof raw === "number") return Number.isFinite(raw) ? raw : null;
  if (typeof raw === "string") {
    const n = Number(raw);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

export function isNonFinite(raw: unknown): boolean {
  if (typeof raw === "number") return !Number.isFinite(raw);
  return raw === "NaN" || raw === "Infinity" || raw === "-Infinity";
}

/** Applies one event in place. Events at or below lastSeq are ignored (replay dedupe). */
export function applyEvent(s: RunSummary, ev: RunEvent): RunSummary {
  if (typeof ev.seq !== "number" || ev.seq <= s.lastSeq) return s;
  s.lastSeq = ev.seq;
  s.lastEventAt = ev.ts;

  switch (ev.type) {
    case "status":
      s.status = ev.status;
      if (ev.status === "running" && s.startedAt === null) s.startedAt = ev.ts;
      if (ev.status === "completed" || ev.status === "failed" || ev.status === "cancelled") {
        s.endedAt = ev.ts;
        if (s.startedAt === null) s.startedAt = ev.ts;
      }
      if (ev.exitCode !== undefined) s.exitCode = ev.exitCode;
      if (ev.reason) s.reason = ev.reason;
      break;
    case "log":
      s.logs.push({ seq: ev.seq, ts: ev.ts, stream: ev.stream, line: ev.line });
      s.logCount++;
      if (s.logs.length > MAX_LOG_LINES) s.logs.splice(0, s.logs.length - MAX_LOG_LINES);
      break;
    case "metric": {
      for (const [key, raw] of Object.entries(ev.values)) {
        const series = (s.metrics[key] ??= []);
        const step = ev.step ?? (series.length ? series[series.length - 1]!.step + 1 : 0);
        series.push({ step, value: parseMetricValue(raw), ts: ev.ts });
      }
      if (ev.step !== null && (s.latestStep === null || ev.step > s.latestStep)) s.latestStep = ev.step;
      break;
    }
    case "config":
      s.config = { ...s.config, ...ev.values };
      break;
    case "env": {
      const { seq: _seq, ts: _ts, type: _type, ...rest } = ev;
      s.env = { ...(s.env ?? {}), ...rest };
      break;
    }
    case "telemetry": {
      s.latestTelemetry = { gpus: ev.gpus, host: ev.host, ts: ev.ts };
      if (ev.gpus.length) {
        const used = ev.gpus.reduce((a, g) => a + g.memUsedMiB, 0);
        const total = ev.gpus.reduce((a, g) => a + g.memTotalMiB, 0);
        const utils = ev.gpus.map((g) => g.utilPct).filter((u): u is number => u !== null);
        const util = utils.length ? utils.reduce((a, b) => a + b, 0) / utils.length : null;
        s.telemetry.push({ ts: ev.ts, memUsedMiB: used, memTotalMiB: total, utilPct: util });
        if (s.telemetry.length > MAX_TELEMETRY_POINTS) s.telemetry.splice(0, s.telemetry.length - MAX_TELEMETRY_POINTS);
        if (s.peakGpuMemMiB === null || used > s.peakGpuMemMiB) s.peakGpuMemMiB = used;
      }
      break;
    }
    case "diagnostic": {
      // One card per kind: later evidence (e.g. SDK memory stats after a log-detected OOM) is merged in.
      const existing = s.diagnostics.find((d) => d.kind === ev.kind);
      if (existing) {
        existing.data = { ...(existing.data ?? {}), ...(ev.data ?? {}) };
        if (severityRank(ev.severity) > severityRank(existing.severity)) existing.severity = ev.severity;
        if (existing.step == null && ev.step != null) existing.step = ev.step;
      } else {
        s.diagnostics.push({ ...ev, data: { ...(ev.data ?? {}) } });
      }
      break;
    }
    case "artifact":
      s.artifacts.push(ev);
      break;
  }
  return s;
}

function severityRank(sev: DiagnosticEvent["severity"]): number {
  return sev === "error" ? 2 : sev === "warning" ? 1 : 0;
}

export function summarize(events: Iterable<RunEvent>): RunSummary {
  const s = createSummary();
  for (const ev of events) applyEvent(s, ev);
  return s;
}

/** Parses a JSONL chunk, skipping blank or corrupt lines (e.g. a torn final write). */
export function parseEventLines(text: string): RunEvent[] {
  const out: RunEvent[] = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const ev = JSON.parse(trimmed);
      if (ev && typeof ev.seq === "number" && typeof ev.type === "string") out.push(ev as RunEvent);
    } catch {
      // ignore
    }
  }
  return out;
}

/** Keeps at most `max` points, always retaining the first and last. */
export function downsample<T>(points: T[], max: number): T[] {
  if (points.length <= max || max < 3) return points;
  const stride = (points.length - 1) / (max - 1);
  const out: T[] = [];
  for (let i = 0; i < max; i++) out.push(points[Math.round(i * stride)]!);
  return out;
}

export interface SeriesStats {
  last: number | null;
  min: number | null;
  max: number | null;
  count: number;
  lastStep: number | null;
}

export function seriesStats(series: MetricPoint[] | undefined): SeriesStats {
  if (!series?.length) return { last: null, min: null, max: null, count: 0, lastStep: null };
  let min: number | null = null;
  let max: number | null = null;
  for (const p of series) {
    if (p.value === null) continue;
    if (min === null || p.value < min) min = p.value;
    if (max === null || p.value > max) max = p.value;
  }
  const lastPoint = series[series.length - 1]!;
  return { last: lastPoint.value, min, max, count: series.length, lastStep: lastPoint.step };
}

/** Picks the metric most likely to be the training loss, for list views and the status bar. */
export function primaryMetricKey(keys: string[]): string | null {
  if (!keys.length) return null;
  const prefs = [/^train[/_.]?loss$/i, /^loss$/i, /loss/i, /^val[/_.]?loss$/i];
  for (const re of prefs) {
    const hit = keys.find((k) => re.test(k));
    if (hit) return hit;
  }
  return keys[0]!;
}
