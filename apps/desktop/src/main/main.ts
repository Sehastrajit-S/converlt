// Standalone desktop shell. The Converlt IDE (ide/) is the primary product; this shell
// shares the same engine (@converge/core) and screens (@converge/ui).
import { existsSync } from "node:fs";
import { readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { BrowserWindow, Notification, app, dialog, ipcMain, nativeTheme, safeStorage, shell } from "electron";
import { ConvergeService, IPC, LocalGateway, startBridge, type AppState, type InvokeMethod, type ProjectInfo, type Settings } from "@converge/core";
import { AppStore } from "./settings.ts";
import { listDir, listFiles, readText, search as searchFiles, writeText } from "./workspace.ts";
import { Terminals } from "./terminal.ts";
import * as git from "./git.ts";
import { Agent } from "./agent.ts";
import { IDE, type AgentContext, type AgentToolResult, type IdeMethod, type SearchOptions } from "../shared/ide.ts";

const isDev = !!process.env.CONVERGE_DEV_URL;
const resourcesDir = app.isPackaged ? path.join(process.resourcesPath, "remote") : path.join(__dirname, "remote");

let win: BrowserWindow | null = null;
let appStore: AppStore;
let service: ConvergeService;

// ---------------------------------------------------------------- window

// Matches the IDE frame (--bg-sunken) behind the floating panels.
const TITLEBAR = { dark: { color: "#08090d", symbolColor: "#c9cfdb" }, light: { color: "#eef0f3", symbolColor: "#3a4150" } };

function applyTheme(): void {
  nativeTheme.themeSource = appStore.data.settings.theme;
  if (win && process.platform !== "darwin") {
    try {
      win.setTitleBarOverlay({ ...(nativeTheme.shouldUseDarkColors ? TITLEBAR.dark : TITLEBAR.light), height: 44 });
    } catch {
      // overlay unsupported on this platform
    }
  }
}

function createWindow(): void {
  const dark = nativeTheme.shouldUseDarkColors;
  win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 980,
    minHeight: 640,
    show: false,
    backgroundColor: dark ? "#08090d" : "#eef0f3",
    titleBarStyle: "hidden",
    ...(process.platform === "darwin"
      ? { trafficLightPosition: { x: 14, y: 14 } }
      : { titleBarOverlay: { ...(dark ? TITLEBAR.dark : TITLEBAR.light), height: 44 } }),
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });
  win.once("ready-to-show", () => win?.show());
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) void shell.openExternal(url);
    return { action: "deny" };
  });
  // The renderer blocks unload while the editor has unsaved files.
  win.webContents.on("will-prevent-unload", (e) => {
    const choice = dialog.showMessageBoxSync(win!, {
      type: "warning",
      buttons: ["Discard changes", "Cancel"],
      defaultId: 1,
      cancelId: 1,
      message: "You have unsaved changes.",
      detail: "Close Converlt and discard them?",
    });
    if (choice === 0) e.preventDefault();
  });
  win.webContents.on("will-navigate", (e, url) => {
    if (!url.startsWith(process.env.CONVERGE_DEV_URL ?? "file://")) e.preventDefault();
  });
  if (isDev) void win.loadURL(process.env.CONVERGE_DEV_URL!);
  else void win.loadFile(path.join(__dirname, "renderer", "index.html"));
  win.on("closed", () => (win = null));
}

function send(channel: string, payload?: unknown): void {
  win?.webContents.send(channel, payload);
}

async function openProject(p: string): Promise<ProjectInfo> {
  const info = await service.openProject(p);
  agent?.reset(); // the conversation is about the previous project
  appStore.touchProject(p);
  await appStore.save();
  return info;
}

// ---------------------------------------------------------------- IPC

type Handler = (...args: any[]) => unknown;

const handlers: Record<InvokeMethod, Handler> = {
  async getState(): Promise<AppState> {
    return {
      version: app.getVersion(),
      platform: process.platform,
      project: service.project,
      recentProjects: appStore.data.recentProjects.filter((p) => existsSync(p)),
      machines: service.listMachines(),
      probes: service.listProbes(),
      settings: appStore.data.settings,
    };
  },
  async openProjectDialog() {
    const res = await dialog.showOpenDialog(win!, { title: "Open ML project", properties: ["openDirectory"] });
    if (res.canceled || !res.filePaths[0]) return null;
    return openProject(res.filePaths[0]);
  },
  openProject: (p: string) => openProject(p),
  async closeProject() {
    service.closeProject();
    agent?.reset();
    appStore.data.lastProject = null;
    await appStore.save();
  },
  async openInEditor(p?: string) {
    const target = p ?? service.project?.path;
    if (!target) return;
    // On Windows `code` is a .cmd shim, which Node can only start through a shell.
    const win32 = process.platform === "win32";
    const arg = win32 ? `"${target.replace(/"/g, "")}"` : target;
    const child = spawn("code", [arg], { shell: win32, detached: true, stdio: "ignore", windowsHide: true });
    child.on("error", () => void shell.openPath(target));
    child.unref();
  },
  async revealPath(p: string) {
    shell.showItemInFolder(p);
  },

  addMachine: (input) => service.addMachine(input),
  updateMachine: (id, input) => service.updateMachine(id, input),
  removeMachine: (id) => service.removeMachine(id),
  probeMachine: (id) => service.probeMachine(id),
  machineTelemetry: (id) => service.machineTelemetry(id),

  listRuns: () => service.listRuns(),
  getRun: (runId) => service.getRun(runId),
  planSync: () => service.planSync(),
  launchRun: (req) => service.launchRun(req),
  cancelRun: (runId) => service.cancelRun(runId),
  reconnectRun: (runId) => service.reconnectRun(runId),
  saveNotes: (runId, notes) => service.saveNotes(runId, notes),
  planReproduce: (runId) => service.planReproduce(runId),
  async openPatch(runId: string) {
    const p = service.patchPath(runId);
    const err = await shell.openPath(p);
    if (err) shell.showItemInFolder(p);
  },
  gitDiff: (from, to) => service.gitDiff(from, to),

  async updateSettings(patch: Partial<Settings>) {
    const s = appStore.data.settings;
    appStore.data.settings = { ...s, ...patch, defaultOptions: { ...s.defaultOptions, ...(patch.defaultOptions ?? {}) } };
    await appStore.save();
    if (patch.theme) applyTheme();
    send(IPC.stateChanged);
    return appStore.data.settings;
  },

  listEnvs: (id) => service.listEnvs(id),
  createEnv: (id, spec) => service.createEnv(id, spec),
  installPackages: (id, python, spec) => service.installPackages(id, python, spec),
  envPackages: (id, python) => service.envPackages(id, python),
  removeEnv: (id, name) => service.removeEnv(id, name),
  useEnv: (id, python) => service.useEnv(id, python),
  projectRequirements: () => service.projectRequirements(),

  hubSearch: (source, kind, query) => service.hubSearch(source, kind, query),
  hubDetails: (source, kind, id) => service.hubDetails(source, kind, id),
  hubAccounts: () => service.hubAccounts(),
  hubSetAccount: (source, secret) => service.hubSetAccount(source, secret),
  hubDownload: (id, source, kind, ref) => service.hubDownload(id, source, kind, ref),
  hubJobs: (id) => service.hubJobs(id),
  hubRemove: (id, jobId) => service.hubRemove(id, jobId),

  cloudStatus: () => service.cloudStatus(),
  cloudConnect: (url, token) => service.cloudConnect(url, token),
  cloudDisconnect: () => service.cloudDisconnect(),
  cloudWallet: () => service.cloudWallet(),
  cloudLedger: (limit) => service.cloudLedger(limit),
  cloudSetLimits: (limits) => service.cloudSetLimits(limits),
  gpuOffers: () => service.gpuOffers(),
  gpuPods: () => service.gpuPods(),
  gpuLaunch: (req) => service.gpuLaunch(req),
  gpuStop: (id) => service.gpuStop(id),
  gpuStart: (id) => service.gpuStart(id),
  gpuTerminate: (id) => service.gpuTerminate(id),
  cloudModels: () => service.cloudModels(),
  localGateway: () => service.localGateway(),
  localGatewaySetKeys: (keys) => service.localGatewaySetKeys(keys),
  localGatewayStart: (credits) => service.localGatewayStart(credits),
  localGatewayStop: () => service.localGatewayStop(),
  localGatewayAddCredits: (credits) => service.localGatewayAddCredits(credits),
  agentsStatus: () => service.agentsStatus(),
  agentsConnect: (which) => service.agentsConnect(which),
  modelComplete: (model, prompt) => service.modelComplete(model, prompt),
};

/** Named third-party tokens (Hugging Face, Kaggle), one encrypted JSON file in the user-data folder. */
function secretStore(file: string) {
  const load = async (): Promise<Record<string, string>> => {
    try {
      return JSON.parse(safeStorage.decryptString(await readFile(file)));
    } catch {
      return {};
    }
  };
  return {
    get: async (key: string) => (await load())[key],
    async set(key: string, value: string | null) {
      if (!safeStorage.isEncryptionAvailable()) throw new Error("The OS keychain is unavailable, so the token can't be stored safely.");
      const all = await load();
      if (value === null) delete all[key];
      else all[key] = value;
      await writeFile(file, safeStorage.encryptString(JSON.stringify(all)));
    },
  };
}

/** Converlt Cloud credentials, encrypted with the OS keychain in the user-data folder. */
function cloudCredentials(file: string) {
  return {
    async get() {
      try {
        return JSON.parse(safeStorage.decryptString(await readFile(file))) as { url: string; token: string };
      } catch {
        return null;
      }
    },
    async set(creds: { url: string; token: string } | null) {
      if (!creds) return rm(file, { force: true });
      if (!safeStorage.isEncryptionAvailable()) throw new Error("The OS keychain is unavailable, so the token can't be stored safely.");
      await writeFile(file, safeStorage.encryptString(JSON.stringify(creds)));
    },
  };
}

ipcMain.handle(IPC.invoke, async (_e, method: InvokeMethod, args: unknown[]) => {
  const fn = handlers[method];
  if (!fn) throw new Error(`Unknown method ${method}`);
  return fn(...(Array.isArray(args) ? args : []));
});

// Built-in IDE (files, search, terminal, git, assistant). Desktop-only, so it sits on its own
// channel instead of ConvergeApi.
const projectRoot = () => {
  if (!service.project) throw new Error("No project is open");
  return service.project.path;
};
const terminals = new Terminals({
  data: (id, data) => send(IDE.termData, { id, data }),
  exit: (id, code) => send(IDE.termExit, { id, code }),
});
let agent: Agent;

const ideHandlers: Record<IdeMethod, Handler> = {
  "fs.list": (rel: string) => listDir(projectRoot(), rel),
  "fs.files": () => listFiles(projectRoot()),
  "fs.read": (rel: string) => readText(projectRoot(), rel),
  "fs.write": (rel: string, text: string) => writeText(projectRoot(), rel, text),
  "fs.search": (query: string, opts: SearchOptions) => searchFiles(projectRoot(), query, opts ?? {}),
  "terminal.create": (cols: number, rows: number) => terminals.create(service.project?.path, cols, rows),
  "terminal.write": (id: number, data: string) => terminals.write(id, data),
  "terminal.resize": (id: number, cols: number, rows: number) => terminals.resize(id, cols, rows),
  "terminal.kill": (id: number) => terminals.kill(id),
  "git.status": () => git.status(projectRoot()),
  "git.headContent": (rel: string) => git.headContent(projectRoot(), rel),
  "git.stage": (paths: string[]) => git.stage(projectRoot(), paths),
  "git.unstage": (paths: string[]) => git.unstage(projectRoot(), paths),
  "git.discard": (paths: string[]) => git.discard(projectRoot(), paths),
  "git.commit": (message: string) => git.commit(projectRoot(), message),
  "agent.getConfig": () => agent.config(),
  "agent.setConfig": (patch: { apiKey?: string | null; model?: string }) => agent.setConfig(patch),
  // Not awaited: progress streams back as events, and the renderer shouldn't hold an invoke open for minutes.
  "agent.send": (text: string, ctx: AgentContext) => void agent.send(text, ctx),
  "agent.stop": () => agent.stop(),
  "agent.reset": () => agent.reset(),
  "agent.toolResult": (callId: string, result: AgentToolResult) => agent.toolResult(callId, result),
};
ipcMain.handle(IDE.invoke, async (_e, method: IdeMethod, args: unknown[]) => {
  const fn = ideHandlers[method];
  if (!fn) throw new Error(`Unknown method ${method}`);
  return fn(...(Array.isArray(args) ? args : []));
});

// ---------------------------------------------------------------- app

// Before the lock: the lock is per user-data folder, so a custom profile runs as its own instance.
if (process.env.CONVERGE_USER_DATA) app.setPath("userData", process.env.CONVERGE_USER_DATA);
if (!app.requestSingleInstanceLock()) app.quit();
app.on("second-instance", () => {
  if (win) {
    if (win.isMinimized()) win.restore();
    win.focus();
  }
});

app.setAppUserModelId("dev.converge.desktop");

app.whenReady().then(async () => {
  appStore = new AppStore(app.getPath("userData"));
  await appStore.load();
  agent = new Agent(app.getPath("userData"), {
    event: (e) => send(IDE.agentEvent, e),
    tool: (req) => send(IDE.agentTool, req),
  });
  await agent.load();
  const secrets = secretStore(path.join(app.getPath("userData"), "secrets.bin"));
  service = new ConvergeService({
    resourcesDir,
    cloud: cloudCredentials(path.join(app.getPath("userData"), "cloud.bin")),
    secrets,
    localGateway: new LocalGateway({ executable: process.execPath, script: path.join(__dirname, "gateway", "main.mjs"), secrets }),
    mcp: { command: process.execPath, script: path.join(__dirname, "mcp", "server.mjs") },
    settings: () => appStore.data.settings,
    store: {
      load: () => ({ machines: appStore.data.machines, probes: appStore.data.probes }),
      save: async (machines, probes) => {
        appStore.data.machines = machines;
        appStore.data.probes = probes;
        await appStore.save();
      },
    },
    hooks: {
      runsChanged: (ids) => send(IPC.runsChanged, ids),
      stateChanged: () => send(IPC.stateChanged),
      launchProgress: (p) => send(IPC.launchProgress, p),
      runFinished: (name, status, message) => {
        if (!appStore.data.settings.notifications || !Notification.isSupported()) return;
        const title = status === "completed" ? `${name} completed` : status === "cancelled" ? `${name} cancelled` : `${name} failed`;
        const n = new Notification({ title, body: message.slice(0, 200), silent: status === "cancelled" });
        n.on("click", () => win?.show());
        n.show();
      },
    },
  });
  nativeTheme.themeSource = appStore.data.settings.theme;
  nativeTheme.on("updated", applyTheme);
  createWindow();
  // Converlt's tools for outside agents (Claude Code, Codex) via the Converlt MCP server.
  startBridge({
    service,
    defaultMachineId: () => null,
    approve: async (title, detail) => (await dialog.showMessageBox(win!, { type: "question", buttons: ["Allow", "Deny"], defaultId: 1, cancelId: 1, message: title, detail })).response === 0,
  }).then((stop) => app.on("will-quit", stop), (e) => console.error("agent bridge:", e));
  const last = appStore.data.lastProject;
  if (last && existsSync(last)) await openProject(last).catch(() => {});
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  // Training keeps running on the machine; the app only observes it.
  service?.dispose();
  terminals.dispose();
  agent?.stop();
  if (process.platform !== "darwin") app.quit();
});
