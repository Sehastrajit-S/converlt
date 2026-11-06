import * as vscode from "vscode";
import { isTerminal, type Machine, type RunStatus } from "@converge/run-protocol";
import type { CloudPodView, CloudStatus, RunListItem, WalletSummary } from "@converge/core";
import { formatDuration, formatNumber, formatUsd } from "@converge/ui/format";
import type { Host } from "./host.ts";

const STATUS_ICON: Record<RunStatus, [string, string | undefined]> = {
  created: ["circle-outline", undefined],
  preparing: ["loading~spin", "charts.yellow"],
  running: ["sync~spin", "charts.blue"],
  cancelling: ["loading~spin", "charts.yellow"],
  completed: ["pass-filled", "testing.iconPassed"],
  failed: ["error", "testing.iconFailed"],
  cancelled: ["circle-slash", "disabledForeground"],
  unknown: ["debug-disconnect", "charts.yellow"],
};

export class RunItem extends vscode.TreeItem {
  readonly run: RunListItem;

  constructor(run: RunListItem) {
    super(run.name, vscode.TreeItemCollapsibleState.None);
    this.run = run;
    const [icon, color] = STATUS_ICON[run.status];
    this.iconPath = new vscode.ThemeIcon(icon, color ? new vscode.ThemeColor(color) : undefined);
    const metric = run.primaryMetric ? `${run.primaryMetric.key.split("/").pop()} ${run.primaryMetric.last === null ? "NaN" : formatNumber(run.primaryMetric.last)}` : "";
    const flags = [run.diagnosticKinds.includes("nan") && "NaN", run.diagnosticKinds.includes("oom") && "OOM"].filter(Boolean).join(" ");
    this.description = [flags, metric, run.durationSec !== null ? formatDuration(run.durationSec) : "", run.group].filter(Boolean).join(" · ");
    this.contextValue = isTerminal(run.status) ? `run.done.${run.status}` : `run.active.${run.status}`;
    this.command = { command: "converge.openRun", title: "Open Run", arguments: [run.runId] };
    const md = new vscode.MarkdownString(undefined, true);
    md.appendMarkdown(`**${run.name}** · ${run.status}\n\n`);
    md.appendCodeblock(run.command, "shell");
    md.appendMarkdown(`\n${run.gpuName ?? run.machineName}`);
    if (run.gitCommit) md.appendMarkdown(` · \`${run.gitCommit.slice(0, 8)}${run.dirty ? "*" : ""}\``);
    if (run.costUsd !== null) md.appendMarkdown(` · ${formatUsd(run.costUsd)} est.`);
    this.tooltip = md;
  }
}

export class RunsTree implements vscode.TreeDataProvider<RunItem> {
  private readonly host: Host;
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.changed.event;

  constructor(host: Host) {
    this.host = host;
  }

  refresh(): void {
    this.changed.fire();
  }

  getTreeItem(item: RunItem): vscode.TreeItem {
    return item;
  }

  getChildren(): RunItem[] {
    return this.host.service.listRuns().map((r) => new RunItem(r));
  }
}

export class MachineItem extends vscode.TreeItem {
  readonly machine: Machine;

  constructor(machine: Machine, host: Host) {
    super(machine.name, vscode.TreeItemCollapsibleState.None);
    this.machine = machine;
    const probe = host.service.listProbes()[machine.id];
    const gpu = probe?.gpus?.[0];
    const [icon, color] = !probe ? ["vm-outline", undefined] : !probe.ok ? ["vm-outline", "testing.iconFailed"] : probe.ready ? ["vm-active", "testing.iconPassed"] : ["vm", "charts.yellow"];
    this.iconPath = new vscode.ThemeIcon(icon, color ? new vscode.ThemeColor(color) : undefined);
    this.description = gpu ? `${probe!.gpus!.length > 1 ? `${probe!.gpus!.length}× ` : ""}${gpu.name.replace(/^NVIDIA (GeForce )?/, "")}` : !probe ? "not tested" : probe.ok ? "no GPU" : "unreachable";
    this.tooltip = new vscode.MarkdownString(
      `**${machine.name}** \`${machine.host}\`\n\n` +
        (probe?.ok
          ? (probe.checks ?? []).map((c) => `${c.ok ? "$(pass)" : "$(error)"} ${c.name}: ${c.detail}`).join("\n\n")
          : probe?.error ?? "Not tested yet"),
      true,
    );
    this.contextValue = "machine";
    this.command = { command: "converge.openCompute", title: "Open Compute" };
  }
}

export class ComputeTree implements vscode.TreeDataProvider<MachineItem> {
  private readonly host: Host;
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.changed.event;

  constructor(host: Host) {
    this.host = host;
  }

  refresh(): void {
    this.changed.fire();
  }

  getTreeItem(item: MachineItem): vscode.TreeItem {
    return item;
  }

  getChildren(): MachineItem[] {
    return this.host.service.listMachines().map((m) => new MachineItem(m, this.host));
  }
}

// ---------------------------------------------------------------- cloud

export interface CloudSnapshot {
  status: CloudStatus | null;
  wallet: WalletSummary | null;
  pods: CloudPodView[];
}

const POD_ICON: Record<string, [string, string | undefined]> = {
  starting: ["loading~spin", "charts.blue"],
  running: ["vm-running", "testing.iconPassed"],
  stopped: ["debug-stop", "disabledForeground"],
  error: ["error", "testing.iconFailed"],
  terminated: ["trash", "disabledForeground"],
};

const credits = (n: number) => n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });

class CloudItem extends vscode.TreeItem {
  readonly children: CloudItem[];

  constructor(label: string, opts: { icon: string; color?: string; description?: string; tooltip?: string; command?: vscode.Command; children?: CloudItem[]; contextValue?: string }) {
    super(label, opts.children?.length ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.None);
    this.iconPath = new vscode.ThemeIcon(opts.icon, opts.color ? new vscode.ThemeColor(opts.color) : undefined);
    this.description = opts.description;
    this.tooltip = opts.tooltip;
    this.command = opts.command;
    this.children = opts.children ?? [];
    this.contextValue = opts.contextValue;
  }
}

/** Converlt Cloud at a glance: balance, pods, and shortcuts to the cloud screens. */
export class CloudTree implements vscode.TreeDataProvider<CloudItem> {
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.changed.event;
  snapshot: CloudSnapshot = { status: null, wallet: null, pods: [] };

  update(s: CloudSnapshot): void {
    this.snapshot = s;
    this.changed.fire();
  }

  getTreeItem(item: CloudItem): vscode.TreeItem {
    return item;
  }

  getChildren(item?: CloudItem): CloudItem[] {
    if (item) return item.children;
    const { status, wallet, pods } = this.snapshot;
    const open = (command: string, title: string, args?: unknown[]): vscode.Command => ({ command, title, arguments: args });
    const home = new CloudItem("Dashboard", { icon: "dashboard", command: open("converge.dashboard", "Show Dashboard") });
    if (!status?.connected)
      return [
        home,
        new CloudItem("Sign in to Converlt Cloud", {
          icon: "sign-in",
          description: status?.error ? "token rejected" : undefined,
          tooltip: status?.error ?? "One credit balance for on-demand GPUs and AI models",
          command: open("converge.cloudSignIn", "Sign in"),
        }),
        new CloudItem("Environments", { icon: "package", command: open("converge.openEnvironments", "Open Environments") }),
        new CloudItem("Datasets & Models", { icon: "database", command: open("converge.openHub", "Open Datasets & Models") }),
        new CloudItem("Data", { icon: "table", description: "load · explore · preprocess", command: open("converge.openData", "Open Data") }),
        new CloudItem("Model Builder", { icon: "type-hierarchy", description: "drag and drop", command: open("converge.openModelBuilder", "Open Model Builder") }),
        new CloudItem("Themes", { icon: "symbol-color", description: "look and feel", command: open("converge.openThemes", "Choose Theme") }),
      ];
    const live = pods.filter((p) => p.status !== "terminated");
    const podItems = live.map(
      (p) =>
        new CloudItem(p.name, {
          icon: POD_ICON[p.status]?.[0] ?? "vm",
          color: POD_ICON[p.status]?.[1],
          description: `${p.gpuCount > 1 ? `${p.gpuCount}× ` : ""}${p.gpuName} · ${credits(p.status === "stopped" ? p.storagePerHour : p.pricePerHour)}/hr`,
          tooltip: `${p.status}${p.statusReason ? ` · ${p.statusReason}` : ""}\nSpent ${credits(p.spent)} credits`,
          command: open("converge.openGpus", "Open GPUs"),
          contextValue: p.machineId && p.status === "running" ? "pod.ready" : "pod",
        }),
    );
    return [
      home,
      new CloudItem(wallet ? `${credits(wallet.balance)} credits` : "Wallet", {
        icon: "credit-card",
        color: wallet && wallet.balance <= 0 ? "testing.iconFailed" : undefined,
        description: wallet?.burnPerHour ? `${credits(wallet.burnPerHour)}/hr` : undefined,
        tooltip: wallet ? `${status.user?.email}\nThis month: GPUs ${credits(wallet.spend.gpu.month)} · models ${credits(wallet.spend.models.month)}` : undefined,
        command: open("converge.openWallet", "Open Wallet"),
      }),
      new CloudItem("GPUs", {
        icon: "server-environment",
        description: live.length ? `${live.filter((p) => p.status === "running").length} running` : "launch one",
        command: open("converge.openGpus", "Open GPUs"),
        children: podItems,
      }),
      new CloudItem("Models", { icon: "sparkle", description: "OpenRouter", command: open("converge.openModels", "Open Models") }),
      new CloudItem("Environments", { icon: "package", command: open("converge.openEnvironments", "Open Environments") }),
      new CloudItem("Datasets & Models", { icon: "database", description: "Hugging Face · Kaggle", command: open("converge.openHub", "Open Datasets & Models") }),
      new CloudItem("Data", { icon: "table", description: "load · explore · preprocess", command: open("converge.openData", "Open Data") }),
      new CloudItem("Model Builder", { icon: "type-hierarchy", description: "drag and drop", command: open("converge.openModelBuilder", "Open Model Builder") }),
    ];
  }
}
