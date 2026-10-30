import { contextBridge, ipcRenderer } from "electron";
import { IPC, type ConvergeApi, type InvokeMethod } from "@converge/core/api";
import { IDE, IDE_METHODS, type AgentEvent, type AgentToolRequest, type IdeApi } from "../shared/ide.ts";

const invoke =
  (method: InvokeMethod) =>
  (...args: unknown[]) =>
    ipcRenderer.invoke(IPC.invoke, method, args);

function subscribe<T>(channel: string, cb: (payload: T) => void): () => void {
  const listener = (_e: unknown, payload: T) => cb(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

const methods: InvokeMethod[] = [
  "getState",
  "openProjectDialog",
  "openProject",
  "closeProject",
  "openInEditor",
  "revealPath",
  "addMachine",
  "updateMachine",
  "removeMachine",
  "probeMachine",
  "machineTelemetry",
  "listRuns",
  "getRun",
  "planSync",
  "launchRun",
  "cancelRun",
  "reconnectRun",
  "saveNotes",
  "planReproduce",
  "openPatch",
  "gitDiff",
  "updateSettings",
  "listEnvs",
  "createEnv",
  "installPackages",
  "envPackages",
  "removeEnv",
  "useEnv",
  "projectRequirements",
  "hubSearch",
  "hubDetails",
  "hubAccounts",
  "hubSetAccount",
  "hubDownload",
  "hubJobs",
  "hubRemove",
  "cloudStatus",
  "cloudConnect",
  "cloudDisconnect",
  "cloudWallet",
  "cloudLedger",
  "cloudSetLimits",
  "gpuOffers",
  "gpuPods",
  "gpuLaunch",
  "gpuStop",
  "gpuStart",
  "gpuTerminate",
  "cloudModels",
  "localGateway",
  "localGatewaySetKeys",
  "localGatewayStart",
  "localGatewayStop",
  "localGatewayAddCredits",
  "agentsStatus",
  "agentsConnect",
  "modelComplete",
];

const api = Object.fromEntries(methods.map((m) => [m, invoke(m)])) as unknown as ConvergeApi;
api.onRunsChanged = (cb) => subscribe(IPC.runsChanged, cb);
api.onStateChanged = (cb) => subscribe(IPC.stateChanged, cb);
api.onLaunchProgress = (cb) => subscribe(IPC.launchProgress, cb);

contextBridge.exposeInMainWorld("converge", api);

// Built-in IDE: "group.method" invoke methods become ide.group.method(...).
const ide: Record<string, Record<string, unknown>> = {};
for (const m of IDE_METHODS) {
  const [group, name] = m.split(".");
  (ide[group] ??= {})[name] = (...args: unknown[]) => ipcRenderer.invoke(IDE.invoke, m, args);
}
ide.terminal.onData = (cb: (id: number, data: string) => void) => subscribe<{ id: number; data: string }>(IDE.termData, (p) => cb(p.id, p.data));
ide.terminal.onExit = (cb: (id: number, code: number) => void) => subscribe<{ id: number; code: number }>(IDE.termExit, (p) => cb(p.id, p.code));
ide.agent.onEvent = (cb: (e: AgentEvent) => void) => subscribe(IDE.agentEvent, cb);
ide.agent.onToolRequest = (cb: (r: AgentToolRequest) => void) => subscribe(IDE.agentTool, cb);
contextBridge.exposeInMainWorld("convergeIde", ide as unknown as IdeApi);
