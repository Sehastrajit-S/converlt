import { randomBytes } from "node:crypto";
import * as vscode from "vscode";
import type { InvokeMethod } from "@converge/core";
import type { Host } from "./host.ts";
import type { HostCommand, Route, ToHost, ToWebview } from "./webview/protocol.ts";

function routeKey(r: Route): string {
  return r.view === "run" ? `run:${r.runId}` : r.view;
}

/** Editor tabs that render @converge/ui screens, talking to the host over postMessage RPC. */
export class Panels implements vscode.Disposable {
  private readonly host: Host;
  private readonly extensionUri: vscode.Uri;
  private readonly panels = new Map<string, vscode.WebviewPanel>();
  private readonly disposables: vscode.Disposable[] = [];

  constructor(host: Host, extensionUri: vscode.Uri) {
    this.host = host;
    this.extensionUri = extensionUri;
    const ev = host.events;
    this.disposables.push(
      ev.runsChanged.event((ids) => this.broadcast({ kind: "event", channel: "runsChanged", payload: ids })),
      ev.stateChanged.event(() => this.broadcast({ kind: "event", channel: "stateChanged" })),
      ev.launchProgress.event((p) => this.broadcast({ kind: "event", channel: "launchProgress", payload: p })),
      vscode.workspace.onDidChangeConfiguration((e) => e.affectsConfiguration("converge") && this.broadcast({ kind: "event", channel: "stateChanged" })),
      ev.runsChanged.event((ids) => this.retitle(ids)),
    );
  }

  open(route: Route): void {
    const key = routeKey(route);
    const existing = this.panels.get(key);
    if (existing) {
      if (route.view === "compare" || route.view === "envs" || route.view === "gpus" || (route.view === "builder" && route.importFile)) void existing.webview.postMessage({ kind: "navigate", route } satisfies ToWebview);
      existing.reveal();
      return;
    }
    const panel = vscode.window.createWebviewPanel("converge." + route.view, this.title(route), vscode.ViewColumn.Active, {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, "dist")],
    });
    panel.iconPath = vscode.Uri.joinPath(this.extensionUri, "media", "converge.svg");
    panel.webview.html = this.html(panel.webview, route);
    panel.webview.onDidReceiveMessage((msg: ToHost) => this.onMessage(panel, msg), undefined, this.disposables);
    panel.onDidDispose(() => this.panels.delete(key), undefined, this.disposables);
    this.panels.set(key, panel);
  }

  private title(route: Route): string {
    switch (route.view) {
      case "run":
        return this.host.service.getRun(route.runId)?.manifest.name ?? "Run";
      case "compare":
        return "Compare Runs";
      case "compute":
        return "Compute";
      case "dashboard":
        return "Dashboard";
      case "wallet":
        return "Wallet";
      case "gpus":
        return "GPUs";
      case "alerts":
        return "Phone Alerts";
      case "themes":
        return "Themes";
      case "builder":
        return "Model Builder";
      case "data":
        return "Data";
      case "models":
        return "Models";
      case "envs":
        return "Environments";
      case "hub":
        return "Datasets & Models";
      default:
        return "Runs";
    }
  }

  private retitle(ids: string[]): void {
    for (const id of ids) {
      const p = this.panels.get(`run:${id}`);
      const name = this.host.service.getRun(id)?.manifest.name;
      if (p && name && p.title !== name) p.title = name;
    }
  }

  private broadcast(msg: ToWebview): void {
    for (const p of this.panels.values()) void p.webview.postMessage(msg);
  }

  private async onMessage(panel: vscode.WebviewPanel, msg: ToHost): Promise<void> {
    if (msg.kind === "command") return this.onCommand(msg.command);
    if (msg.kind !== "rpc") return;
    const fn = this.host.handlers[msg.method as InvokeMethod];
    try {
      if (!fn) throw new Error(`Unknown method ${msg.method}`);
      const result = await fn(...msg.args);
      void panel.webview.postMessage({ kind: "rpc-result", id: msg.id, result } satisfies ToWebview);
    } catch (e) {
      void panel.webview.postMessage({ kind: "rpc-result", id: msg.id, error: e instanceof Error ? e.message : String(e) } satisfies ToWebview);
    }
  }

  private async onCommand(cmd: HostCommand): Promise<void> {
    switch (cmd.name) {
      case "openRun":
        return this.open({ view: "run", runId: cmd.runId });
      case "openCompare":
        return this.open({ view: "compare", runIds: cmd.runIds });
      case "openRuns":
        return this.open({ view: "runs" });
      case "openCompute":
        return this.open({ view: "compute" });
      case "openHome":
        return this.open({ view: "dashboard" });
      case "showCode":
        await vscode.commands.executeCommand("converlt.showCode").then(undefined, () => {});
        return;
      case "openProject":
        await this.host.handlers.openProject(cmd.path);
        return;
      case "openWallet":
        return this.open({ view: "wallet" });
      case "openGpus":
        return this.open({ view: "gpus", preselect: cmd.preselect ?? null });
      case "openAlerts":
        return this.open({ view: "alerts" });
      case "openBuilder":
        return this.open({ view: "builder" });
      case "openData":
        return this.open({ view: "data" });
      case "openModels":
        return this.open({ view: "models" });
      case "openEnvironments":
        return this.open({ view: "envs", machineId: cmd.machineId ?? null });
      case "openHub":
        return this.open({ view: "hub", machineId: cmd.machineId ?? null });
      case "newRun":
        await vscode.commands.executeCommand("converge.runTraining", cmd.machineId ?? undefined);
        return;
      case "openSettings":
        await vscode.commands.executeCommand("workbench.action.openSettings", "@ext:converge.converge");
        return;
    }
  }

  private html(webview: vscode.Webview, route: Route): string {
    const nonce = randomBytes(16).toString("base64");
    const asset = (f: string) => webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, "dist", f));
    const csp = [
      "default-src 'none'",
      `img-src ${webview.cspSource} data:`,
      `style-src ${webview.cspSource} 'unsafe-inline'`,
      `font-src ${webview.cspSource}`,
      `script-src 'nonce-${nonce}'`,
    ].join("; ");
    const init = JSON.stringify(route).replace(/</g, "\\u003c");
    return `<!doctype html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta http-equiv="Content-Security-Policy" content="${csp}" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<link rel="stylesheet" href="${asset("webview.css")}" />
</head>
<body>
<div id="root"></div>
<script nonce="${nonce}" id="converge-route" type="application/json">${init}</script>
<script nonce="${nonce}" src="${asset("webview.js")}"></script>
</body>
</html>`;
  }

  dispose(): void {
    for (const p of this.panels.values()) p.dispose();
    for (const d of this.disposables) d.dispose();
  }
}
