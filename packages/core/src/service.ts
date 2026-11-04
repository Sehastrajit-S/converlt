import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { explainRuns, patchByFile, type CodeChanges, type Machine, type RunExplanation, type RunNotes, type RunStatus } from "@converge/run-protocol";
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
} from "./api.ts";
import { AgentClient } from "./agentClient.ts";
import type { CloudPod, CloudStatus, GpuOffer, LaunchPodRequest, LedgerEntry, ModelInfo, SpendLimits, WalletSummary } from "./cloudApi.ts";
import { CloudClient, DEFAULT_CLOUD_URL, ensureCloudKey, startBrowserSignIn, type BrowserSignIn } from "./cloudClient.ts";
import type { LocalGateway } from "./localGateway.ts";
import { agentsStatus, connectAgents, type McpLaunch } from "./agents.ts";
import { checkPython, CLOUD_ENV_ROOT, ENV_ROOT, EnvManager } from "./envs.ts";
import { installWatchdog } from "./watchdog.ts";

export const DEFAULT_IDLE_STOP_MINUTES = 30;
import { CLOUD_HUB_ROOT, HUB_ROOT, HubManager, hubDetails, hubSearch, type HubSecrets } from "./hub.ts";
import { changedFiles, currentBranch, diffCommits, diffFiles, isGitRepo } from "./git.ts";
import { RunManager, type TransportFactory } from "./runManager.ts";
import { explainSshError, parseWslHost, transportFor } from "./transport.ts";

/** Persistence for registered machines; each shell supplies its own (JSON file, VS Code globalState, ...). */
export interface MachineStore {
  load(): { machines: Machine[]; probes: Record<string, ProbeResult> };
  save(machines: Machine[], probes: Record<string, ProbeResult>): Promise<void>;
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
    name: input.name.trim() || (parseWslHost(host) ? `Local GPU (${parseWslHost(host)})` : host),
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
    this.machines = this.machines.filter((m) => m.id !== id);
    delete this.probes[id];
    await this.persist();
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
      result = { ...(await client.probe(this.workdir())), ok: true, at: Date.now() };
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

  async gpuLaunch(req: Omit<LaunchPodRequest, "publicKey"> & { idleStopMinutes?: number }): Promise<CloudPodView> {
    const key = await ensureCloudKey();
    const { idleStopMinutes, ...launch } = req;
    const pod = await (await this.cloudClient()).launch({ ...launch, publicKey: key.publicKey });
    this.pendingIdle.set(pod.id, idleStopMinutes ?? DEFAULT_IDLE_STOP_MINUTES);
    const [view] = await this.syncPodMachines([pod], false);
    return view!;
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
            idleStopMinutes: this.pendingIdle.get(pod.id) ?? DEFAULT_IDLE_STOP_MINUTES,
          };
          this.machines = [...this.machines, m];
          fresh.push(m.id);
          changed = true;
        } else if (m.host !== host || m.port !== pod.ssh.port) {
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
    for (const id of fresh) void this.probeMachine(id).catch(() => {});
    return views;
  }
}
