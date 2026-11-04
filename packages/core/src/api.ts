// IPC contract between the Electron main process and the renderer.
import type {
  ConnectionState,
  GpuSample,
  HostSample,
  LocalRunState,
  Machine,
  RunManifest,
  RunNotes,
  RunOptions,
  RunStatus,
  RunExplanation,
  RunSummary,
} from "@converge/run-protocol";
import type { CloudPod, CloudStatus, GpuOffer, LaunchPodRequest, LedgerEntry, ModelInfo, SpendLimits, WalletSummary } from "./cloudApi.ts";

export interface ProbeCheck {
  name: string;
  ok: boolean;
  detail: string;
}

export interface ProbeResult {
  ok: boolean;
  at: number;
  error?: string;
  hostname?: string;
  os?: string;
  gpus?: GpuSample[];
  driver?: string | null;
  cudaVersion?: string | null;
  python?: {
    python?: string | null;
    pythonPath?: string | null;
    torch?: string | null;
    torchCuda?: string | null;
    cudaAvailable?: boolean;
    torchArchList?: string[];
    gpuCapability?: string;
    /** Installed packages built against torch, e.g. ["torchvision"]. */
    companions?: string[];
  };
  /** Compute capability of GPU 0, e.g. "8.9". */
  gpuCapability?: string | null;
  host?: HostSample;
  workdir?: string;
  checks?: ProbeCheck[];
  ready?: boolean;
  latencyMs?: number;
}

export interface TelemetryResult {
  ok: boolean;
  at: number;
  error?: string;
  gpus?: GpuSample[];
  host?: HostSample;
}

export interface MachineInput {
  name: string;
  host: string;
  port?: number;
  identityFile?: string;
  python: string;
  hourlyRate?: number;
}

export interface ProjectInfo {
  path: string;
  name: string;
  isGitRepo: boolean;
  branch: string | null;
}

export type ThemePref = "system" | "dark" | "light";

export interface Settings {
  sshPath: string;
  remoteRoot: string;
  defaultCommand: string;
  syncExclude: string[];
  maxFileSizeMB: number;
  defaultOptions: RunOptions;
  theme: ThemePref;
  notifications: boolean;
}

export interface AppState {
  version: string;
  platform: string;
  project: ProjectInfo | null;
  recentProjects: string[];
  machines: Machine[];
  probes: Record<string, ProbeResult>;
  settings: Settings;
}

export interface RunListItem {
  runId: string;
  number: number;
  name: string;
  command: string;
  machineName: string;
  gpuName: string | null;
  status: RunStatus;
  connection: ConnectionState;
  createdAt: number;
  startedAt: number | null;
  endedAt: number | null;
  durationSec: number | null;
  costUsd: number | null;
  primaryMetric: { key: string; last: number | null; spark: (number | null)[] } | null;
  diagnosticKinds: string[];
  group: string;
  gitCommit: string | null;
  dirty: boolean;
  reproducedFrom?: string;
}

export interface RunView {
  manifest: RunManifest;
  notes: RunNotes;
  local: LocalRunState | null;
  status: RunStatus;
  connection: ConnectionState;
  connectionDetail: string | null;
  summary: RunSummary;
  durationSec: number | null;
  costUsd: number | null;
  effectiveConfig: Record<string, unknown>;
  hasPatch: boolean;
}

export interface SyncPlanView {
  root: string;
  files: number;
  bytes: number;
  skipped: { path: string; reason: string }[];
  skippedCount: number;
  usedGit: boolean;
}

export interface LaunchRequest {
  machineId: string;
  command: string;
  options: RunOptions;
  reproducedFrom?: string;
}

export interface ReproducePlan {
  command: string;
  machineId: string | null;
  options: RunOptions;
  warnings: string[];
}

// ------------------------------------------------------------ environments

export interface EnvInfo {
  kind: "system" | "venv" | "conda";
  name: string;
  /** Interpreter path on the machine; this is what a run uses as its Python. */
  python: string;
  prefix: string;
  /** Lives in ~/.converge/envs, so Converlt may delete it. */
  managed: boolean;
  version: string | null;
  torch: string | null;
  cuda: string | null;
  cudaAvailable: boolean;
  packages: number | null;
  error: string | null;
}

export interface EnvList {
  envs: EnvInfo[];
  conda: string | null;
  root: string;
}

export interface EnvCreateSpec {
  name: string;
  kind: "venv" | "conda";
  /** conda only, e.g. "3.11". */
  pythonVersion?: string;
  /** venv only: see the machine's packages (e.g. the image's PyTorch) without reinstalling them. */
  systemSitePackages?: boolean;
  packages?: string[];
  /** Contents of a requirements.txt. */
  requirements?: string;
}

export interface EnvInstallSpec {
  packages?: string[];
  requirements?: string;
}

export interface EnvOpResult {
  ok: boolean;
  /** Tail of the command output. */
  log: string;
}

export interface EnvPackage {
  name: string;
  version: string;
}

// ------------------------------------------------------------ datasets & models hub

export type HubSource = "huggingface" | "kaggle";
export type HubKind = "model" | "dataset";

export interface HubItem {
  source: HubSource;
  kind: HubKind;
  /** "org/name" on Hugging Face, "owner/slug" on Kaggle. */
  id: string;
  title: string;
  subtitle: string;
  downloads: number | null;
  likes: number | null;
  updated: string | null;
  sizeBytes: number | null;
  license: string | null;
  tags: string[];
  /** Needs an accepted license / token to download. */
  gated: boolean;
  url: string;
}

export interface HubDetails extends HubItem {
  files: { path: string; size: number | null }[];
  fileCount: number;
  description: string;
  /** Kaggle models: downloadable variants ("owner/model/framework/variation"). */
  variants: { handle: string; label: string; sizeBytes: number | null }[];
}

export interface HubJob {
  jobId: string;
  source: HubSource;
  kind: HubKind;
  id: string;
  /** Where it lives on the machine. */
  path: string;
  status: "downloading" | "completed" | "failed";
  startedAt: number;
  endedAt: number | null;
  /** Bytes on disk so far. */
  bytes: number;
  error: string | null;
  log: string;
}

export interface HubAccounts {
  huggingface: boolean;
  kaggle: boolean;
}

// ------------------------------------------------------------ cloud

/** Whether the coding agents in the editor can use Converlt's tools (through its MCP server). */
export interface AgentsStatus {
  claudeCode: boolean;
  codex: boolean;
}

/** "Use my own keys": the gateway running on this computer. */
export interface LocalGatewayStatus {
  enabled: boolean;
  runpodKey: boolean;
  openrouterKey: boolean;
  /** Set while it runs. */
  url: string | null;
  error: string | null;
  /** Result of checking each key against its provider, after the last start: "ok: …" or the problem. */
  checks: { runpod?: string; openrouter?: string };
}

/** A cloud pod plus the Converlt machine that points at it, once it has SSH. */
export interface CloudPodView extends CloudPod {
  machineId: string | null;
}

export interface ModelReply {
  text: string;
  credits: number | null;
  tokens: { input: number; output: number };
}

export interface ConvergeApi {
  getState(): Promise<AppState>;
  openProjectDialog(): Promise<ProjectInfo | null>;
  openProject(path: string): Promise<ProjectInfo>;
  closeProject(): Promise<void>;
  openInEditor(path?: string): Promise<void>;
  revealPath(path: string): Promise<void>;

  addMachine(input: MachineInput): Promise<Machine>;
  updateMachine(id: string, input: MachineInput): Promise<Machine>;
  removeMachine(id: string): Promise<void>;
  probeMachine(id: string): Promise<ProbeResult>;
  machineTelemetry(id: string): Promise<TelemetryResult>;

  listRuns(): Promise<RunListItem[]>;
  getRun(runId: string): Promise<RunView | null>;
  planSync(): Promise<SyncPlanView>;
  launchRun(req: LaunchRequest): Promise<{ runId: string }>;
  cancelRun(runId: string): Promise<void>;
  reconnectRun(runId: string): Promise<void>;
  saveNotes(runId: string, notes: RunNotes): Promise<void>;
  planReproduce(runId: string): Promise<ReproducePlan>;
  openPatch(runId: string): Promise<void>;
  gitDiff(fromCommit: string, toCommit: string): Promise<string>;
  /** Why `otherRunId` turned out differently from `baseRunId`: the gap, where they split, and ranked causes. */
  explainRuns(baseRunId: string, otherRunId: string): Promise<RunExplanation>;
  /** The same, worded by an AI model through Converlt Cloud (costs credits). */
  explainRunsWithAi(baseRunId: string, otherRunId: string): Promise<ModelReply & { model: string }>;

  updateSettings(patch: Partial<Settings>): Promise<Settings>;
  /** Sends a test message to an ntfy topic URL, from this computer. */
  testPhoneAlert(url: string): Promise<void>;

  // Environments on a machine.
  listEnvs(machineId: string): Promise<EnvList>;
  createEnv(machineId: string, spec: EnvCreateSpec): Promise<EnvOpResult>;
  installPackages(machineId: string, python: string, spec: EnvInstallSpec): Promise<EnvOpResult>;
  envPackages(machineId: string, python: string): Promise<EnvPackage[]>;
  removeEnv(machineId: string, name: string): Promise<void>;
  /** Makes runs on this machine use the given interpreter. */
  useEnv(machineId: string, python: string): Promise<Machine>;
  /** The open project's requirements.txt, if it has one. */
  projectRequirements(): Promise<string | null>;

  // Datasets and models from Hugging Face and Kaggle, downloaded onto machines.
  hubSearch(source: HubSource, kind: HubKind, query: string): Promise<HubItem[]>;
  hubDetails(source: HubSource, kind: HubKind, id: string): Promise<HubDetails>;
  hubAccounts(): Promise<HubAccounts>;
  /** Hugging Face: an access token. Kaggle: an API token, or "username:key". null removes it. */
  hubSetAccount(source: HubSource, secret: string | null): Promise<HubAccounts>;
  hubDownload(machineId: string, source: HubSource, kind: HubKind, id: string): Promise<{ jobId: string }>;
  hubJobs(machineId: string): Promise<HubJob[]>;
  hubRemove(machineId: string, jobId: string): Promise<void>;

  // Converlt Cloud: one credit wallet for on-demand GPUs and models.
  cloudStatus(): Promise<CloudStatus>;
  cloudConnect(url: string, token: string): Promise<CloudStatus>;
  /** Sign in with a Converlt account in the browser. Opens the login page; returns the code it shows. */
  cloudSignInStart(url?: string): Promise<{ code: string; url: string; loginUrl: string }>;
  /** Resolves once the browser approves the sign-in (or rejects on cancel, timeout or error). */
  cloudSignInWait(): Promise<CloudStatus>;
  cloudSignInCancel(): Promise<void>;
  cloudDisconnect(): Promise<void>;
  cloudWallet(): Promise<WalletSummary>;
  cloudLedger(limit?: number): Promise<LedgerEntry[]>;
  cloudSetLimits(limits: SpendLimits): Promise<WalletSummary>;
  gpuOffers(): Promise<GpuOffer[]>;
  /** Also keeps a Converlt machine in sync with each pod's SSH endpoint. */
  gpuPods(): Promise<CloudPodView[]>;
  /** `idleStopMinutes`: the pod stops itself after that long without GPU work (default 30, 0 = never). */
  gpuLaunch(req: Omit<LaunchPodRequest, "publicKey"> & { idleStopMinutes?: number; thenRun?: { command: string; options: RunOptions; reproducedFrom?: string } }): Promise<CloudPodView>;
  gpuStop(podId: string): Promise<void>;
  gpuStart(podId: string): Promise<void>;
  gpuTerminate(podId: string): Promise<void>;
  cloudModels(): Promise<ModelInfo[]>;
  /** Bring-your-own-keys mode: run the gateway on this computer. */
  localGateway(): Promise<LocalGatewayStatus>;
  localGatewaySetKeys(keys: { runpod?: string | null; openrouter?: string | null }): Promise<LocalGatewayStatus>;
  /** Starts it (or restarts it to pick up new keys) and signs in to it. */
  localGatewayStart(initialCredits?: number): Promise<CloudStatus>;
  localGatewayStop(): Promise<void>;
  localGatewayAddCredits(credits: number): Promise<WalletSummary>;

  /** Claude Code / Codex: register Converlt's MCP server so their agents get Converlt's tools. */
  agentsStatus(): Promise<AgentsStatus>;
  agentsConnect(which: { claudeCode: boolean; codex: boolean }): Promise<AgentsStatus>;
  modelComplete(model: string, prompt: string): Promise<ModelReply>;

  onRunsChanged(cb: (runIds: string[]) => void): () => void;
  onStateChanged(cb: () => void): () => void;
  onLaunchProgress(cb: (p: { runId: string; stage: string; detail?: string }) => void): () => void;
}

export const IPC = {
  invoke: "converge:invoke",
  runsChanged: "converge:runs-changed",
  stateChanged: "converge:state-changed",
  launchProgress: "converge:launch-progress",
} as const;

/** Methods callable over the single invoke channel. */
export type InvokeMethod = Exclude<keyof ConvergeApi, "onRunsChanged" | "onStateChanged" | "onLaunchProgress">;
