import { randomBytes } from "node:crypto";
import path from "node:path";
import {
  PROTOCOL_VERSION,
  applyEvent,
  displayStatus,
  downsample,
  estimateCost,
  isTerminal,
  parseCliHyperparameters,
  primaryMetricKey,
  summarize,
  type ConnectionState,
  type LocalRunState,
  type Machine,
  type MachineRef,
  type RunEvent,
  type RunManifest,
  type RunNotes,
  type RunStatus,
  type RunSummary,
} from "@converge/run-protocol";
import type { LaunchRequest, ReproducePlan, RunListItem, RunView, SyncPlanView } from "./api.ts";
import { AgentClient, TailSession } from "./agentClient.ts";
import { currentCommit, fingerprint, isGitRepo } from "./git.ts";
import { RunStore } from "./runStore.ts";
import type { Settings } from "./api.ts";
import { createTarStream, makeRules, planSync } from "./sync.ts";
import { explainSshError, transportFor, type RemoteTransport } from "./transport.ts";

interface RunRecord {
  manifest: RunManifest;
  local: LocalRunState | null;
  notes: RunNotes;
  summary: RunSummary;
  connection: ConnectionState;
  connectionDetail?: string;
  tail: TailSession | null;
  pendingWrite: RunEvent[];
  hasPatch: boolean;
}

export interface RunManagerHooks {
  onRunsChanged(runIds: string[]): void;
  onLaunchProgress(p: { runId: string; stage: string; detail?: string }): void;
  onRunFinished(name: string, status: RunStatus, message: string, runId: string): void;
}

export type TransportFactory = (machine: MachineRef) => RemoteTransport;

export function projectSlug(projectPath: string): string {
  return path.basename(projectPath).replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "project";
}

function makeRunId(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}-${randomBytes(2).toString("hex")}`;
}

export class RunManager {
  readonly projectPath: string;
  readonly store: RunStore;
  private readonly settings: () => Settings;
  private readonly hooks: RunManagerHooks;
  private readonly resourcesDir: string;
  private readonly transportFactory: TransportFactory;
  private readonly runs = new Map<string, RunRecord>();
  private readonly installed = new Set<string>();
  private changed = new Set<string>();
  private notifyTimer: NodeJS.Timeout | null = null;
  private writeTimer: NodeJS.Timeout | null = null;
  private lastNumber = 0;
  private disposed = false;

  constructor(projectPath: string, settings: () => Settings, hooks: RunManagerHooks, resourcesDir: string, transportFactory?: TransportFactory) {
    this.projectPath = projectPath;
    this.store = new RunStore(projectPath);
    this.settings = settings;
    this.hooks = hooks;
    this.resourcesDir = resourcesDir;
    this.transportFactory = transportFactory ?? ((m) => transportFor(m, this.settings().sshPath));
  }

  // ------------------------------------------------------------ lifecycle

  async init(): Promise<void> {
    await this.store.init();
    for (const runId of await this.store.listRunIds()) {
      const manifest = await this.store.readManifest(runId);
      if (!manifest) continue;
      const [events, local, notes, hasPatch] = await Promise.all([
        this.store.readEvents(runId),
        this.store.readLocal(runId),
        this.store.readNotes(runId),
        this.store.hasPatch(runId),
      ]);
      this.runs.set(runId, { manifest, local, notes, summary: summarize(events), connection: "idle", tail: null, pendingWrite: [], hasPatch });
      this.lastNumber = Math.max(this.lastNumber, manifest.number);
    }
    // Resume observation of anything that may still be running.
    for (const [runId, r] of this.runs) {
      if (r.local?.phase === "launched" && !(r.summary.status && isTerminal(r.summary.status))) this.startTail(runId);
    }
  }

  dispose(): void {
    this.disposed = true;
    for (const r of this.runs.values()) r.tail?.stop();
    this.flushWrites();
  }

  // ------------------------------------------------------------ helpers

  private client(m: MachineRef): AgentClient {
    return new AgentClient(this.transportFactory(m), m.python, (stderr) => explainSshError(stderr, m.host));
  }

  private async ensureAgent(m: MachineRef, client: AgentClient): Promise<void> {
    const key = `${m.host}:${m.port ?? 22}:${m.python}`;
    if (this.installed.has(key)) return;
    await client.install(this.resourcesDir);
    this.installed.add(key);
  }

  workdir(): string {
    const root = this.settings().remoteRoot.replace(/\/+$/, "");
    return `${root}/${projectSlug(this.projectPath)}`;
  }

  private markChanged(runId: string): void {
    this.changed.add(runId);
    if (this.notifyTimer) return;
    this.notifyTimer = setTimeout(() => {
      this.notifyTimer = null;
      const ids = [...this.changed];
      this.changed.clear();
      if (!this.disposed) this.hooks.onRunsChanged(ids);
    }, 250);
  }

  private scheduleWrite(): void {
    if (this.writeTimer) return;
    this.writeTimer = setTimeout(() => {
      this.writeTimer = null;
      this.flushWrites();
    }, 500);
  }

  private flushWrites(): void {
    for (const [runId, r] of this.runs) {
      if (!r.pendingWrite.length) continue;
      const batch = r.pendingWrite;
      r.pendingWrite = [];
      this.store.appendEvents(runId, batch).catch(() => {
        r.pendingWrite.unshift(...batch);
      });
    }
  }

  private applyEvents(runId: string, events: RunEvent[]): void {
    const r = this.runs.get(runId);
    if (!r) return;
    const before = r.summary.status;
    const accepted: RunEvent[] = [];
    for (const ev of events) {
      if (ev.seq <= r.summary.lastSeq) continue;
      applyEvent(r.summary, ev);
      accepted.push(ev);
    }
    if (!accepted.length) return;
    r.pendingWrite.push(...accepted);
    this.scheduleWrite();
    this.markChanged(runId);
    const after = r.summary.status;
    if (after && after !== before && isTerminal(after)) {
      const diag = r.summary.diagnostics.find((d) => d.severity === "error");
      this.hooks.onRunFinished(r.manifest.name, after, diag?.message ?? (after === "completed" ? "Training finished." : `Run ${after}.`), runId);
    }
  }

  private startTail(runId: string): void {
    const r = this.runs.get(runId);
    if (!r || this.disposed) return;
    r.tail?.stop();
    const client = this.client(r.manifest.machine);
    const session = new TailSession(client, runId, r.summary.lastSeq, {
      onEvents: (evs) => this.applyEvents(runId, evs),
      onConnection: (state, detail) => {
        r.connection = state;
        r.connectionDetail = state === "live" ? undefined : detail || undefined;
        this.markChanged(runId);
      },
      onControl: (line) => {
        if (line.type === "end") {
          session.stop();
          r.tail = null;
          if (line.status === "unknown") {
            r.connection = "lost";
            r.connectionDetail = "The Converlt supervisor is no longer running on the machine (machine restarted?). The training outcome could not be observed.";
          } else r.connection = "idle";
          this.markChanged(runId);
        } else if (line.type === "error") {
          session.stop();
          r.tail = null;
          r.connection = "lost";
          r.connectionDetail = line.message ?? line.error;
          this.markChanged(runId);
        }
      },
    });
    r.tail = session;
    r.connection = "reconnecting";
    session.start();
  }

  // ------------------------------------------------------------ queries

  private status(r: RunRecord): RunStatus {
    return displayStatus(r.summary.status, r.local, r.connection);
  }

  private timing(r: RunRecord): { durationSec: number | null; costUsd: number | null } {
    const s = r.summary;
    if (s.startedAt === null) return { durationSec: null, costUsd: null };
    const live = !s.endedAt && this.status(r) === "running";
    const end = s.endedAt ?? (live ? Date.now() / 1000 : (s.lastEventAt ?? s.startedAt));
    const cost = estimateCost(r.manifest.machine.hourlyRate, s.startedAt, end);
    return { durationSec: end - s.startedAt, costUsd: cost.usd };
  }

  listRuns(): RunListItem[] {
    const items: RunListItem[] = [];
    for (const r of this.runs.values()) {
      const s = r.summary;
      const key = primaryMetricKey(Object.keys(s.metrics));
      const series = key ? s.metrics[key]! : [];
      const { durationSec, costUsd } = this.timing(r);
      items.push({
        runId: r.manifest.runId,
        number: r.manifest.number,
        name: r.manifest.name,
        command: r.manifest.command,
        machineName: r.manifest.machine.name,
        gpuName: s.env?.gpus?.[0]?.name ?? s.latestTelemetry?.gpus[0]?.name ?? null,
        status: this.status(r),
        connection: r.connection,
        createdAt: r.manifest.createdAt,
        startedAt: s.startedAt,
        endedAt: s.endedAt,
        durationSec,
        costUsd,
        primaryMetric: key ? { key, last: series.at(-1)?.value ?? null, spark: downsample(series, 48).map((p) => p.value) } : null,
        diagnosticKinds: s.diagnostics.map((d) => d.kind),
        group: r.notes.group,
        gitCommit: r.manifest.git?.commit ?? null,
        dirty: r.manifest.git?.dirty ?? false,
        reproducedFrom: r.manifest.reproducedFrom,
      });
    }
    return items.sort((a, b) => b.createdAt - a.createdAt);
  }

  getRun(runId: string): RunView | null {
    const r = this.runs.get(runId);
    if (!r) return null;
    const s = r.summary;
    const metrics: RunSummary["metrics"] = {};
    for (const [k, v] of Object.entries(s.metrics)) metrics[k] = downsample(v, 1500);
    const { durationSec, costUsd } = this.timing(r);
    return {
      manifest: r.manifest,
      notes: r.notes,
      local: r.local,
      status: this.status(r),
      connection: r.connection,
      connectionDetail: r.connectionDetail ?? null,
      summary: { ...s, metrics, telemetry: downsample(s.telemetry, 1200) },
      durationSec,
      costUsd,
      effectiveConfig: { ...r.manifest.hyperparameters, ...s.config },
      hasPatch: r.hasPatch,
    };
  }

  async planSync(): Promise<SyncPlanView> {
    const st = this.settings();
    const plan = await planSync(this.projectPath, makeRules(st.syncExclude, st.maxFileSizeMB));
    return {
      root: plan.root,
      files: plan.files.length,
      bytes: plan.bytes,
      skipped: plan.skipped.slice(0, 200),
      skippedCount: plan.skipped.length,
      usedGit: plan.usedGit,
    };
  }

  // ------------------------------------------------------------ commands

  async launch(req: LaunchRequest, machine: Machine): Promise<{ runId: string }> {
    const st = this.settings();
    const runId = makeRunId();
    this.lastNumber = Math.max(this.lastNumber, await this.store.nextNumber() - 1) + 1;
    const number = this.lastNumber;
    const progress = (stage: string, detail?: string) => this.hooks.onLaunchProgress({ runId, stage, detail });

    const [git, plan] = await Promise.all([
      fingerprint(this.projectPath),
      planSync(this.projectPath, makeRules(st.syncExclude, st.maxFileSizeMB)),
    ]);
    const machineRef: MachineRef = {
      id: machine.id,
      name: machine.name,
      host: machine.host,
      port: machine.port,
      identityFile: machine.identityFile,
      python: machine.python,
      hourlyRate: machine.hourlyRate,
      cloudPodId: machine.cloudPodId,
      cloudPricePerHour: machine.cloudPricePerHour,
    };
    const manifest: RunManifest = {
      schemaVersion: PROTOCOL_VERSION,
      runId,
      number,
      name: `run-${String(number).padStart(3, "0")}`,
      project: projectSlug(this.projectPath),
      createdAt: Date.now() / 1000,
      command: req.command,
      hyperparameters: parseCliHyperparameters(req.command),
      framework: "pytorch",
      machine: machineRef,
      workdir: this.workdir(),
      git: git?.fp ?? null,
      sync: { files: plan.files.length, bytes: plan.bytes, skipped: plan.skipped.length },
      options: req.options,
      reproducedFrom: req.reproducedFrom,
    };
    await this.store.createRun(manifest, git?.patch ?? null);
    const local: LocalRunState = { phase: "preparing", updatedAt: Date.now() };
    await this.store.writeLocal(runId, local);
    this.runs.set(runId, {
      manifest,
      local,
      notes: await this.store.readNotes(runId),
      summary: summarize([]),
      connection: "idle",
      tail: null,
      pendingWrite: [],
      hasPatch: !!git?.patch,
    });
    this.markChanged(runId);

    void (async () => {
      const r = this.runs.get(runId)!;
      try {
        const client = this.client(machineRef);
        progress("agent", `Connecting to ${machine.name}`);
        await this.ensureAgent(machineRef, client);
        progress("sync", `Syncing ${plan.files.length} files`);
        const tar = await createTarStream(plan);
        await Promise.all([client.uploadDirectory(tar.stream, manifest.workdir), tar.done]);
        progress("start", "Starting training");
        await client.start({
          runId,
          name: manifest.name,
          project: manifest.project,
          command: manifest.command,
          workdir: manifest.workdir,
          python: machine.python,
          env: {},
          options: manifest.options,
        });
        r.local = { phase: "launched", updatedAt: Date.now() };
        await this.store.writeLocal(runId, r.local);
        progress("started");
        this.startTail(runId);
      } catch (e) {
        r.local = { phase: "launch_failed", error: e instanceof Error ? e.message : String(e), updatedAt: Date.now() };
        await this.store.writeLocal(runId, r.local).catch(() => {});
        progress("failed", r.local.error);
        this.hooks.onRunFinished(manifest.name, "failed", r.local.error!, runId);
      }
      this.markChanged(runId);
    })();

    return { runId };
  }

  async cancel(runId: string): Promise<void> {
    const r = this.runs.get(runId);
    if (!r) throw new Error("Unknown run");
    if (r.local?.phase !== "launched") throw new Error("This run has not started on the machine yet.");
    await this.client(r.manifest.machine).cancel(runId);
    if (!r.tail) this.startTail(runId);
  }

  reconnect(runId: string): void {
    const r = this.runs.get(runId);
    if (!r || r.local?.phase !== "launched") return;
    if (r.tail) r.tail.kick();
    else this.startTail(runId);
  }

  async saveNotes(runId: string, notes: RunNotes): Promise<void> {
    const r = this.runs.get(runId);
    if (!r) return;
    r.notes = notes;
    await this.store.writeNotes(runId, notes);
    this.markChanged(runId);
  }

  async planReproduce(runId: string, machines: Machine[]): Promise<ReproducePlan> {
    const r = this.runs.get(runId);
    if (!r) throw new Error("Unknown run");
    const m = r.manifest;
    const warnings: string[] = [];
    const head = (await isGitRepo(this.projectPath)) ? await currentCommit(this.projectPath) : null;
    if (m.git?.commit && head && head !== m.git.commit)
      warnings.push(`Your checkout is at ${head.slice(0, 8)}, but the run used ${m.git.commit.slice(0, 8)}. Check out that commit for an exact reproduction.`);
    if (m.git?.dirty) warnings.push("The original run had uncommitted changes. They are saved in its code.patch; apply them before reproducing.");
    if (!m.git) warnings.push("The original run was not in a git repository, so its exact code version is unknown.");
    const machine = machines.find((x) => x.id === m.machine.id) ?? null;
    if (!machine) warnings.push(`The original machine (${m.machine.name}) is no longer registered. Pick another machine; results may differ on different hardware.`);
    const datasets = r.summary.inputs.filter((i) => i.kind === "dataset" && i.fingerprint);
    if (datasets.length)
      warnings.push(`The original run's data is fingerprinted (${datasets.map((d) => d.name).join(", ")}). Compare the reproduction with it afterwards: a data change shows up as a cause.`);
    else
      warnings.push("The original run recorded no dataset fingerprint, so a data change wouldn't be noticed. Hugging Face load_dataset is recorded automatically; for local data, call run.log_dataset(path).");
    warnings.push("GPU kernels and data loading may be nondeterministic unless the script seeds and enables deterministic algorithms.");
    return { command: m.command, machineId: machine?.id ?? null, options: m.options, warnings };
  }
}
