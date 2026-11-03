// Messages between webview panels and the extension host.

export type Route =
  | { view: "dashboard" }
  | { view: "runs" }
  | { view: "run"; runId: string }
  | { view: "compare"; runIds: string[] }
  | { view: "compute" }
  | { view: "wallet" }
  | { view: "gpus" }
  | { view: "models" }
  | { view: "envs"; machineId?: string | null }
  | { view: "hub"; machineId?: string | null };

export type HostCommand =
  | { name: "openRun"; runId: string }
  | { name: "openCompare"; runIds: string[] }
  | { name: "openRuns" }
  | { name: "openCompute" }
  | { name: "openHome" }
  | { name: "showCode" }
  | { name: "openProject"; path: string }
  | { name: "openWallet" }
  | { name: "openGpus" }
  | { name: "openModels" }
  | { name: "openEnvironments"; machineId?: string | null }
  | { name: "openHub"; machineId?: string | null }
  | { name: "newRun"; machineId?: string | null }
  | { name: "openSettings" };

export type ToHost =
  | { kind: "rpc"; id: number; method: string; args: unknown[] }
  | { kind: "command"; command: HostCommand };

export type ToWebview =
  | { kind: "rpc-result"; id: number; result?: unknown; error?: string }
  | { kind: "event"; channel: "runsChanged" | "stateChanged" | "launchProgress"; payload?: unknown }
  | { kind: "navigate"; route: Route };
