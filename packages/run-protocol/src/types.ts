// Shared contracts between the Converlt IDE and the remote agent.
// The agent (Python) writes these events as JSON lines; see docs/run-protocol.md.

export const PROTOCOL_VERSION = 1;

export const RUN_STATUSES = [
  "created",
  "preparing",
  "running",
  "cancelling",
  "completed",
  "failed",
  "cancelled",
  "unknown",
] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];

export interface MachineRef {
  id: string;
  name: string;
  host: string;
  port?: number;
  identityFile?: string;
  python: string;
  /** User-entered estimate, USD per hour. Never a provider-billed amount. */
  hourlyRate?: number;
  /** Set when the machine is an on-demand Converlt Cloud pod; the gateway bills it. */
  cloudPodId?: string;
  /** Cloud pods: minutes without GPU work before the pod stops itself (0 = never). */
  idleStopMinutes?: number;
}

export interface Machine extends MachineRef {
  createdAt: number;
  remoteRoot?: string;
}

export interface GitFingerprint {
  commit: string | null;
  branch: string | null;
  dirty: boolean;
  diffStat: string;
  untracked: string[];
  /** Local file (relative to the run dir) holding the uncommitted diff, if any. */
  patchFile?: string;
}

export interface RunOptions {
  stopOnNan: boolean;
  telemetryIntervalSec: number;
  stallMinutes: number;
  cancelGraceSec: number;
}

/** Immutable record written once when a run is created. */
export interface RunManifest {
  schemaVersion: number;
  runId: string;
  number: number;
  name: string;
  project: string;
  createdAt: number;
  command: string;
  hyperparameters: Record<string, string | number | boolean>;
  framework: "pytorch";
  machine: MachineRef;
  workdir: string;
  git: GitFingerprint | null;
  sync: { files: number; bytes: number; skipped: number };
  options: RunOptions;
  reproducedFrom?: string;
}

/** Subset of the manifest sent to the agent's `start` command. */
export interface AgentStartRequest {
  runId: string;
  project: string;
  command: string;
  workdir: string;
  python: string;
  env: Record<string, string>;
  options: RunOptions;
}

export interface GpuInfo {
  index: number;
  name: string;
  memTotalMiB: number;
  driver?: string | null;
}

export interface GpuSample {
  index: number;
  name: string;
  memUsedMiB: number;
  memTotalMiB: number;
  utilPct: number | null;
  tempC: number | null;
  powerW: number | null;
}

export interface HostSample {
  load1: number | null;
  cpuCount: number | null;
  memUsedMiB: number | null;
  memTotalMiB: number | null;
  diskFreeGiB: number | null;
}

export type DiagnosticKind = "nan" | "oom" | "exit" | "stall" | "perf" | "exception" | "launch";
export type Severity = "error" | "warning" | "info";

interface BaseEvent {
  seq: number;
  ts: number;
}

export interface StatusEvent extends BaseEvent {
  type: "status";
  status: RunStatus;
  exitCode?: number | null;
  reason?: string | null;
  pid?: number;
}

export interface LogEvent extends BaseEvent {
  type: "log";
  stream: "stdout" | "stderr";
  line: string;
}

/** Non-finite values are encoded as the strings "NaN", "Infinity", "-Infinity". */
export interface MetricEvent extends BaseEvent {
  type: "metric";
  step: number | null;
  values: Record<string, number | string>;
}

export interface ConfigEvent extends BaseEvent {
  type: "config";
  values: Record<string, unknown>;
}

export interface EnvEvent extends BaseEvent {
  type: "env";
  hostname?: string;
  python?: string | null;
  pythonPath?: string | null;
  torch?: string | null;
  torchCuda?: string | null;
  cudaAvailable?: boolean | null;
  driver?: string | null;
  cudaVersion?: string | null;
  gpus?: GpuInfo[];
  packages?: string[];
}

export interface TelemetryEvent extends BaseEvent {
  type: "telemetry";
  gpus: GpuSample[];
  host: HostSample;
}

export interface DiagnosticEvent extends BaseEvent {
  type: "diagnostic";
  kind: DiagnosticKind;
  severity: Severity;
  message: string;
  step?: number | null;
  data?: Record<string, unknown>;
}

export interface ArtifactEvent extends BaseEvent {
  type: "artifact";
  path: string;
  sizeBytes?: number | null;
  sha256?: string | null;
  step?: number | null;
}

export type RunEvent =
  | StatusEvent
  | LogEvent
  | MetricEvent
  | ConfigEvent
  | EnvEvent
  | TelemetryEvent
  | DiagnosticEvent
  | ArtifactEvent;

/** Lines emitted by `agent tail` that are not persisted run events. */
export type TailControlLine =
  | { type: "heartbeat"; ts: number; status: RunStatus; supervisorAlive: boolean; lastSeq: number }
  | { type: "end"; status: RunStatus }
  | { type: "error"; error: string; message?: string };

/** Experiment intent, edited by the user. */
export interface RunNotes {
  group: string;
  hypothesis: string;
  expected: string;
  changes: string;
  observed: string;
  conclusion: string;
}

export const EMPTY_NOTES: RunNotes = {
  group: "",
  hypothesis: "",
  expected: "",
  changes: "",
  observed: "",
  conclusion: "",
};

/** Client-side launch bookkeeping, before the agent owns the run. */
export interface LocalRunState {
  phase: "preparing" | "launched" | "launch_failed";
  error?: string;
  updatedAt: number;
}

export type ConnectionState = "idle" | "live" | "reconnecting" | "lost";
