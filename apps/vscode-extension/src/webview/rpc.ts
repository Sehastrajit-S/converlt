import type { ConvergeApi, InvokeMethod } from "@converge/core/api";
import type { HostCommand, Route, ToHost, ToWebview } from "./protocol.ts";

interface VsCodeApi {
  postMessage(msg: ToHost): void;
}
declare function acquireVsCodeApi(): VsCodeApi;

const vscode = acquireVsCodeApi();
let nextId = 1;
const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
const listeners: Record<string, Set<(payload: any) => void>> = {
  runsChanged: new Set(),
  stateChanged: new Set(),
  launchProgress: new Set(),
  navigate: new Set(),
};

window.addEventListener("message", (e: MessageEvent<ToWebview>) => {
  const msg = e.data;
  if (msg.kind === "rpc-result") {
    const p = pending.get(msg.id);
    if (!p) return;
    pending.delete(msg.id);
    if (msg.error !== undefined) p.reject(new Error(msg.error));
    else p.resolve(msg.result);
  } else if (msg.kind === "event") {
    for (const cb of listeners[msg.channel]!) cb(msg.payload);
  } else if (msg.kind === "navigate") {
    for (const cb of listeners.navigate!) cb(msg.route);
  }
});

function call(method: InvokeMethod, args: unknown[]): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject });
    vscode.postMessage({ kind: "rpc", id, method, args });
  });
}

function on(channel: string, cb: (payload: any) => void): () => void {
  listeners[channel]!.add(cb);
  return () => listeners[channel]!.delete(cb);
}

/** ConvergeApi over postMessage; method calls go to the extension host's handlers. */
export const rpcApi = new Proxy({} as ConvergeApi, {
  get(_t, prop: string) {
    if (prop === "onRunsChanged") return (cb: (ids: string[]) => void) => on("runsChanged", cb);
    if (prop === "onStateChanged") return (cb: () => void) => on("stateChanged", cb);
    if (prop === "onLaunchProgress") return (cb: (p: unknown) => void) => on("launchProgress", cb);
    return (...args: unknown[]) => call(prop as InvokeMethod, args);
  },
});

export function hostCommand(command: HostCommand): void {
  vscode.postMessage({ kind: "command", command });
}

export function onNavigate(cb: (route: Route) => void): () => void {
  return on("navigate", cb);
}
