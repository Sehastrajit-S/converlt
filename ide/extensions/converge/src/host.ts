import * as vscode from "vscode";
import type { Machine, RunStatus } from "@converge/run-protocol";
import { ConvergeService, DEFAULT_SETTINGS, LocalGateway, type AppState, type InvokeMethod, type ProbeResult, type Settings } from "@converge/core";

const MACHINES_KEY = "converge.machines";
const PROBES_KEY = "converge.probes";
const CLOUD_SECRET = "converge.cloud";

export function readSettings(): Settings {
  const c = vscode.workspace.getConfiguration("converge");
  const d = DEFAULT_SETTINGS;
  return {
    sshPath: c.get("sshPath", d.sshPath),
    remoteRoot: c.get("remoteRoot", d.remoteRoot),
    defaultCommand: c.get("defaultCommand", d.defaultCommand),
    syncExclude: c.get("sync.exclude", d.syncExclude),
    maxFileSizeMB: c.get("sync.maxFileSizeMB", d.maxFileSizeMB),
    defaultOptions: {
      stopOnNan: c.get("runs.stopOnNan", d.defaultOptions.stopOnNan),
      stallMinutes: c.get("runs.stallMinutes", d.defaultOptions.stallMinutes),
      telemetryIntervalSec: c.get("runs.telemetryIntervalSeconds", d.defaultOptions.telemetryIntervalSec),
      cancelGraceSec: c.get("runs.cancelGraceSeconds", d.defaultOptions.cancelGraceSec),
    },
    theme: "system", // the editor theme applies
    notifications: c.get("notifications", d.notifications),
  };
}

async function writeSettings(patch: Partial<Settings>): Promise<Settings> {
  const c = vscode.workspace.getConfiguration("converge");
  const g = vscode.ConfigurationTarget.Global;
  const set = (key: string, v: unknown) => (v === undefined ? Promise.resolve() : c.update(key, v, g));
  await Promise.all([
    set("sshPath", patch.sshPath),
    set("remoteRoot", patch.remoteRoot),
    set("defaultCommand", patch.defaultCommand),
    set("sync.exclude", patch.syncExclude),
    set("sync.maxFileSizeMB", patch.maxFileSizeMB),
    set("notifications", patch.notifications),
    set("runs.stopOnNan", patch.defaultOptions?.stopOnNan),
    set("runs.stallMinutes", patch.defaultOptions?.stallMinutes),
    set("runs.telemetryIntervalSeconds", patch.defaultOptions?.telemetryIntervalSec),
    set("runs.cancelGraceSeconds", patch.defaultOptions?.cancelGraceSec),
  ]);
  return readSettings();
}

/** Syncing and running the folder's code needs a trusted workspace (Restricted Mode blocks it). */
/** Recently opened local folders, newest first (the editor's own list). */
async function recentFolders(): Promise<string[]> {
  try {
    const r = (await vscode.commands.executeCommand("_workbench.getRecentlyOpened")) as { workspaces?: { folderUri?: vscode.Uri }[] } | undefined;
    return (r?.workspaces ?? [])
      .map((w) => w.folderUri)
      .filter((u): u is vscode.Uri => !!u && u.scheme === "file")
      .map((u) => u.fsPath)
      .slice(0, 12);
  } catch {
    return [];
  }
}

export async function requireTrust(action: string): Promise<void> {
  if (vscode.workspace.isTrusted) return;
  const pick = await vscode.window.showWarningMessage(`Converlt: trust this folder to ${action}. In Restricted Mode Converlt doesn't sync or run its code.`, "Manage Workspace Trust");
  if (pick) await vscode.commands.executeCommand("workbench.trust.manage");
  throw new Error(`Trust this folder to ${action}.`);
}

export interface HostEvents {
  runsChanged: vscode.EventEmitter<string[]>;
  stateChanged: vscode.EventEmitter<void>;
  launchProgress: vscode.EventEmitter<{ runId: string; stage: string; detail?: string }>;
  runFinished: vscode.EventEmitter<{ name: string; status: RunStatus; message: string; runId?: string }>;
}

/** Owns the ConvergeService for this window and adapts it to VS Code. */
export class Host implements vscode.Disposable {
  readonly service: ConvergeService;
  readonly events: HostEvents = {
    runsChanged: new vscode.EventEmitter(),
    stateChanged: new vscode.EventEmitter(),
    launchProgress: new vscode.EventEmitter(),
    runFinished: new vscode.EventEmitter(),
  };
  private readonly ctx: vscode.ExtensionContext;
  /** Opens a project folder in this window (set during activation). */
  openProjectHook: ((path: string) => Promise<void>) | null = null;

  constructor(ctx: vscode.ExtensionContext) {
    this.ctx = ctx;
    const secrets = {
      get: (key: string) => Promise.resolve(ctx.secrets.get(`converge.${key}`)),
      set: async (key: string, value: string | null) => (value === null ? ctx.secrets.delete(`converge.${key}`) : ctx.secrets.store(`converge.${key}`, value)),
    };
    this.service = new ConvergeService({
      secrets,
      // "Use my own keys": the editor's own runtime runs the bundled gateway.
      localGateway: new LocalGateway({ executable: process.execPath, script: vscode.Uri.joinPath(ctx.extensionUri, "dist", "gateway", "main.mjs").fsPath, secrets }),
      mcp: { command: process.execPath, script: vscode.Uri.joinPath(ctx.extensionUri, "dist", "mcp", "server.mjs").fsPath },
      resourcesDir: vscode.Uri.joinPath(ctx.extensionUri, "dist", "remote").fsPath,
      settings: readSettings,
      store: {
        load: () => ({
          machines: ctx.globalState.get<Machine[]>(MACHINES_KEY, []),
          probes: ctx.globalState.get<Record<string, ProbeResult>>(PROBES_KEY, {}),
        }),
        save: async (machines, probes) => {
          await ctx.globalState.update(MACHINES_KEY, machines);
          await ctx.globalState.update(PROBES_KEY, probes);
        },
      },
      // The gateway URL and token live in VS Code's SecretStorage (the OS keychain).
      cloud: {
        get: async () => {
          const raw = await ctx.secrets.get(CLOUD_SECRET);
          try {
            return raw ? (JSON.parse(raw) as { url: string; token: string }) : null;
          } catch {
            return null;
          }
        },
        set: async (creds) => (creds ? ctx.secrets.store(CLOUD_SECRET, JSON.stringify(creds)) : ctx.secrets.delete(CLOUD_SECRET)),
      },
      hooks: {
        runsChanged: (ids) => this.events.runsChanged.fire(ids),
        stateChanged: () => this.events.stateChanged.fire(),
        launchProgress: (p) => this.events.launchProgress.fire(p),
        runFinished: (name, status, message, runId) => this.events.runFinished.fire({ name, status, message, runId }),
      },
    });
  }

  async openWorkspace(): Promise<void> {
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder || folder.uri.scheme !== "file") {
      if (this.service.project) this.service.closeProject();
      return;
    }
    if (this.service.project?.path === folder.uri.fsPath) return;
    await this.service.openProject(folder.uri.fsPath);
  }

  /** RPC surface for the webviews (see @converge/core/api). */
  readonly handlers: Record<InvokeMethod, (...args: any[]) => unknown> = {
    getState: async (): Promise<AppState> => ({
      version: String(this.ctx.extension.packageJSON.version),
      platform: process.platform,
      project: this.service.project,
      recentProjects: await recentFolders(),
      machines: this.service.listMachines(),
      probes: this.service.listProbes(),
      settings: readSettings(),
    }),
    openProjectDialog: async () => {
      await vscode.commands.executeCommand("workbench.action.files.openFolder");
      return this.service.project;
    },
    openProject: async (p: string) => {
      if (this.openProjectHook && p !== this.service.project?.path) await this.openProjectHook(p);
      return this.service.project;
    },
    closeProject: async () => {},
    openInEditor: async (p?: string) => {
      if (p) await vscode.window.showTextDocument(vscode.Uri.file(p));
    },
    revealPath: async (p: string) => vscode.commands.executeCommand("revealFileInOS", vscode.Uri.file(p)),

    addMachine: (input) => this.service.addMachine(input),
    updateMachine: (id, input) => this.service.updateMachine(id, input),
    removeMachine: (id) => this.service.removeMachine(id),
    probeMachine: (id) => this.service.probeMachine(id),
    machineTelemetry: (id) => this.service.machineTelemetry(id),

    listRuns: () => this.service.listRuns(),
    getRun: (runId) => this.service.getRun(runId),
    planSync: () => this.service.planSync(),
    launchRun: async (req) => {
      await requireTrust("launch runs");
      return this.service.launchRun(req);
    },
    cancelRun: (runId) => this.service.cancelRun(runId),
    reconnectRun: (runId) => this.service.reconnectRun(runId),
    saveNotes: (runId, notes) => this.service.saveNotes(runId, notes),
    planReproduce: (runId) => this.service.planReproduce(runId),
    openPatch: async (runId: string) => {
      const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(this.service.patchPath(runId)));
      await vscode.window.showTextDocument(doc, { preview: true });
    },
    gitDiff: (from, to) => this.service.gitDiff(from, to),
    updateSettings: (patch) => writeSettings(patch),

    listEnvs: (id) => this.service.listEnvs(id),
    createEnv: (id, spec) => this.service.createEnv(id, spec),
    installPackages: (id, python, spec) => this.service.installPackages(id, python, spec),
    envPackages: (id, python) => this.service.envPackages(id, python),
    removeEnv: (id, name) => this.service.removeEnv(id, name),
    useEnv: (id, python) => this.service.useEnv(id, python),
    // An untrusted folder's requirements.txt isn't offered for installation.
    projectRequirements: async () => (vscode.workspace.isTrusted ? this.service.projectRequirements() : null),

    hubSearch: (source, kind, query) => this.service.hubSearch(source, kind, query),
    hubDetails: (source, kind, id) => this.service.hubDetails(source, kind, id),
    hubAccounts: () => this.service.hubAccounts(),
    hubSetAccount: (source, secret) => this.service.hubSetAccount(source, secret),
    hubDownload: (id, source, kind, ref) => this.service.hubDownload(id, source, kind, ref),
    hubJobs: (id) => this.service.hubJobs(id),
    hubRemove: (id, jobId) => this.service.hubRemove(id, jobId),

    cloudStatus: () => this.service.cloudStatus(),
    cloudConnect: (url, token) => this.service.cloudConnect(url, token),
    cloudDisconnect: () => this.service.cloudDisconnect(),
    cloudWallet: () => this.service.cloudWallet(),
    cloudLedger: (limit) => this.service.cloudLedger(limit),
    cloudSetLimits: (limits) => this.service.cloudSetLimits(limits),
    gpuOffers: () => this.service.gpuOffers(),
    gpuPods: () => this.service.gpuPods(),
    gpuLaunch: (req) => this.service.gpuLaunch(req),
    gpuStop: (id) => this.service.gpuStop(id),
    gpuStart: (id) => this.service.gpuStart(id),
    gpuTerminate: (id) => this.service.gpuTerminate(id),
    cloudModels: () => this.service.cloudModels(),
    localGateway: () => this.service.localGateway(),
    localGatewaySetKeys: (keys) => this.service.localGatewaySetKeys(keys),
    localGatewayStart: (credits) => this.service.localGatewayStart(credits),
    localGatewayStop: () => this.service.localGatewayStop(),
    localGatewayAddCredits: (credits) => this.service.localGatewayAddCredits(credits),
    agentsStatus: () => this.service.agentsStatus(),
    agentsConnect: (which) => this.service.agentsConnect(which),
    modelComplete: (model, prompt) => this.service.modelComplete(model, prompt),
  };

  dispose(): void {
    this.service.dispose();
    for (const e of Object.values(this.events)) e.dispose();
  }
}
