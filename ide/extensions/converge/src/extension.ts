import path from "node:path";
import * as vscode from "vscode";
import { isTerminal, type Machine } from "@converge/run-protocol";
import { projectSlug, type CloudPodView, type CloudStatus, type RunListItem, type WalletSummary } from "@converge/core";
import { formatDuration, formatMiB, formatNumber } from "@converge/ui/format";
import { Host, readSettings, requireTrust } from "./host.ts";
import { locateDiagnostic } from "./locations.ts";
import { Panels } from "./panels.ts";
import { CloudTree, ComputeTree, MachineItem, RunItem, RunsTree } from "./views.ts";
import { registerAssistant } from "./chat/assistant.ts";
import { startBridge } from "@converge/core";
import { ConverltModels } from "./chat/models.ts";

/** The machine runs launch on by default; shown in the title bar. */
const DEFAULT_MACHINE_KEY = "converge.defaultMachine";
/** Set before opening a project from the dashboard, so the new window lands in Code mode. */
const OPEN_IN_CODE_KEY = "converge.openInCode";

let host: Host | undefined;

export async function activate(ctx: vscode.ExtensionContext): Promise<void> {
  host = new Host(ctx);
  const h = host;
  const panels = new Panels(h, ctx.extensionUri);
  const runsTree = new RunsTree(h);
  const computeTree = new ComputeTree(h);
  const runsView = vscode.window.createTreeView("converge.runs", { treeDataProvider: runsTree, canSelectMany: true });
  const computeView = vscode.window.createTreeView("converge.compute", { treeDataProvider: computeTree });
  const cloudTree = new CloudTree();
  const cloudView = vscode.window.createTreeView("converge.cloud", { treeDataProvider: cloudTree });
  const creditsItem = vscode.window.createStatusBarItem("converge.credits", vscode.StatusBarAlignment.Right, 100);
  creditsItem.name = "Converlt Credits";
  const problems = vscode.languages.createDiagnosticCollection("converge");
  const status = vscode.window.createStatusBarItem("converge.activeRun", vscode.StatusBarAlignment.Left, 50);
  status.name = "Converlt Run";
  const codeLens = new RunCodeLens(h);

  ctx.subscriptions.push(h, panels, runsView, computeView, cloudView, creditsItem, problems, status);
  ctx.subscriptions.push(vscode.languages.registerCodeLensProvider({ language: "python", scheme: "file" }, codeLens));

  // Converlt Cloud models in the chat model picker, and the Converlt assistant as the default chat.
  const models = new ConverltModels(h);
  ctx.subscriptions.push(vscode.lm.registerLanguageModelChatProvider("converlt", models));
  registerAssistant(ctx, h, () => defaultMachineId);

  // ------------------------------------------------------------ live updates

  const refreshRuns = throttle(() => {
    runsTree.refresh();
    codeLens.refresh();
    updateStatus(status, h.service.listRuns());
    const live = h.service.listRuns().filter((r) => !isTerminal(r.status)).length;
    runsView.badge = live ? { value: live, tooltip: `${live} active run${live === 1 ? "" : "s"}` } : undefined;
  }, 300);
  ctx.subscriptions.push(
    h.events.runsChanged.event(refreshRuns),
    h.events.stateChanged.event(() => {
      computeTree.refresh();
      refreshRuns();
      pushTitleState(wasConnected, lastWallet);
    }),
    h.events.runFinished.event(({ name, status: st, message, runId }) => {
      if (runId) updateProblems(h, problems, runId);
      if (!readSettings().notifications) return;
      const show = st === "completed" ? vscode.window.showInformationMessage : st === "cancelled" ? vscode.window.showInformationMessage : vscode.window.showErrorMessage;
      const actions = runId ? ["Open Run"] : [];
      void show(`Converlt: ${name} ${st}. ${message}`, ...actions).then((a) => a === "Open Run" && runId && panels.open({ view: "run", runId }));
    }),
    vscode.workspace.onDidChangeWorkspaceFolders(() => void h.openWorkspace().then(refreshRuns)),
    vscode.workspace.onDidChangeConfiguration((e) => e.affectsConfiguration("converge.codeLens") && codeLens.refresh()),
  );
  // Converlt Cloud: balance in the status bar, pods in the side bar. Pod refreshes also keep
  // the machines that point at pods in sync with their SSH endpoints.
  let cloudBusy = false;
  const refreshCloud = async () => {
    if (cloudBusy) return;
    cloudBusy = true;
    try {
      const st = await h.service.cloudStatus();
      const [wallet, pods] = st.connected ? await Promise.all([h.service.cloudWallet().catch(() => null), h.service.gpuPods().catch(() => [])]) : [null, []];
      cloudTree.update({ status: st, wallet, pods });
      const live = pods.filter((p) => p.status === "running" || p.status === "starting").length;
      cloudView.badge = live ? { value: live, tooltip: `${live} GPU pod${live === 1 ? "" : "s"} running` } : undefined;
      if (wallet) {
        creditsItem.text = `$(credit-card) ${wallet.balance.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
        creditsItem.tooltip = `Converlt credits${wallet.burnPerHour ? ` · spending ${wallet.burnPerHour.toFixed(2)}/hr` : ""}
Click to open your wallet`;
        creditsItem.backgroundColor = wallet.balance <= 0 ? new vscode.ThemeColor("statusBarItem.errorBackground") : wallet.burnPerHour && wallet.balance / wallet.burnPerHour < 1 ? new vscode.ThemeColor("statusBarItem.warningBackground") : undefined;
        creditsItem.command = "converge.openWallet";
      } else {
        creditsItem.text = "$(cloud) Converlt Cloud";
        creditsItem.tooltip = st.error ?? "Sign in for on-demand GPUs and AI models";
        creditsItem.backgroundColor = undefined;
        creditsItem.command = st.connected ? "converge.openWallet" : "converge.cloudSignIn";
      }
      creditsItem.show();
      if (st.connected !== wasConnected) models.refresh();
      wasConnected = st.connected;
      lastPods = pods;
      pushTitleState(st.connected, wallet);
    } finally {
      cloudBusy = false;
    }
  };
  let wasConnected = false;
  let lastPods: CloudPodView[] = [];
  let lastWallet: WalletSummary | null = null;

  /** The title bar's compute target: the chosen machine, else a running pod, else a ready machine. */
  const targetMachine = () => {
    const machines = h.service.listMachines();
    const probes = h.service.listProbes();
    const chosen = machines.find((m) => m.id === ctx.globalState.get<string>(DEFAULT_MACHINE_KEY));
    return chosen ?? machines.find((m) => m.cloudPodId && lastPods.some((p) => p.id === m.cloudPodId && p.status === "running")) ?? machines.find((m) => probes[m.id]?.ready) ?? machines[0];
  };
  const pushTitleState = (connected: boolean, wallet: WalletSummary | null) => {
    lastWallet = wallet;
    const m = targetMachine();
    const probe = m ? h.service.listProbes()[m.id] : undefined;
    const pod = m?.cloudPodId ? lastPods.find((p) => p.id === m.cloudPodId) : undefined;
    const gpu = probe?.gpus?.[0]?.name.replace(/^NVIDIA (GeForce )?/, "");
    const status = pod
      ? pod.status === "running"
        ? probe?.ok
          ? "running"
          : "starting"
        : pod.status === "starting"
          ? "starting"
          : "stopped"
      : !m || !probe
        ? "none"
        : !probe.ok
          ? "unreachable"
          : "ready";
    const state = {
      connected,
      balance: wallet?.balance ?? null,
      burnPerHour: wallet?.burnPerHour ?? 0,
      target: m ? { label: m.name.split(" · ")[0]!, detail: gpu ?? pod?.gpuName, status } : null,
      tooltip: wallet ? `${wallet.balance.toFixed(2)} credits${wallet.burnPerHour ? `, spending ${wallet.burnPerHour.toFixed(2)}/hr` : ""}. Click for your wallet.` : connected ? undefined : "Sign in to Converlt Cloud",
    };
    // The title bar control only exists in the Converlt IDE; stock VS Code has no such command.
    void vscode.commands.executeCommand("converlt.titleBar.setState", state).then(undefined, () => {});
  };
  const cloudTick = setInterval(() => void refreshCloud(), 20_000);
  ctx.subscriptions.push({ dispose: () => clearInterval(cloudTick) }, h.events.stateChanged.event(() => void refreshCloud()));

  // Refresh durations/costs in the tree and status bar while runs are live.
  const tick = setInterval(() => h.service.listRuns().some((r) => r.status === "running") && refreshRuns(), 5000);
  ctx.subscriptions.push({ dispose: () => clearInterval(tick) });

  // ------------------------------------------------------------ commands

  const runIdsFrom = (item?: RunItem | string, selected?: readonly RunItem[]): string[] => {
    if (selected?.length) return selected.map((s) => s.run.runId);
    if (typeof item === "string") return [item];
    if (item) return [item.run.runId];
    return runsView.selection.map((s) => s.run.runId);
  };
  const reg = (id: string, fn: (...args: any[]) => unknown) =>
    ctx.subscriptions.push(
      vscode.commands.registerCommand(id, async (...args) => {
        try {
          await fn(...args);
        } catch (e) {
          void vscode.window.showErrorMessage(`Converlt: ${e instanceof Error ? e.message : String(e)}`);
        }
      }),
    );

  reg("converge.runTraining", (machineId?: unknown) => launchFlow(h, panels, undefined, typeof machineId === "string" ? { machineId } : {}));
  reg("converge.runFile", (uri?: vscode.Uri) => {
    const target = uri ?? vscode.window.activeTextEditor?.document.uri;
    return launchFlow(h, panels, target);
  });
  reg("converge.openRuns", () => panels.open({ view: "runs" }));
  reg("converge.openRun", (item?: RunItem | string) => {
    const [runId] = runIdsFrom(item);
    if (runId) panels.open({ view: "run", runId });
  });
  reg("converge.compareRuns", (item?: RunItem, selected?: readonly RunItem[]) => panels.open({ view: "compare", runIds: runIdsFrom(item, selected) }));
  reg("converge.cancelRun", async (item?: RunItem | string) => {
    const [runId] = runIdsFrom(item);
    if (!runId) return;
    const name = h.service.getRun(runId)?.manifest.name ?? runId;
    const ok = await vscode.window.showWarningMessage(`Stop ${name}? The training process gets SIGTERM, then SIGKILL after the grace period.`, { modal: true }, "Stop Run");
    if (ok) await h.service.cancelRun(runId);
  });
  reg("converge.reproduceRun", async (item?: RunItem | string) => {
    const [runId] = runIdsFrom(item);
    if (!runId) return;
    const plan = await h.service.planReproduce(runId);
    const pick = await vscode.window.showWarningMessage(
      `Reproduce ${h.service.getRun(runId)?.manifest.name}?`,
      { modal: true, detail: plan.warnings.map((w) => `• ${w}`).join("\n") },
      "Reproduce",
    );
    if (pick) await launchFlow(h, panels, undefined, { command: plan.command, machineId: plan.machineId, options: plan.options, reproducedFrom: runId });
  });
  reg("converge.reconnectRun", (item?: RunItem | string) => {
    const [runId] = runIdsFrom(item);
    if (runId) h.service.reconnectRun(runId);
  });
  reg("converge.openCompute", () => panels.open({ view: "compute" }));
  reg("converge.addMachine", () => addMachineFlow(h));
  reg("converge.testMachine", async (item?: MachineItem) => {
    const m = item?.machine ?? (await pickMachine(h, "Test which machine?"));
    if (m) await testMachine(h, m);
  });
  reg("converge.removeMachine", async (item?: MachineItem) => {
    const m = item?.machine ?? (await pickMachine(h, "Remove which machine?"));
    if (!m) return;
    const ok = await vscode.window.showWarningMessage(`Remove ${m.name}? Runs that used it keep their history.`, { modal: true }, "Remove");
    if (ok) await h.service.removeMachine(m.id);
  });
  reg("converge.refresh", () => {
    refreshRuns();
    void refreshCloud();
  });
  reg("converge.openHome", () => panels.open({ view: "dashboard" }));
  reg("converge.openDashboard", () => panels.open({ view: "dashboard" }));
  reg("converge.connectAgents", async () => {
    const pick = await vscode.window.showQuickPick(
      [
        { label: "Claude Code", picked: true, id: "claudeCode" as const },
        { label: "Codex", picked: true, id: "codex" as const },
      ],
      { canPickMany: true, title: "Give these agents Converlt's tools (runs, machines, datasets, launching with your approval)" },
    );
    if (!pick?.length) return;
    const st = await h.service.agentsConnect({ claudeCode: pick.some((p) => p.id === "claudeCode"), codex: pick.some((p) => p.id === "codex") });
    void vscode.window.showInformationMessage(`Converlt tools added for ${[st.claudeCode && "Claude Code", st.codex && "Codex"].filter(Boolean).join(" and ")}. Start a new agent session to use them.`);
  });
  // Full-window dashboard in the Converlt IDE; a dashboard tab elsewhere.
  reg("converge.dashboard", () => vscode.commands.executeCommand("converlt.showDashboard").then(undefined, () => panels.open({ view: "dashboard" })));
  reg("converge.computeMenu", () => computeMenu(h, ctx, panels, () => lastPods, () => pushTitleState(wasConnected, lastWallet)));
  reg("converge.openWallet", () => panels.open({ view: "wallet" }));
  reg("converge.openGpus", () => panels.open({ view: "gpus" }));
  reg("converge.openModels", () => panels.open({ view: "models" }));
  reg("converge.openHub", (machineId?: unknown) => panels.open({ view: "hub", machineId: typeof machineId === "string" ? machineId : null }));
  reg("converge.openEnvironments", (machineId?: unknown) => panels.open({ view: "envs", machineId: typeof machineId === "string" ? machineId : null }));
  reg("converge.cloudSignIn", async () => {
    const how = await vscode.window.showQuickPick(
      [
        { id: "browser", label: "$(github) Sign in with GitHub or Google", detail: "Opens your browser. New to Converlt? This creates your account." },
        { id: "token", label: "$(key) Use another gateway or a token", detail: "Self-hosted gateways, or a token from your Converlt administrator." },
      ],
      { title: "Converlt: sign in" },
    );
    if (!how) return;
    let st: CloudStatus;
    if (how.id === "browser") {
      st = await browserSignIn(h);
    } else {
      const current = await h.service.cloudStatus();
      const url = await vscode.window.showInputBox({ title: "Converlt Cloud: gateway URL", value: current.url && !/127\.0\.0\.1/.test(current.url) ? current.url : "https://", ignoreFocusOut: true });
      if (!url) return;
      const token = await vscode.window.showInputBox({ title: "Converlt Cloud: your token", prompt: "Starts with cvt_. Leave empty to sign in to this gateway in the browser instead.", password: true, ignoreFocusOut: true });
      if (token === undefined) return;
      st = token ? await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: "Converlt: signing in…" }, () => h.service.cloudConnect(url, token)) : await browserSignIn(h, url);
    }
    if (!st.connected) return;
    void vscode.window.showInformationMessage(`Converlt: signed in as ${st.user?.email}.`);
    panels.open({ view: "wallet" });
  });
  reg("converge.cloudSignOut", async () => {
    const ok = await vscode.window.showWarningMessage("Sign out of Converlt Cloud? Running pods keep running and billing.", { modal: true }, "Sign out");
    if (ok) await h.service.cloudDisconnect();
  });
  reg("converge.openSettings", () => vscode.commands.executeCommand("workbench.action.openSettings", "@ext:converge.converge"));

  await h.openWorkspace().catch((e) => void vscode.window.showErrorMessage(`Converlt: ${e instanceof Error ? e.message : e}`));
  refreshRuns();
  void refreshCloud();
  defaultMachineId = ctx.globalState.get<string>(DEFAULT_MACHINE_KEY) ?? null;

  // Converlt's tools for outside agents (Claude Code, Codex) via the Converlt MCP server.
  try {
    const stop = await startBridge({
      service: h.service,
      defaultMachineId: () => defaultMachineId,
      approve: async (title, detail) => (await vscode.window.showWarningMessage(title, { modal: true, detail }, "Allow")) === "Allow",
    });
    ctx.subscriptions.push({ dispose: stop });
  } catch (e) {
    console.error("Converlt agent bridge failed to start:", e);
  }
  // A project opened from the dashboard lands in the code editor.
  if (ctx.globalState.get<boolean>(OPEN_IN_CODE_KEY)) {
    await ctx.globalState.update(OPEN_IN_CODE_KEY, undefined);
    void vscode.commands.executeCommand("converlt.showCode").then(undefined, () => {});
  }
  h.openProjectHook = async (p: string) => {
    await ctx.globalState.update(OPEN_IN_CODE_KEY, true);
    await vscode.commands.executeCommand("vscode.openFolder", vscode.Uri.file(p));
  };
}

let defaultMachineId: string | null = null;

/** The title bar's compute menu: pick the default machine, manage pods, launch a GPU. */
/** Browser sign-in: opens the gateway's login page and waits, showing the code to check there. */
async function browserSignIn(h: Host, url?: string): Promise<CloudStatus> {
  const { code } = await h.service.cloudSignInStart(url);
  return vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: `Converlt: approve the sign-in in your browser. Check it shows ${code}`, cancellable: true },
    async (_p, cancel) => {
      cancel.onCancellationRequested(() => void h.service.cloudSignInCancel());
      try {
        return await h.service.cloudSignInWait();
      } catch (e) {
        if (cancel.isCancellationRequested) return { connected: false, url: null, user: null, error: null };
        throw e;
      }
    },
  );
}

async function computeMenu(h: Host, ctx: vscode.ExtensionContext, panels: Panels, pods: () => CloudPodView[], changed: () => void): Promise<void> {
  type Item = vscode.QuickPickItem & { run?: () => unknown };
  const machines = h.service.listMachines();
  const probes = h.service.listProbes();
  const current = ctx.globalState.get<string>(DEFAULT_MACHINE_KEY);
  const items: Item[] = [{ label: "Run on", kind: vscode.QuickPickItemKind.Separator }];
  for (const m of machines) {
    const p = probes[m.id];
    const pod = m.cloudPodId ? pods().find((x) => x.id === m.cloudPodId) : undefined;
    const gpu = p?.gpus?.length ? `${p.gpus.length > 1 ? `${p.gpus.length}× ` : ""}${p.gpus[0]!.name}` : pod?.gpuName;
    items.push({
      label: `${m.id === current ? "$(check)" : "$(blank)"} ${m.cloudPodId ? "$(cloud)" : "$(vm)"} ${m.name.split(" · ")[0]}`,
      description: [gpu, pod ? `${pod.pricePerHour.toFixed(2)} credits/hr` : m.host].filter(Boolean).join(" · "),
      detail: !p ? "not tested yet" : !p.ok ? `unreachable: ${p.error}` : p.ready ? "ready" : "needs attention",
      run: async () => {
        await ctx.globalState.update(DEFAULT_MACHINE_KEY, m.id);
        defaultMachineId = m.id;
        changed();
      },
    });
  }
  if (!machines.length) items.push({ label: "$(info) No machines yet", description: "Launch a cloud GPU or add your own machine" });
  items.push(
    { label: "", kind: vscode.QuickPickItemKind.Separator },
    { label: "$(rocket) Launch a cloud GPU…", description: "RTX 4090 to H100, billed from credits", run: () => panels.open({ view: "gpus" }) },
    { label: "$(add) Add your own machine…", description: "SSH or local GPU via WSL", run: () => vscode.commands.executeCommand("converge.addMachine") },
    { label: "$(package) Environments…", run: () => panels.open({ view: "envs", machineId: current ?? null }) },
    { label: "$(database) Datasets & models…", description: "Hugging Face and Kaggle", run: () => panels.open({ view: "hub", machineId: current ?? null }) },
    { label: "$(server-environment) Compute overview", run: () => panels.open({ view: "compute" }) },
  );
  for (const p of pods().filter((x) => x.status === "running" || x.status === "starting"))
    items.push({ label: `$(debug-stop) Stop ${p.name}`, description: `saves ${p.pricePerHour.toFixed(2)} credits/hr`, run: () => h.service.gpuStop(p.id) });
  const pick = await vscode.window.showQuickPick(items, { title: "Converlt compute", placeHolder: "Choose where runs go, or launch a GPU" });
  await pick?.run?.();
}

export function deactivate(): void {
  // Observers stop; training keeps running on the machines.
  host?.dispose();
}

// ---------------------------------------------------------------- launch flow

interface LaunchPrefill {
  command?: string;
  machineId?: string | null;
  options?: ReturnType<typeof readSettings>["defaultOptions"];
  reproducedFrom?: string;
}

async function pickMachine(h: Host, title: string, preferId?: string | null): Promise<Machine | undefined> {
  const machines = h.service.listMachines();
  const probes = h.service.listProbes();
  type Item = vscode.QuickPickItem & { machine?: Machine; add?: boolean };
  const items: Item[] = machines.map((m) => {
    const p = probes[m.id];
    const gpu = p?.gpus?.[0];
    return {
      label: `$(${p?.ready ? "vm-active" : p?.ok ? "vm" : "vm-outline"}) ${m.name}`,
      description: gpu ? `${p!.gpus!.length > 1 ? `${p!.gpus!.length}× ` : ""}${gpu.name} · ${formatMiB(gpu.memTotalMiB)}` : p ? (p.ok ? "no GPU detected" : "unreachable") : "not tested",
      detail: [m.host, m.hourlyRate !== undefined ? `$${m.hourlyRate}/hr` : null, p?.ok && !p.ready ? "needs attention" : null].filter(Boolean).join(" · "),
      machine: m,
      picked: m.id === preferId,
    };
  });
  items.sort((a, b) => Number(b.machine?.id === preferId) - Number(a.machine?.id === preferId));
  items.push({ label: "$(add) Add machine…", add: true, alwaysShow: true });
  const pick = await vscode.window.showQuickPick(items, { title, placeHolder: machines.length ? "Pick a GPU machine" : "No machines yet" });
  if (!pick) return undefined;
  if (pick.add) return addMachineFlow(h);
  return pick.machine;
}

async function launchFlow(h: Host, panels: Panels, file?: vscode.Uri, prefill: LaunchPrefill = {}): Promise<void> {
  await requireTrust("launch runs");
  await h.openWorkspace();
  const project = h.service.project;
  if (!project) {
    void vscode.window.showWarningMessage("Converlt: open a folder with your training code first.");
    return;
  }
  const machine = prefill.machineId && h.service.listMachines().find((m) => m.id === prefill.machineId)
    ? h.service.findMachine(prefill.machineId)
    : await pickMachine(h, "Run on which machine?", prefill.machineId ?? defaultMachineId);
  if (!machine) return;

  let command = prefill.command;
  if (!command) {
    const rel = file && file.fsPath.startsWith(project.path) ? path.relative(project.path, file.fsPath).replace(/\\/g, "/") : null;
    const python = /^[\w./-]+$/.test(machine.python) ? machine.python : "python3";
    const suggested = rel ? `${python} ${rel}` : (lastCommand.get(project.path) ?? readSettings().defaultCommand);
    command = await vscode.window.showInputBox({
      title: `Run on ${machine.name}`,
      prompt: `Runs in ${readSettings().remoteRoot}/${projectSlug(project.path)} with bash. Flags like --lr 3e-4 are recorded as hyperparameters.`,
      value: suggested,
      valueSelection: rel ? [suggested.length, suggested.length] : undefined,
      ignoreFocusOut: true,
    });
    if (!command?.trim()) return;
    command = command.trim();
  }
  lastCommand.set(project.path, command);

  const options = prefill.options ?? readSettings().defaultOptions;
  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: `Converlt: launching on ${machine.name}`, cancellable: false },
    async (progress) => {
      let runId: string | null = null;
      const done = new Promise<void>((resolve, reject) => {
        const sub = h.events.launchProgress.event((p) => {
          if (runId && p.runId !== runId) return;
          if (p.stage === "started") {
            sub.dispose();
            resolve();
          } else if (p.stage === "failed") {
            sub.dispose();
            reject(new Error(p.detail ?? "Launch failed"));
          } else progress.report({ message: p.detail });
        });
      });
      const res = await h.service.launchRun({ machineId: machine.id, command: command!, options, reproducedFrom: prefill.reproducedFrom });
      runId = res.runId;
      panels.open({ view: "run", runId: res.runId });
      await done;
    },
  );
}

const lastCommand = new Map<string, string>();

// ---------------------------------------------------------------- machines

async function addMachineFlow(h: Host): Promise<Machine | undefined> {
  const kind = await vscode.window.showQuickPick(
    [
      { label: "$(remote) SSH machine", description: "Cloud instance, lab server, or any Linux box you can ssh into", value: "ssh" },
      ...(process.platform === "win32" ? [{ label: "$(vm) Local GPU via WSL", description: "Train on this PC's NVIDIA GPU through WSL2", value: "wsl" }] : []),
    ],
    { title: "Add GPU machine" },
  );
  if (!kind) return undefined;
  let host: string | undefined;
  if (kind.value === "wsl") {
    const distro = await vscode.window.showInputBox({ title: "WSL distribution", value: "Ubuntu", prompt: "Name from `wsl -l -v`" });
    if (!distro) return undefined;
    host = `wsl:${distro.trim()}`;
  } else {
    host = await vscode.window.showInputBox({
      title: "SSH host",
      placeHolder: "ubuntu@203.0.113.7  or  my-gpu-alias",
      prompt: "Uses your ssh config and keys. For a new host, run `ssh <host>` once to accept its key.",
      ignoreFocusOut: true,
    });
    if (!host?.trim()) return undefined;
  }
  const python = await vscode.window.showInputBox({ title: "Python on the machine", value: "python3", prompt: "Interpreter with PyTorch, e.g. ~/venv/bin/python", ignoreFocusOut: true });
  if (python === undefined) return undefined;
  const rate = await vscode.window.showInputBox({ title: "Hourly rate in USD (optional)", placeHolder: "1.50", prompt: "Only used for cost estimates.", validateInput: (v) => (!v.trim() || Number(v) >= 0 ? null : "Enter a number") });
  if (rate === undefined) return undefined;
  const m = await h.service.addMachine({ name: "", host: host.trim(), python, hourlyRate: rate.trim() ? Number(rate) : undefined });
  await testMachine(h, m);
  return m;
}

async function testMachine(h: Host, m: Machine): Promise<void> {
  const r = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Converlt: connecting to ${m.name}…` }, () => h.service.probeMachine(m.id));
  if (!r.ok) void vscode.window.showErrorMessage(`Converlt: can't reach ${m.name}. ${r.error}`);
  else if (r.ready) void vscode.window.showInformationMessage(`Converlt: ${m.name} is ready${r.gpus?.length ? ` (${r.gpus.map((g) => g.name).join(", ")})` : ""}.`);
  else {
    const failed = (r.checks ?? []).filter((c) => !c.ok).map((c) => `${c.name}: ${c.detail}`);
    void vscode.window.showWarningMessage(`Converlt: ${m.name} is reachable but needs attention. ${failed.join("; ")}`);
  }
}

// ---------------------------------------------------------------- status bar

function updateStatus(item: vscode.StatusBarItem, runs: RunListItem[]): void {
  const live = runs.find((r) => r.status === "running") ?? runs.find((r) => r.status === "preparing" || r.status === "cancelling");
  if (!live) {
    item.hide();
    return;
  }
  const metric = live.primaryMetric ? ` ${live.primaryMetric.key.split("/").pop()} ${live.primaryMetric.last === null ? "NaN" : formatNumber(live.primaryMetric.last)}` : "";
  const time = live.durationSec !== null ? ` · ${formatDuration(live.durationSec)}` : "";
  item.text = `$(${live.status === "running" ? "pulse" : "loading~spin"}) ${live.name}${metric}${time}`;
  item.tooltip = `${live.name} on ${live.gpuName ?? live.machineName}\n${live.command}\nClick to open`;
  item.command = { command: "converge.openRun", title: "Open Run", arguments: [live.runId] };
  item.backgroundColor = live.diagnosticKinds.includes("nan") || live.diagnosticKinds.includes("oom") ? new vscode.ThemeColor("statusBarItem.errorBackground") : undefined;
  item.show();
}

// ---------------------------------------------------------------- problems

/** Shows where the latest finished run failed, in the Problems panel and inline in the editor. */
function updateProblems(h: Host, problems: vscode.DiagnosticCollection, runId: string): void {
  const run = h.service.getRun(runId);
  const project = h.service.project;
  if (!run || !project) return;
  problems.clear();
  const slug = projectSlug(project.path);
  const byFile = new Map<string, vscode.Diagnostic[]>();
  for (const d of run.summary.diagnostics) {
    if (d.severity !== "error") continue;
    const loc = locateDiagnostic(d, slug);
    if (!loc) continue;
    const file = path.join(project.path, loc.relPath);
    const diag = new vscode.Diagnostic(new vscode.Range(loc.line - 1, 0, loc.line - 1, 1000), `${run.manifest.name}: ${d.message}`, vscode.DiagnosticSeverity.Error);
    diag.source = "Converlt";
    diag.code = { value: d.kind, target: vscode.Uri.parse(`command:converge.openRun?${encodeURIComponent(JSON.stringify([runId]))}`) };
    byFile.set(file, [...(byFile.get(file) ?? []), diag]);
  }
  for (const [file, diags] of byFile) problems.set(vscode.Uri.file(file), diags);
}

// ---------------------------------------------------------------- code lens

const ENTRY = /^if __name__ == ["']__main__["']\s*:/m;

class RunCodeLens implements vscode.CodeLensProvider {
  private readonly host: Host;
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChangeCodeLenses = this.changed.event;

  constructor(host: Host) {
    this.host = host;
  }

  refresh(): void {
    this.changed.fire();
  }

  provideCodeLenses(doc: vscode.TextDocument): vscode.CodeLens[] {
    if (!vscode.workspace.getConfiguration("converge").get("codeLens", true)) return [];
    const text = doc.getText();
    const isEntry = ENTRY.exec(text);
    const looksLikeTraining = /(^|[\\/])(train|finetune|fine_tune|pretrain)[\w-]*\.py$/i.test(doc.fileName);
    if (!isEntry && !looksLikeTraining) return [];
    const line = isEntry ? doc.positionAt(isEntry.index).line : 0;
    const range = new vscode.Range(line, 0, line, 0);
    const lenses = [new vscode.CodeLens(range, { title: "$(rocket) Run on GPU", command: "converge.runFile", arguments: [doc.uri] })];
    const base = path.basename(doc.fileName);
    const last = this.host.service.listRuns().find((r) => r.command.split(/\s+/).some((t) => t === base || t.endsWith(`/${base}`)));
    if (last) {
      const metric = last.primaryMetric ? ` · ${last.primaryMetric.key.split("/").pop()} ${last.primaryMetric.last === null ? "NaN" : formatNumber(last.primaryMetric.last)}` : "";
      lenses.push(new vscode.CodeLens(range, { title: `Last: ${last.name} ${last.status}${metric}`, command: "converge.openRun", arguments: [last.runId] }));
    }
    return lenses;
  }
}

function throttle(fn: () => void, ms: number): () => void {
  let timer: NodeJS.Timeout | null = null;
  return () => {
    if (timer) return;
    timer = setTimeout(() => {
      timer = null;
      fn();
    }, ms);
  };
}
