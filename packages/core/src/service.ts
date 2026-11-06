import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  analyzeGraph,
  dataStem,
  datasetSpec,
  explainRuns,
  generateLoaderCode,
  generatePreprocessCode,
  fileStem,
  generateModelCode,
  generateTrainCode,
  importedToGraph,
  multiGpuCommand,
  patchByFile,
  type CodeChanges,
  type DataProfile,
  type DatasetRef,
  type Machine,
  type ModelGraph,
  type RunExplanation,
  type RunNotes,
  type RunOptions,
  type RunStatus,
} from "@converge/run-protocol";
import { EXPLAIN_MODEL, explainPrompt } from "./explainPrompt.ts";
import type {
  CloudPodView,
  EnvCreateSpec,
  EnvInstallSpec,
  EnvList,
  EnvOpResult,
  EnvPackage,
  HubAccounts,
  HubDetails,
  HubItem,
  HubJob,
  HubKind,
  HubSource,
  LaunchRequest,
  LocalGatewayStatus,
  AgentsStatus,
  MachineInput,
  ModelReply,
  ProbeResult,
  ProjectInfo,
  RunView,
  Settings,
  TelemetryResult,
  BrowseResult,
  BuilderDesign,
  DataCodePaths,
  PreprocessPreview,
  DatasetView,
  BuilderImportResult,
  BuilderSaveResult,
} from "./api.ts";
import { AgentClient } from "./agentClient.ts";
import type { CloudPod, CloudStatus, GpuOffer, LaunchPodRequest, LedgerEntry, ModelInfo, SpendLimits, WalletSummary } from "./cloudApi.ts";
import { CloudClient, DEFAULT_CLOUD_URL, ensureCloudKey, startBrowserSignIn, type BrowserSignIn } from "./cloudClient.ts";
import type { LocalGateway } from "./localGateway.ts";
import { agentsStatus, connectAgents, type McpLaunch } from "./agents.ts";
import { checkPython, CLOUD_ENV_ROOT, ENV_ROOT, EnvManager } from "./envs.ts";
import { installWatchdog } from "./watchdog.ts";
import { publishNtfy } from "./phoneAlerts.ts";
import { DataTools } from "./dataTools.ts";
import { importModel, modelFiles, projectPythonFiles, type ImportRequest } from "./codeImport.ts";
import { detectLocalGpus, detectThisComputer } from "./localGpus.ts";

export const DEFAULT_IDLE_STOP_MINUTES = 30;
import { CLOUD_HUB_ROOT, HUB_ROOT, HubManager, hubDetails, hubSearch, type HubSecrets } from "./hub.ts";
import { changedFiles, currentBranch, diffCommits, diffFiles, isGitRepo } from "./git.ts";
import { RunManager, type TransportFactory } from "./runManager.ts";
import { explainSshError, isLocalHost, LOCAL_HOST, parseWslHost, transportFor } from "./transport.ts";

/** A run to start on a pod once it's up. */
export interface PendingRun {
  command: string;
  options: RunOptions;
  reproducedFrom?: string;
}

/** Persistence for registered machines; each shell supplies its own (JSON file, VS Code globalState, ...). */
export interface MachineStore {
  load(): { machines: Machine[]; probes: Record<string, ProbeResult> };
  save(machines: Machine[], probes: Record<string, ProbeResult>): Promise<void>;
  /** Hosts of local GPUs the user removed, so discovery doesn't add them back. */
  dismissedLocal?(): string[];
  dismissLocal?(host: string): Promise<void>;
}

export interface ServiceHooks {
  runsChanged(runIds: string[]): void;
  stateChanged(): void;
  launchProgress(p: { runId: string; stage: string; detail?: string }): void;
  runFinished(name: string, status: RunStatus, message: string, runId?: string): void;
}

/** Where a shell keeps the Converlt Cloud gateway URL and token (secret storage, keychain...). */
export interface CloudCredentials {
  get(): Promise<{ url: string; token: string } | null>;
  set(creds: { url: string; token: string } | null): Promise<void>;
}

/** Small named secrets (third-party tokens), kept in the shell's secret storage. */
export interface SecretStore {
  get(key: string): Promise<string | undefined>;
  set(key: string, value: string | null): Promise<void>;
}

export interface ServiceOptions {
  store: MachineStore;
  settings: () => Settings;
  resourcesDir: string;
  hooks: ServiceHooks;
  transportFactory?: TransportFactory;
  cloud?: CloudCredentials;
  secrets?: SecretStore;
  localGateway?: LocalGateway;
  /** How to start the Converlt MCP server, for registering it with coding agents. */
  mcp?: McpLaunch;
  /** Opens a URL in the system browser (for signing in). */
  openExternal?: (url: string) => Promise<boolean>;
}

export function validateMachine(input: MachineInput): MachineInput {
  const host = input.host.trim();
  if (!host || /\s/.test(host) || host.startsWith("-")) throw new Error("Enter an SSH host like user@gpu-box, an ~/.ssh/config alias, or wsl:<distro>.");
  if (input.port !== undefined && (!Number.isInteger(input.port) || input.port < 1 || input.port > 65535)) throw new Error("Invalid port");
  if (input.hourlyRate !== undefined && (!(input.hourlyRate >= 0) || input.hourlyRate > 1000)) throw new Error("Invalid hourly rate");
  return {
    name: input.name.trim() || (isLocalHost(host) ? "This computer" : parseWslHost(host) ? `Local GPU (${parseWslHost(host)})` : host),
    host,
    port: input.port,
    identityFile: input.identityFile?.trim() || undefined,
    python: input.python.trim() || "python3",
    hourlyRate: input.hourlyRate,
  };
}

/** A gateway URL, normalised; https is required except for this computer. */
function gatewayUrl(url: string): string {
  const clean = url.trim().replace(/\/+$/, "");
  if (!/^https?:\/\/[^\s/]+/.test(clean)) throw new Error("Enter the gateway URL, e.g. https://cloud.converlt.dev");
  if (/^http:\/\//.test(clean) && !/^http:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(clean)) throw new Error("Use https:// for a remote gateway; plain http is only allowed for localhost.");
  return clean;
}

/** Everything Converlt does, independent of the editor UI that hosts it. */
export class ConvergeService {
  private readonly opts: ServiceOptions;
  private machines: Machine[];
  /** The browser sign-in waiting for approval, if any. */
  private signIn: { flow: BrowserSignIn; url: string; abort: AbortController } | null = null;
  private probes: Record<string, ProbeResult>;
  project: ProjectInfo | null = null;
  manager: RunManager | null = null;
  /** Idle-stop choice for pods launched in this session, until their machine exists. */
  private readonly pendingIdle = new Map<string, number>();
  /** Runs to start on a pod as soon as it's reachable ("rent this GPU and run there"), by pod id. */
  private readonly pendingRuns = new Map<string, PendingRun & { tries: number }>();

  constructor(opts: ServiceOptions) {
    this.opts = opts;
    const loaded = opts.store.load();
    this.machines = loaded.machines;
    this.probes = loaded.probes;
  }

  // ------------------------------------------------------------ project

  async openProject(p: string): Promise<ProjectInfo> {
    const st = await fs.stat(p);
    if (!st.isDirectory()) throw new Error("Not a folder");
    this.manager?.dispose();
    const git = await isGitRepo(p);
    this.project = { path: p, name: path.basename(p), isGitRepo: git, branch: git ? await currentBranch(p) : null };
    const { hooks } = this.opts;
    this.manager = new RunManager(
      p,
      this.opts.settings,
      {
        onRunsChanged: (ids) => hooks.runsChanged(ids),
        onLaunchProgress: (prog) => hooks.launchProgress(prog),
        onRunFinished: (name, status, message, runId) => hooks.runFinished(name, status, message, runId),
      },
      this.opts.resourcesDir,
      this.opts.transportFactory ?? ((m) => transportFor(m, this.opts.settings().sshPath)),
    );
    await this.manager.init();
    hooks.stateChanged();
    return this.project;
  }

  closeProject(): void {
    this.manager?.dispose();
    this.manager = null;
    this.project = null;
    this.opts.hooks.stateChanged();
  }

  dispose(): void {
    this.manager?.dispose();
  }

  /** The run options new runs get unless they say otherwise. */
  defaultRunOptions() {
    return this.opts.settings().defaultOptions;
  }

  requireManager(): RunManager {
    if (!this.manager) throw new Error("Open a project first.");
    return this.manager;
  }

  // ------------------------------------------------------------ machines

  listMachines(): Machine[] {
    return this.machines;
  }

  listProbes(): Record<string, ProbeResult> {
    return this.probes;
  }

  findMachine(id: string): Machine {
    const m = this.machines.find((x) => x.id === id);
    if (!m) throw new Error("Machine not found");
    return m;
  }

  private async persist(): Promise<void> {
    await this.opts.store.save(this.machines, this.probes);
    this.opts.hooks.stateChanged();
  }

  async addMachine(input: MachineInput): Promise<Machine> {
    const m: Machine = { id: randomUUID(), createdAt: Date.now(), ...validateMachine(input) };
    this.machines = [...this.machines, m];
    await this.persist();
    return m;
  }

  async updateMachine(id: string, input: MachineInput): Promise<Machine> {
    const m = { ...this.findMachine(id), ...validateMachine(input) };
    this.machines = this.machines.map((x) => (x.id === id ? m : x));
    delete this.probes[id];
    await this.persist();
    return m;
  }

  async removeMachine(id: string): Promise<void> {
    const removed = this.machines.find((m) => m.id === id);
    if (removed && (parseWslHost(removed.host) || isLocalHost(removed.host))) await this.opts.store.dismissLocal?.(removed.host);
    this.machines = this.machines.filter((m) => m.id !== id);
    delete this.probes[id];
    await this.persist();
  }

  /**
   * Adds this computer's GPUs (WSL distributions that see one) as machines, unless they're
   * registered already or the user removed them. Returns the machines it added.
   */
  async discoverLocalMachines(): Promise<Machine[]> {
    const dismissed = new Set(this.opts.store.dismissedLocal?.() ?? []);
    const added: Machine[] = [];
    for (const g of await detectLocalGpus()) {
      const host = `wsl:${g.distro}`;
      if (dismissed.has(host) || this.machines.some((m) => m.host.toLowerCase() === host.toLowerCase())) continue;
      const gpu = g.gpus[0]!.replace(/^NVIDIA (GeForce )?/, "");
      const m: Machine = { id: randomUUID(), createdAt: Date.now(), name: `This PC · ${g.gpus.length > 1 ? `${g.gpus.length}× ` : ""}${gpu}`, host, python: g.python };
      this.machines = [...this.machines, m];
      added.push(m);
    }
    // macOS and Linux: this computer itself, with its NVIDIA or Apple GPU, or its CPU.
    if (process.platform !== "win32" && !dismissed.has(LOCAL_HOST) && !this.machines.some((m) => isLocalHost(m.host))) {
      const me = await detectThisComputer().catch(() => null);
      if (me && me.accelerator !== "none") {
        const what = me.gpus.length ? `${me.gpus.length > 1 ? `${me.gpus.length}× ` : ""}${me.gpus[0]!.replace(/^NVIDIA (GeForce )?/, "")}` : "CPU";
        const m: Machine = { id: randomUUID(), createdAt: Date.now(), name: `This computer · ${what}`, host: LOCAL_HOST, python: me.python };
        this.machines = [...this.machines, m];
        added.push(m);
      }
    }
    if (added.length) {
      await this.persist();
      this.opts.hooks.stateChanged();
      for (const m of added) void this.probeMachine(m.id).then(() => this.opts.hooks.stateChanged(), () => {});
    }
    return added;
  }

  detectLocalGpus() {
    return detectLocalGpus();
  }

  /** macOS / Linux: this computer's GPU and best Python (null on Windows, which uses WSL). */
  detectThisComputer() {
    return detectThisComputer();
  }

  private agentFor(m: Machine): AgentClient {
    const factory = this.opts.transportFactory ?? ((x) => transportFor(x, this.opts.settings().sshPath));
    return new AgentClient(factory(m), m.python, (s) => explainSshError(s, m.host));
  }

  private workdir(): string {
    return this.manager?.workdir() ?? this.opts.settings().remoteRoot;
  }

  async probeMachine(id: string): Promise<ProbeResult> {
    const m = this.findMachine(id);
    const client = this.agentFor(m);
    let result: ProbeResult;
    try {
      await client.install(this.opts.resourcesDir);
      result = { ...(await client.probe(this.workdir(), isLocalHost(m.host))), ok: true, at: Date.now() };
      if (m.cloudPodId) {
        const minutes = m.idleStopMinutes ?? DEFAULT_IDLE_STOP_MINUTES;
        const factory = this.opts.transportFactory ?? ((x) => transportFor(x, this.opts.settings().sshPath));
        let check: { name: string; ok: boolean; detail: string };
        try {
          await installWatchdog(factory(m), m.python, minutes);
          check = { name: "Idle auto-stop", ok: true, detail: minutes > 0 ? `stops itself after ${minutes} min without GPU work` : "off" };
        } catch (e) {
          check = { name: "Idle auto-stop", ok: false, detail: e instanceof Error ? e.message : String(e) };
        }
        result = { ...result, checks: [...(result.checks ?? []), check] };
      }
    } catch (e) {
      result = { ok: false, at: Date.now(), error: e instanceof Error ? e.message : String(e) };
    }
    this.probes = { ...this.probes, [id]: result };
    await this.persist();
    return result;
  }

  async machineTelemetry(id: string): Promise<TelemetryResult> {
    try {
      return { ...(await this.agentFor(this.findMachine(id)).telemetry(this.workdir())), ok: true, at: Date.now() };
    } catch (e) {
      return { ok: false, at: Date.now(), error: e instanceof Error ? e.message : String(e) };
    }
  }

  // ------------------------------------------------------------ runs

  listRuns() {
    return this.manager?.listRuns() ?? [];
  }

  getRun(runId: string) {
    return this.manager?.getRun(runId) ?? null;
  }

  planSync() {
    return this.requireManager().planSync();
  }

  launchRun(req: LaunchRequest) {
    return this.requireManager().launch(req, this.findMachine(req.machineId));
  }

  cancelRun(runId: string) {
    return this.requireManager().cancel(runId);
  }

  reconnectRun(runId: string) {
    this.requireManager().reconnect(runId);
  }

  saveNotes(runId: string, notes: RunNotes) {
    return this.requireManager().saveNotes(runId, notes);
  }

  planReproduce(runId: string) {
    return this.requireManager().planReproduce(runId, this.machines);
  }

  gitDiff(from: string, to: string) {
    return diffCommits(this.requireManager().projectPath, from, to);
  }

  /** The code that differs between two runs: files changed between their commits, and in their uncommitted patches. */
  private async codeChanges(a: RunView, b: RunView): Promise<{ changes: CodeChanges; patches: [Map<string, string>, Map<string, string>] }> {
    const mgr = this.requireManager();
    const readPatch = async (v: RunView) => (v.hasPatch ? patchByFile(await fs.readFile(mgr.store.patchPath(v.manifest.runId), "utf8").catch(() => "")) : new Map<string, string>());
    const patches: [Map<string, string>, Map<string, string>] = [await readPatch(a), await readPatch(b)];
    const ca = a.manifest.git?.commit;
    const cb = b.manifest.git?.commit;
    let committedFiles: string[] = [];
    let unknown = !ca || !cb;
    if (ca && cb && ca !== cb) {
      const files = await changedFiles(mgr.projectPath, ca, cb);
      if (files === null) unknown = true;
      else committedFiles = files;
    }
    const uncommittedFiles = [...new Set([...patches[0].keys(), ...patches[1].keys()])].filter((f) => patches[0].get(f) !== patches[1].get(f));
    return { changes: { committedFiles, uncommittedFiles, unknown }, patches };
  }

  private runPair(baseRunId: string, otherRunId: string): [RunView, RunView] {
    const a = this.getRun(baseRunId);
    const b = this.getRun(otherRunId);
    if (!a || !b) throw new Error("Run not found");
    return [a, b];
  }

  async explainRuns(baseRunId: string, otherRunId: string): Promise<RunExplanation> {
    const [a, b] = this.runPair(baseRunId, otherRunId);
    return explainRuns(a, b, (await this.codeChanges(a, b)).changes);
  }

  testPhoneAlert(url: string): Promise<void> {
    return publishNtfy(url, "Converlt phone alerts work", "You'll get a message here when a run finishes, fails, hits a NaN loss or stalls, even with the editor closed.", ["white_check_mark"]);
  }

  async explainRunsWithAi(baseRunId: string, otherRunId: string, model = EXPLAIN_MODEL): Promise<ModelReply & { model: string }> {
    const [a, b] = this.runPair(baseRunId, otherRunId);
    const { changes, patches } = await this.codeChanges(a, b);
    const x = explainRuns(a, b, changes);
    // The code behind the likeliest code causes, so the model can point at actual lines.
    const hot = x.causes.filter((c) => c.category === "code" && c.score >= 0.45).slice(0, 5).map((c) => c.subject);
    let code = "";
    const ca = a.manifest.git?.commit;
    const cb = b.manifest.git?.commit;
    if (ca && cb && ca !== cb) code += await diffFiles(this.requireManager().projectPath, ca, cb, hot.filter((f) => changes.committedFiles.includes(f)));
    for (const f of hot) {
      if (!changes.uncommittedFiles.includes(f)) continue;
      code += `\n# Uncommitted change in ${a.manifest.name}:\n${patches[0].get(f) ?? "(none)"}\n# Uncommitted change in ${b.manifest.name}:\n${patches[1].get(f) ?? "(none)"}`;
    }
    const reply = await this.modelComplete(model, explainPrompt(a, b, x, code.slice(0, 16_000)));
    return { ...reply, model };
  }

  patchPath(runId: string): string {
    return this.requireManager().store.patchPath(runId);
  }

  // ------------------------------------------------------------ environments

  private envsFor(id: string): EnvManager {
    const m = this.findMachine(id);
    const factory = this.opts.transportFactory ?? ((x) => transportFor(x, this.opts.settings().sshPath));
    return new EnvManager(factory(m), m.python, (s) => explainSshError(s, m.host), m.cloudPodId ? CLOUD_ENV_ROOT : ENV_ROOT);
  }

  listEnvs(machineId: string): Promise<EnvList> {
    return this.envsFor(machineId).list();
  }

  createEnv(machineId: string, spec: EnvCreateSpec): Promise<EnvOpResult> {
    return this.envsFor(machineId).create(spec);
  }

  installPackages(machineId: string, python: string, spec: EnvInstallSpec): Promise<EnvOpResult> {
    return this.envsFor(machineId).install(python, spec);
  }

  envPackages(machineId: string, python: string): Promise<EnvPackage[]> {
    return this.envsFor(machineId).packages(python);
  }

  removeEnv(machineId: string, name: string): Promise<void> {
    return this.envsFor(machineId).remove(name);
  }

  async useEnv(machineId: string, python: string): Promise<Machine> {
    checkPython(python);
    const m = { ...this.findMachine(machineId), python: python.trim() };
    this.machines = this.machines.map((x) => (x.id === machineId ? m : x));
    delete this.probes[machineId]; // readiness depends on the interpreter
    await this.persist();
    return m;
  }

  async projectRequirements(): Promise<string | null> {
    if (!this.project) return null;
    try {
      return await fs.readFile(path.join(this.project.path, "requirements.txt"), "utf8");
    } catch {
      return null;
    }
  }

  // ------------------------------------------------------------ data

  private readonly dataInstalled = new Set<string>();

  private datasetsFile(): string {
    if (!this.project) throw new Error("Open a project folder first: its datasets are kept with it.");
    return path.join(this.project.path, ".converge", "datasets.json");
  }

  private async readDatasets(): Promise<DatasetDb> {
    try {
      const raw = JSON.parse(await fs.readFile(this.datasetsFile(), "utf8"));
      return { datasets: raw.datasets ?? [], profiles: raw.profiles ?? {}, dismissedHub: raw.dismissedHub ?? [] };
    } catch {
      return { datasets: [], profiles: {}, dismissedHub: [] };
    }
  }

  private async writeDatasets(db: DatasetDb): Promise<void> {
    await fs.mkdir(path.dirname(this.datasetsFile()), { recursive: true });
    await fs.writeFile(this.datasetsFile(), JSON.stringify(db));
  }

  private datasetView(d: DatasetRef, db: DatasetDb): DatasetView {
    const p = db.profiles[d.id];
    return { dataset: d, profile: p?.profile ?? null, profiledAt: p?.at ?? null, machineName: this.machines.find((m) => m.id === d.machineId)?.name ?? null };
  }

  private async dataTools(machineId: string): Promise<DataTools> {
    const m = this.findMachine(machineId);
    const factory = this.opts.transportFactory ?? ((x) => transportFor(x, this.opts.settings().sshPath));
    if (!this.dataInstalled.has(m.id)) {
      await this.agentFor(m).install(this.opts.resourcesDir);
      this.dataInstalled.add(m.id);
    }
    return new DataTools(factory(m), m.python, (s) => explainSshError(s, m.host));
  }

  private async findDataset(id: string): Promise<{ db: DatasetDb; d: DatasetRef }> {
    const db = await this.readDatasets();
    const d = db.datasets.find((x) => x.id === id);
    if (!d) throw new Error("That dataset isn't registered in this project anymore.");
    return { db, d };
  }

  async dataList(): Promise<DatasetView[]> {
    if (!this.project) return [];
    const db = await this.readDatasets();
    return db.datasets.map((d) => this.datasetView(d, db)).sort((a, b) => b.dataset.addedAt - a.dataset.addedAt);
  }

  /**
   * Adds datasets downloaded with Datasets & models (completed Hugging Face / Kaggle dataset jobs
   * on machines that are reachable) to the project's Data list, unless they're registered
   * already or the user removed them. Returns the ones it added.
   */
  async dataSyncHub(): Promise<DatasetView[]> {
    if (!this.project) return [];
    const machines = this.machines.filter((m) => this.probes[m.id]?.ok);
    const found = await Promise.all(machines.map(async (m) => ({ m, jobs: await this.hubJobs(m.id).catch(() => [] as HubJob[]) })));
    const db = await this.readDatasets();
    const dismissed = new Set(db.dismissedHub ?? []);
    const added: DatasetRef[] = [];
    for (const { m, jobs } of found)
      for (const j of jobs) {
        if (j.kind !== "dataset" || j.status !== "completed") continue;
        if (dismissed.has(`${m.id}:${j.path}`) || db.datasets.some((d) => d.machineId === m.id && d.path === j.path)) continue;
        const d: DatasetRef = { id: randomUUID(), name: j.id, machineId: m.id, path: j.path, format: "unknown", steps: [], addedAt: j.endedAt ?? Date.now(), source: { hub: j.source, id: j.id } };
        db.datasets.push(d);
        added.push(d);
      }
    if (added.length) await this.writeDatasets(db);
    return added.map((d) => this.datasetView(d, db));
  }

  async dataSave(input: Omit<DatasetRef, "id" | "addedAt"> & { id?: string }): Promise<DatasetView> {
    if (!input.name.trim()) throw new Error("Give the dataset a name.");
    const db = await this.readDatasets();
    const existing = input.id ? db.datasets.find((d) => d.id === input.id) : undefined;
    const d: DatasetRef = { ...input, id: existing?.id ?? randomUUID(), addedAt: existing?.addedAt ?? Date.now() };
    // A different path, target or machine makes the old profile wrong.
    if (existing && (existing.path !== d.path || existing.target !== d.target || existing.machineId !== d.machineId)) delete db.profiles[d.id];
    db.datasets = [...db.datasets.filter((x) => x.id !== d.id), d];
    await this.writeDatasets(db);
    return this.datasetView(d, db);
  }

  async dataRemove(id: string): Promise<void> {
    const db = await this.readDatasets();
    // A removed download isn't added back by the next sync.
    const gone = db.datasets.find((d) => d.id === id);
    if (gone?.source) db.dismissedHub = [...new Set([...(db.dismissedHub ?? []), `${gone.machineId}:${gone.path}`])];
    db.datasets = db.datasets.filter((d) => d.id !== id);
    delete db.profiles[id];
    await this.writeDatasets(db);
  }

  async dataBrowse(machineId: string, dir: string | null): Promise<BrowseResult> {
    return (await this.dataTools(machineId)).browse(dir);
  }

  async dataProfile(id: string): Promise<DatasetView> {
    const { db, d } = await this.findDataset(id);
    const profile = await (await this.dataTools(d.machineId)).profile(d.path, d.target);
    const updated: DatasetRef = { ...d, format: profile.format };
    db.datasets = db.datasets.map((x) => (x.id === id ? updated : x));
    db.profiles[id] = { profile, at: Date.now() };
    await this.writeDatasets(db);
    return this.datasetView(updated, db);
  }

  async dataPreview(id: string): Promise<PreprocessPreview> {
    const { d } = await this.findDataset(id);
    if (d.format === "images") throw new Error("Image transforms run in the loader while training; there's nothing to preview on files.");
    if (d.format === "tensors") throw new Error("Array files are used as saved: there's no preprocessing to preview.");
    return (await this.dataTools(d.machineId)).preview(generatePreprocessCode(d), 200);
  }

  async dataWriteCode(id: string): Promise<DataCodePaths> {
    if (!this.project) throw new Error("Open a project folder first.");
    const { db, d } = await this.findDataset(id);
    const dir = path.join(this.project.path, "data");
    await fs.mkdir(dir, { recursive: true });
    const stem = dataStem(d.name);
    let preprocessPath: string | null = null;
    if (d.format !== "images" && d.format !== "tensors") {
      preprocessPath = path.join(dir, `preprocess_${stem}.py`);
      await fs.writeFile(preprocessPath, generatePreprocessCode(d));
    }
    const loaderPath = path.join(dir, `${stem}_loader.py`);
    await fs.writeFile(loaderPath, generateLoaderCode(d, db.profiles[id]?.profile ?? null));
    return { preprocessPath, loaderPath };
  }

  async dataRunPreprocess(id: string): Promise<{ runId: string }> {
    const { d } = await this.findDataset(id);
    if (d.format === "images") throw new Error("Image folders don't need a preprocessing run: the loader applies the transforms.");
    if (d.format === "tensors") throw new Error("Array files are used as saved: there's nothing to preprocess.");
    await this.dataWriteCode(id);
    const m = this.findMachine(d.machineId);
    return this.launchRun({ machineId: m.id, command: `${m.python} data/preprocess_${dataStem(d.name)}.py`, options: this.opts.settings().defaultOptions });
  }

  // ------------------------------------------------------------ model builder

  /** Designs saved in the project's models/ folder, newest first. */
  async builderList(): Promise<BuilderDesign[]> {
    if (!this.project) return [];
    const dir = path.join(this.project.path, "models");
    const files = await fs.readdir(dir).catch(() => [] as string[]);
    const out: BuilderDesign[] = [];
    for (const f of files.filter((f) => f.endsWith(".converlt.json"))) {
      const full = path.join(dir, f);
      try {
        const graph = JSON.parse(await fs.readFile(full, "utf8")) as ModelGraph;
        out.push({ name: graph.name, file: full, updatedAt: (await fs.stat(full)).mtimeMs, graph });
      } catch {
        // not a design we can read; skip it
      }
    }
    return out.sort((a, b) => b.updatedAt - a.updatedAt);
  }

  /**
   * Writes models/<name>.py (the module) and models/<name>.converlt.json (the design, to reopen
   * it). With `train`, the design must name a dataset from Data: this writes the dataset's loader
   * and train_<name>.py, which trains on it, and returns the command plus the dataset's machine.
   * A training script the user edited since Converlt wrote it is kept as train_<name>.py.bak.
   */
  async builderSave(graph: ModelGraph, train: boolean): Promise<BuilderSaveResult> {
    if (!this.project) throw new Error("Open a project folder first: the model is saved into it.");
    const analysis = analyzeGraph(graph);
    const code = generateModelCode(graph, analysis);
    const stem = fileStem(graph.name);
    // Everything that can fail is checked before anything is written.
    let trainCode: string | null = null;
    let dataset: DatasetRef | null = null;
    if (train) {
      if (!graph.dataset) throw new Error("Choose the dataset to train on (Dataset, in the builder's top bar). Add one in Data first if the list is empty.");
      const { db, d } = await this.findDataset(graph.dataset).catch(() => {
        throw new Error("The dataset this design trains on was removed from Data. Choose another.");
      });
      dataset = d;
      trainCode = generateTrainCode(graph, { name: d.name, loaderStem: dataStem(d.name), spec: datasetSpec(d, db.profiles[d.id]?.profile ?? null) }, analysis);
    }
    const dir = path.join(this.project.path, "models");
    await fs.mkdir(dir, { recursive: true });
    const modelPath = path.join(dir, `${stem}.py`);
    await fs.writeFile(modelPath, code);
    await fs.writeFile(path.join(dir, `${stem}.converlt.json`), JSON.stringify(graph, null, 1) + "\n");
    if (!trainCode || !dataset) return { modelPath, trainPath: null, command: null, trainCreated: false, backupPath: null, machineId: null, datasetName: null };
    await this.dataWriteCode(dataset.id);
    const trainPath = path.join(this.project.path, `train_${stem}.py`);
    const backupPath = await this.writeGenerated(trainPath, trainCode);
    // Builder scripts are DDP-ready, so on a machine with several GPUs they train on all of them.
    const gpus = this.probes[dataset.machineId]?.gpus?.length ?? 0;
    const single = `python train_${stem}.py`;
    return { modelPath, trainPath, command: multiGpuCommand(single, gpus) ?? single, trainCreated: true, backupPath, machineId: dataset.machineId, datasetName: dataset.name };
  }

  /**
   * Writes a generated file, remembering its hash in .converge/generated.json. If the file on disk
   * was changed since Converlt last wrote it, that version is kept as <file>.bak (returned).
   * Old synthetic-data training scripts are replaced without a backup.
   */
  private async writeGenerated(file: string, content: string): Promise<string | null> {
    const sha = (s: string) => createHash("sha256").update(s).digest("hex");
    const ledgerPath = path.join(this.project!.path, ".converge", "generated.json");
    const ledger: Record<string, string> = JSON.parse(await fs.readFile(ledgerPath, "utf8").catch(() => "{}"));
    const key = path.relative(this.project!.path, file).replace(/\\/g, "/");
    const current = await fs.readFile(file, "utf8").catch(() => null);
    let backup: string | null = null;
    if (current !== null && current !== content && ledger[key] !== sha(current) && !/on synthetic data/.test(current)) {
      backup = `${file}.bak`;
      await fs.writeFile(backup, current);
    }
    await fs.writeFile(file, content);
    ledger[key] = sha(content);
    await fs.mkdir(path.dirname(ledgerPath), { recursive: true });
    await fs.writeFile(ledgerPath, JSON.stringify(ledger, null, 1) + "\n");
    return backup;
  }

  // ------------------------------------------------------------ code → graph

  /** Project Python files that define a PyTorch nn.Module. */
  async builderCodeFiles(): Promise<string[]> {
    if (!this.project) return [];
    return modelFiles(this.project.path);
  }

  /**
   * Traces a model class from the project's code on a machine (torch.fx + one forward pass) and
   * returns it as a builder graph. Without a class or input shape, returns what's needed.
   */
  async builderImport(req: ImportRequest & { machineId: string }): Promise<BuilderImportResult> {
    if (!this.project) throw new Error("Open a project folder first.");
    const m = this.findMachine(req.machineId);
    if (!this.dataInstalled.has(m.id)) {
      await this.agentFor(m).install(this.opts.resourcesDir);
      this.dataInstalled.add(m.id);
    }
    const factory = this.opts.transportFactory ?? ((x) => transportFor(x, this.opts.settings().sshPath));
    const files = await projectPythonFiles(this.project.path);
    const r = await importModel(factory(m), m.python, files, req, (s) => explainSshError(s, m.host));
    const base = { classes: r.classes ?? [], inputShape: r.inputShape ?? null, inputDtype: r.inputDtype ?? null, notes: r.notes ?? [] };
    if (!r.ok) return { ...base, error: r.error ?? "The import failed.", need: null, summary: null };
    if (!r.graph) return { ...base, error: null, need: r.need ?? "class", summary: null };
    return { ...base, error: null, need: null, summary: importedToGraph(r.graph, r.torchParams ?? null, r.custom ?? []) };
  }

  // ------------------------------------------------------------ datasets & models hub

  private async hubSecrets(): Promise<HubSecrets> {
    const hf = await this.opts.secrets?.get("hub.huggingface");
    const kaggle = await this.opts.secrets?.get("hub.kaggle");
    const out: HubSecrets = { hfToken: hf };
    if (kaggle?.includes(":")) {
      const [user, ...key] = kaggle.split(":");
      out.kaggleUser = user;
      out.kaggleKey = key.join(":");
    } else if (kaggle) out.kaggleToken = kaggle;
    return out;
  }

  private hubFor(id: string): HubManager {
    const m = this.findMachine(id);
    const factory = this.opts.transportFactory ?? ((x) => transportFor(x, this.opts.settings().sshPath));
    return new HubManager(factory(m), m.python, m.cloudPodId ? CLOUD_HUB_ROOT : HUB_ROOT, (s) => explainSshError(s, m.host));
  }

  async hubSearch(source: HubSource, kind: HubKind, query: string): Promise<HubItem[]> {
    return hubSearch(source, kind, query, (await this.hubSecrets()).hfToken);
  }

  async hubDetails(source: HubSource, kind: HubKind, id: string): Promise<HubDetails> {
    return hubDetails(source, kind, id, (await this.hubSecrets()).hfToken);
  }

  async hubAccounts(): Promise<HubAccounts> {
    return { huggingface: !!(await this.opts.secrets?.get("hub.huggingface")), kaggle: !!(await this.opts.secrets?.get("hub.kaggle")) };
  }

  async hubSetAccount(source: HubSource, secret: string | null): Promise<HubAccounts> {
    if (!this.opts.secrets) throw new Error("This shell can't store tokens");
    const v = secret?.trim() || null;
    if (v && !/^[\w.:-]{8,512}$/.test(v)) throw new Error("That doesn't look like a token");
    await this.opts.secrets.set(`hub.${source}`, v);
    return this.hubAccounts();
  }

  async hubDownload(machineId: string, source: HubSource, kind: HubKind, id: string): Promise<{ jobId: string }> {
    return { jobId: await this.hubFor(machineId).start(source, kind, id, await this.hubSecrets()) };
  }

  hubJobs(machineId: string): Promise<HubJob[]> {
    return this.hubFor(machineId).jobs();
  }

  hubRemove(machineId: string, jobId: string): Promise<void> {
    return this.hubFor(machineId).remove(jobId);
  }

  // ------------------------------------------------------------ cloud

  private async cloudClient(): Promise<CloudClient> {
    const creds = await this.opts.cloud?.get();
    if (!creds) throw new Error("Sign in to Converlt Cloud first.");
    return new CloudClient(creds.url, creds.token);
  }

  async cloudStatus(): Promise<CloudStatus> {
    let creds = await this.opts.cloud?.get();
    if (!creds) return { connected: false, url: null, user: null, error: null };
    const local = /^http:\/\/127\.0\.0\.1:\d+$/.test(creds.url) && (await this.opts.localGateway?.status())?.enabled === true;
    // The local gateway gets a new port each time it starts: follow it, starting it if needed.
    if (local && this.opts.localGateway && !(await this.opts.localGateway.runningUrl())) {
      try {
        creds = await this.opts.localGateway.start(0);
        await this.opts.cloud!.set(creds);
      } catch (e) {
        return { connected: false, local, url: creds.url, user: null, error: e instanceof Error ? e.message : String(e) };
      }
    }
    try {
      const me = await new CloudClient(creds.url, creds.token).me();
      return { connected: true, local, url: creds.url, user: me.user, error: null };
    } catch (e) {
      return { connected: false, url: creds.url, user: null, error: e instanceof Error ? e.message : String(e) };
    }
  }

  async cloudConnect(url: string, token: string): Promise<CloudStatus> {
    if (!this.opts.cloud) throw new Error("This shell can't store Converlt Cloud credentials");
    const clean = gatewayUrl(url);
    const me = await new CloudClient(clean, token.trim()).me(); // throws if the token is wrong
    await this.opts.cloud.set({ url: clean, token: token.trim() });
    this.opts.hooks.stateChanged();
    return { connected: true, url: clean, user: me.user, error: null };
  }

  /** Gateway URL and token for in-process callers (the editor's model provider). Never sent to webviews. */
  async cloudEndpoint(): Promise<{ url: string; token: string } | null> {
    return (await this.opts.cloud?.get()) ?? null;
  }

  /**
   * Starts signing in with a Converlt account: opens the gateway's login page in the browser.
   * Returns the code the page will show; then call cloudSignInWait.
   */
  async cloudSignInStart(url?: string | null): Promise<{ code: string; url: string; loginUrl: string }> {
    if (!this.opts.cloud) throw new Error("This shell can't store Converlt Cloud credentials");
    // Webview RPC turns a missing argument into null, so treat null and "" as "the hosted gateway".
    const clean = gatewayUrl(url || DEFAULT_CLOUD_URL);
    this.signIn?.abort.abort();
    const s = { flow: startBrowserSignIn(clean), url: clean, abort: new AbortController() };
    this.signIn = s;
    if (!(await this.opts.openExternal?.(s.flow.loginUrl))) throw new Error(`Couldn't open the browser. Open ${s.flow.loginUrl} yourself.`);
    return { code: s.flow.code, url: clean, loginUrl: s.flow.loginUrl };
  }

  /** Waits for the browser to approve the sign-in started by cloudSignInStart, then connects. */
  async cloudSignInWait(): Promise<CloudStatus> {
    const s = this.signIn;
    if (!s) throw new Error("No sign-in in progress");
    try {
      const { token } = await s.flow.wait(`Converlt IDE on ${os.hostname()}`, s.abort.signal);
      return await this.cloudConnect(s.url, token);
    } finally {
      if (this.signIn === s) this.signIn = null;
    }
  }

  async cloudSignInCancel(): Promise<void> {
    this.signIn?.abort.abort();
    this.signIn = null;
  }

  async cloudDisconnect(): Promise<void> {
    // Revoke this device's token on the gateway too (best effort: signing out works offline).
    const creds = await this.opts.cloud?.get();
    if (creds) await new CloudClient(creds.url, creds.token).signOut().catch(() => {});
    await this.opts.cloud?.set(null);
    this.opts.hooks.stateChanged();
  }

  async cloudWallet(): Promise<WalletSummary> {
    return (await this.cloudClient()).me();
  }

  async cloudLedger(limit = 100): Promise<LedgerEntry[]> {
    return (await this.cloudClient()).ledger(limit);
  }

  async cloudSetLimits(limits: SpendLimits): Promise<WalletSummary> {
    return (await this.cloudClient()).setLimits(limits);
  }

  async gpuOffers(): Promise<GpuOffer[]> {
    return (await this.cloudClient()).offers();
  }

  async gpuPods(): Promise<CloudPodView[]> {
    const pods = await (await this.cloudClient()).pods();
    return this.syncPodMachines(pods);
  }

  async gpuLaunch(req: Omit<LaunchPodRequest, "publicKey"> & { idleStopMinutes?: number; thenRun?: PendingRun }): Promise<CloudPodView> {
    const key = await ensureCloudKey();
    const { idleStopMinutes, thenRun, ...launch } = req;
    if (thenRun && !this.manager) throw new Error("Open the project folder first, so the run has code to sync.");
    const pod = await (await this.cloudClient()).launch({ ...launch, publicKey: key.publicKey });
    this.pendingIdle.set(pod.id, idleStopMinutes ?? DEFAULT_IDLE_STOP_MINUTES);
    if (thenRun) this.pendingRuns.set(pod.id, { ...thenRun, tries: 0 });
    const [view] = await this.syncPodMachines([pod], false);
    return view!;
  }

  /**
   * Starts the run waiting for this machine's pod once the readiness probe reaches it. A new pod's
   * sshd can take a minute, so failed probes are retried for a few minutes before giving up.
   */
  private async startPendingRun(machineId: string, probe: ProbeResult): Promise<void> {
    const m = this.machines.find((x) => x.id === machineId);
    const pending = m?.cloudPodId ? this.pendingRuns.get(m.cloudPodId) : undefined;
    if (!m?.cloudPodId || !pending) return;
    if (!probe.ok) {
      if (++pending.tries > 12) {
        this.pendingRuns.delete(m.cloudPodId);
        this.opts.hooks.runFinished(m.name, "failed", `Couldn't reach ${m.name} to start the run: ${probe.error ?? "no connection"}. Start it from the GPUs page.`);
        return;
      }
      setTimeout(() => void this.probeMachine(machineId).then((r) => this.startPendingRun(machineId, r)).catch(() => {}), 20_000);
      return;
    }
    this.pendingRuns.delete(m.cloudPodId);
    if (!this.manager) return;
    try {
      await this.launchRun({ machineId, command: pending.command, options: pending.options, reproducedFrom: pending.reproducedFrom });
    } catch (e) {
      this.opts.hooks.runFinished(m.name, "failed", `Couldn't start the run on ${m.name}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  async gpuStop(podId: string): Promise<void> {
    await (await this.cloudClient()).stop(podId);
  }

  async gpuStart(podId: string): Promise<void> {
    await (await this.cloudClient()).start(podId);
  }

  async gpuTerminate(podId: string): Promise<void> {
    await (await this.cloudClient()).terminate(podId);
    const m = this.machines.find((x) => x.cloudPodId === podId);
    if (m) await this.removeMachine(m.id);
  }

  private requireLocal(): LocalGateway {
    if (!this.opts.localGateway) throw new Error("This shell can't run a local gateway");
    return this.opts.localGateway;
  }

  localGateway(): Promise<LocalGatewayStatus> {
    return this.requireLocal().status();
  }

  async localGatewaySetKeys(keys: { runpod?: string | null; openrouter?: string | null }): Promise<LocalGatewayStatus> {
    const g = this.requireLocal();
    await g.setKeys(keys);
    // A running gateway reads keys at start: restart it so they take effect.
    if (await g.runningUrl()) await this.localGatewayStart(0, true);
    return g.status();
  }

  async localGatewayStart(initialCredits = 2000, restart = false): Promise<CloudStatus> {
    const g = this.requireLocal();
    const creds = await g.start(initialCredits, restart);
    await this.opts.cloud?.set(creds);
    await g.verify(creds.url, creds.token);
    this.opts.hooks.stateChanged();
    return this.cloudStatus();
  }

  /** Stops running pods first: with the gateway off, nothing would meter or stop them. */
  async localGatewayStop(): Promise<void> {
    const g = this.requireLocal();
    if (await g.runningUrl()) {
      const client = await this.cloudClient().catch(() => null);
      const pods = client ? await client.pods().catch(() => []) : [];
      const failures: string[] = [];
      for (const p of pods.filter((x) => x.status === "running" || x.status === "starting")) {
        await client!.stop(p.id).catch((e) => failures.push(`${p.name}: ${e instanceof Error ? e.message : e}`));
      }
      if (failures.length) throw new Error(`Couldn't stop every pod, so the gateway keeps running:\n${failures.join("\n")}`);
    }
    await g.disable();
    await this.opts.cloud?.set(null);
    this.opts.hooks.stateChanged();
  }

  async localGatewayAddCredits(credits: number): Promise<WalletSummary> {
    await this.requireLocal().addCredits(credits);
    return this.cloudWallet();
  }

  agentsStatus(): Promise<AgentsStatus> {
    if (!this.opts.mcp) return Promise.resolve({ claudeCode: false, codex: false });
    return agentsStatus(this.opts.mcp);
  }

  agentsConnect(which: { claudeCode: boolean; codex: boolean }): Promise<AgentsStatus> {
    if (!this.opts.mcp) throw new Error("This shell can't run the Converlt MCP server");
    return connectAgents(this.opts.mcp, which);
  }

  async cloudModels(): Promise<ModelInfo[]> {
    return (await this.cloudClient()).models();
  }

  async modelComplete(model: string, prompt: string): Promise<ModelReply> {
    return (await this.cloudClient()).complete(model, prompt);
  }

  /**
   * Each pod with an SSH endpoint gets a Converlt machine (root@ip:port, Converlt's key), so runs
   * launch on it like on any other machine. Endpoints change when a pod restarts; machines follow.
   * With `complete`, machines whose pod is gone are removed too.
   */
  private async syncPodMachines(pods: CloudPod[], complete = true): Promise<CloudPodView[]> {
    let changed = false;
    const fresh: string[] = [];
    const key = pods.some((p) => p.ssh) ? await ensureCloudKey() : null;
    const views: CloudPodView[] = [];
    for (const pod of pods) {
      let m = this.machines.find((x) => x.cloudPodId === pod.id);
      if (pod.ssh && key) {
        const host = `root@${pod.ssh.host}`;
        if (!m) {
          m = {
            id: randomUUID(),
            createdAt: Date.now(),
            name: `${pod.name} · ${pod.gpuCount > 1 ? `${pod.gpuCount}× ` : ""}${pod.gpuName}`,
            host,
            port: pod.ssh.port,
            identityFile: key.privateKey,
            python: "python3",
            cloudPodId: pod.id,
            cloudPricePerHour: pod.pricePerHour,
            idleStopMinutes: this.pendingIdle.get(pod.id) ?? DEFAULT_IDLE_STOP_MINUTES,
          };
          this.machines = [...this.machines, m];
          fresh.push(m.id);
          changed = true;
        } else if (m.cloudPricePerHour !== pod.pricePerHour && pod.status === "running") {
          const priced: Machine = { ...m, cloudPricePerHour: pod.pricePerHour };
          this.machines = this.machines.map((x) => (x.id === priced.id ? priced : x));
          m = priced;
          changed = true;
        }
        if (m.host !== host || m.port !== pod.ssh.port) {
          const moved: Machine = { ...m, host, port: pod.ssh.port, identityFile: key.privateKey };
          this.machines = this.machines.map((x) => (x.id === moved.id ? moved : x));
          delete this.probes[moved.id];
          m = moved;
          fresh.push(m.id);
          changed = true;
        }
      }
      views.push({ ...pod, machineId: m?.id ?? null });
    }
    if (complete) {
      const live = new Set(pods.map((p) => p.id));
      const gone = this.machines.filter((x) => x.cloudPodId && !live.has(x.cloudPodId));
      if (gone.length) {
        this.machines = this.machines.filter((x) => !gone.includes(x));
        for (const g of gone) delete this.probes[g.id];
        changed = true;
      }
    }
    if (changed) await this.persist();
    // Install the agent and check readiness in the background as soon as a pod is reachable.
    for (const id of fresh) void this.probeMachine(id).then((r) => this.startPendingRun(id, r)).catch(() => {});
    return views;
  }
}

interface DatasetDb {
  datasets: DatasetRef[];
  profiles: Record<string, { profile: DataProfile; at: number }>;
  /** "machineId:path" of downloads the user removed from Data, so syncing doesn't add them back. */
  dismissedHub?: string[];
}
