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
  /** Cloud pods: credits per hour while running, as billed when the run launched. */
  cloudPricePerHour?: number;
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
  /**
   * ntfy topic URL (e.g. https://ntfy.sh/converlt-x7…). The agent on the machine posts there when
   * the run finishes, fails or needs attention, so alerts reach a phone with the IDE closed.
   */
  notifyUrl?: string;
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
  /** Set on a run opened from a shared run file: whose it is and where it came from. */
  shared?: SharedFrom;
}

/** Where a shared run came from. */
export interface SharedFrom {
  /** The person who shared it (their git user name). */
  by: string;
  /** When they exported it (Unix ms). */
  at: number;
  /** Their project folder's name. */
  project: string;
  /** Their git remote, where the run's commit can be fetched from. */
  remote: string | null;
  /** The run's name in their project, e.g. "run-007". */
  originalName: string;
}

/** Subset of the manifest sent to the agent's `start` command. */
export interface AgentStartRequest {
  runId: string;
  /** Display name, e.g. "run-012", used in phone alerts. */
  name?: string;
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

export type DiagnosticKind = "nan" | "oom" | "exit" | "stall" | "perf" | "dataloader" | "exception" | "launch";
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
  /** GPU architectures this PyTorch build has kernels for, e.g. ["sm_80", "sm_90"]. */
  torchArchList?: string[] | null;
  /** Compute capability of GPU 0, e.g. "8.9". */
  gpuCapability?: string | null;
  gpus?: GpuInfo[];
  packages?: string[];
}

/** A dataset or pretrained weights the run read, with a fingerprint to tell versions apart. */
export interface InputEvent extends BaseEvent {
  type: "input";
  kind: "dataset" | "weights";
  /** e.g. "imdb", "meta-llama/Llama-3.1-8B" or a local path. */
  name: string;
  path?: string | null;
  /** Hub revision (commit hash) when known. */
  revision?: string | null;
  /** Content fingerprint; equal fingerprints mean the same data. */
  fingerprint?: string | null;
  /** How the fingerprint was computed, e.g. "hf-datasets", "files: names, sizes, sampled contents". */
  method?: string | null;
  files?: number | null;
  bytes?: number | null;
  /** "sdk": the script called run.log_dataset; "auto": recorded from load_dataset / from_pretrained. */
  source?: "sdk" | "auto";
}

/** One parameter tensor at one point in training (from run.watch(model)). */
export interface WeightTensor {
  /** Parameter name, e.g. "conv1.weight"; the part before the first dot is the module. */
  name: string;
  shape: number[];
  numel: number;
  mean: number;
  std: number;
  absMax: number;
  /** NaN/Inf entries; the statistics cover the finite ones. */
  nonFinite?: number;
  gradNorm?: number | null;
  /** Value distribution over [min, max]. */
  hist: { min: number; max: number; counts: number[] };
  /** The weight matrix (rows = output units) averaged down to at most 12×24 cells. */
  grid?: number[][];
}

export interface WeightsEvent extends BaseEvent {
  type: "weights";
  step: number | null;
  tensors: WeightTensor[];
  /** The model's outputs for the recorded examples at this step, in the same order. */
  predictions?: ExamplePrediction[];
}

/** One example drawn for the UI (no batch dimension). */
export type ExampleVisual =
  | { kind: "image" | "recon:image"; w: number; h: number; c: number; data: string; frames?: number }
  | { kind: "tokens" | "recon:tokens"; ids: number[]; length: number }
  | { kind: "wave" | "recon:wave"; min: number[]; max: number[] }
  | { kind: "heatmap" | "recon:heatmap"; rows: number; cols: number; values: number[][]; shape: number[] }
  | { kind: "vector" | "recon:vector"; values: number[]; length: number };

export type ExampleLabel = { class: number; name: string | null } | { value: number } | { values: number[] };

export type ExamplePrediction = ExampleVisual | { class: number; p: number } | { value: number; p: number } | { tokens: number[] } | { values: number[] };

/** A few training inputs recorded once, shown above the weights. */
export interface ExamplesEvent extends BaseEvent {
  type: "examples";
  inputs: ExampleVisual[];
  labels: ExampleLabel[];
  shape: number[] | null;
  classNames: string[];
}

/** After training: the held-out split's examples the model gets most wrong (or, without labels to
 *  get wrong, the ones with the highest loss), with what it predicted. */
export interface FailuresEvent extends BaseEvent {
  type: "failures";
  /** "test", or "val" when there is no test split. */
  split: string;
  inputs: ExampleVisual[];
  labels: ExampleLabel[];
  predictions: ExamplePrediction[];
  /** Each example's loss, in the same order (highest first). */
  losses: number[];
  shape: number[] | null;
  classNames: string[];
  /** Examples evaluated, and how many were wrong (null when "wrong" doesn't apply, e.g. regression). */
  total: number;
  wrong: number | null;
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
  | ArtifactEvent
  | InputEvent
  | WeightsEvent
  | ExamplesEvent
  | FailuresEvent;

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
