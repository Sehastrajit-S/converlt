import * as vscode from "vscode";
import os from "node:os";
import path from "node:path";
import { THEMES } from "@converge/ui/themes";

function readUiTheme(): { current: string; followSystem: boolean } {
  return {
    current: vscode.workspace.getConfiguration("workbench").get<string>("colorTheme") ?? "Converlt Dark",
    followSystem: vscode.workspace.getConfiguration("window").get<boolean>("autoDetectColorScheme") ?? false,
  };
}
import type { Machine, RunStatus } from "@converge/run-protocol";
import { ConvergeService, DEFAULT_SETTINGS, LocalGateway, type AppState, type InvokeMethod, type ProbeResult, type Settings } from "@converge/core";

const MACHINES_KEY = "converge.machines";
const PROBES_KEY = "converge.probes";
const DISMISSED_LOCAL_KEY = "converge.dismissedLocalGpus";
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
      notifyUrl: c.get<string>("runs.phoneAlertsUrl", "") || undefined,
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
    // "" turns alerts off; a defaultOptions patch without the key leaves them as they are.
    set("runs.phoneAlertsUrl", patch.defaultOptions && "notifyUrl" in patch.defaultOptions ? (patch.defaultOptions.notifyUrl ?? "") : undefined),
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
      openExternal: (url) => Promise.resolve(vscode.env.openExternal(vscode.Uri.parse(url))),
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
        dismissedLocal: () => ctx.globalState.get<string[]>(DISMISSED_LOCAL_KEY, []),
        dismissLocal: async (host) => {
          const list = ctx.globalState.get<string[]>(DISMISSED_LOCAL_KEY, []);
          if (!list.includes(host)) await ctx.globalState.update(DISMISSED_LOCAL_KEY, [...list, host]);
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
    discoverLocalMachines: () => this.service.discoverLocalMachines(),
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
    reproduceEnv: (runId, machineId) => this.service.reproduceEnv(runId, machineId),
    shareRun: async (runId) => {
      const run = this.service.getRun(runId);
      const project = this.service.project;
      if (!run || !project) throw new Error("Unknown run");
      const target = await vscode.window.showSaveDialog({
        title: `Share ${run.manifest.name}`,
        saveLabel: "Save run file",
        defaultUri: vscode.Uri.file(path.join(os.homedir(), `${project.name}-${run.manifest.name.replace(/[^\w.-]+/g, "_")}.converlt-run`)),
        filters: { "Converlt run": ["converlt-run"] },
      });
      if (!target) return null;
      await this.service.exportRun(runId, target.fsPath);
      return { path: target.fsPath };
    },
    openSharedRun: async () => {
      const [file] =
        (await vscode.window.showOpenDialog({ title: "Open a shared run", openLabel: "Open run", canSelectMany: false, filters: { "Converlt run": ["converlt-run"] } })) ?? [];
      if (!file) return null;
      return this.service.importRun(file.fsPath);
    },
    openPatch: async (runId: string) => {
      const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(this.service.patchPath(runId)));
      await vscode.window.showTextDocument(doc, { preview: true });
    },
    gitDiff: (from, to) => this.service.gitDiff(from, to),
    explainRuns: (a, b) => this.service.explainRuns(a, b),
    explainRunsWithAi: (a, b) => this.service.explainRunsWithAi(a, b),
    estimateJob: (req) => this.service.estimateJob(req),
    launchSweep: (req) => this.service.launchSweep(req),
    listSweeps: async () => this.service.listSweeps(),
    cancelSweep: async (name) => this.service.cancelSweep(name),
    writeReport: async (req) => {
      const r = await this.service.writeReport(req);
      await vscode.commands.executeCommand("markdown.showPreview", vscode.Uri.file(r.path)).then(undefined, () => vscode.window.showTextDocument(vscode.Uri.file(r.path)));
      return { path: r.path };
    },
    updateSettings: (patch) => writeSettings(patch),
    testPhoneAlert: (url) => this.service.testPhoneAlert(url),

    listEnvs: (id) => this.service.listEnvs(id),
    createEnv: (id, spec) => this.service.createEnv(id, spec),
    installPackages: (id, python, spec) => this.service.installPackages(id, python, spec),
    envPackages: (id, python) => this.service.envPackages(id, python),
    removeEnv: (id, name) => this.service.removeEnv(id, name),
    useEnv: (id, python) => this.service.useEnv(id, python),
    // An untrusted folder's requirements.txt isn't offered for installation.
    dataList: () => this.service.dataList(),
    dataSyncHub: () => this.service.dataSyncHub(),
    dataSave: (d) => this.service.dataSave(d),
    dataRemove: (id) => this.service.dataRemove(id),
    dataBrowse: (machineId, dir) => this.service.dataBrowse(machineId, dir),
    dataProfile: (id) => this.service.dataProfile(id),
    dataPreview: (id) => this.service.dataPreview(id),
    dataWriteCode: async (id) => {
      await requireTrust("save data scripts into this folder");
      return this.service.dataWriteCode(id);
    },
    dataRunPreprocess: async (id) => {
      await requireTrust("run preprocessing");
      return this.service.dataRunPreprocess(id);
    },
    builderList: () => this.service.builderList(),
    builderCodeFiles: () => this.service.builderCodeFiles(),
    builderImport: (req) => this.service.builderImport(req),
    builderSave: async (graph, train) => {
      await requireTrust("save the model into this folder");
      return this.service.builderSave(graph, train);
    },
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
    cloudSignInStart: (url) => this.service.cloudSignInStart(url),
    cloudSignInWait: () => this.service.cloudSignInWait(),
    cloudSignInCancel: () => this.service.cloudSignInCancel(),
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
    confirmAction: async (message: string, confirmLabel: string) => (await vscode.window.showWarningMessage(message, { modal: true }, confirmLabel)) === confirmLabel,
    uiTheme: async () => readUiTheme(),
    setUiTheme: async (change: { theme?: string; followSystem?: boolean }) => {
      const g = vscode.ConfigurationTarget.Global;
      if (change.theme) {
        const t = THEMES.find((x) => x.id === change.theme);
        await vscode.workspace.getConfiguration("workbench").update("colorTheme", change.theme, g);
        // Remember it as the preferred one of its kind, so following the OS keeps the choice.
        if (t) await vscode.workspace.getConfiguration("workbench").update(t.type === "light" ? "preferredLightColorTheme" : "preferredDarkColorTheme", change.theme, g);
      }
      if (change.followSystem !== undefined) await vscode.workspace.getConfiguration("window").update("autoDetectColorScheme", change.followSystem, g);
      return readUiTheme();
    },
  };

  dispose(): void {
    this.service.dispose();
    for (const e of Object.values(this.events)) e.dispose();
  }
}
