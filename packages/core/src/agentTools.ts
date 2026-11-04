// Converlt tools for AI agents: the editor's own assistant and outside agents (Claude Code,
// Codex) through the Converlt MCP server. Definitions are plain data (the MCP server needs them
// without the service); `runAgentTool` executes them against a live ConvergeService.
import { forecastRun } from "@converge/run-protocol";
import type { RunView } from "./api.ts";
import type { ConvergeService } from "./service.ts";

export interface AgentToolDef {
  name: string;
  description: string;
  inputSchema: { type: "object"; properties: Record<string, unknown>; required?: string[] };
  /** Spends compute or changes state: the user approves each call in the editor. */
  needsApproval?: boolean;
}

export const AGENT_TOOLS: AgentToolDef[] = [
  {
    name: "converlt_listRuns",
    description: "List this project's Converlt training runs, newest first: status, primary metric, diagnostics (NaN, OOM, crash), machine and command.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "converlt_getRun",
    description: "Details of one Converlt training run: command, config, git commit, metrics (last/min/max), diagnostics with the failing step, environment, and the last log lines. Use it to explain or fix a failed run.",
    inputSchema: { type: "object", properties: { run: { type: "string", description: "Run name (e.g. run-003) or id" } }, required: ["run"] },
  },
  {
    name: "converlt_listMachines",
    description: "List the user's GPU machines (SSH, WSL and Converlt cloud pods) with readiness, GPUs, PyTorch and the Python each uses.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "converlt_listDownloads",
    description: "List datasets and models downloaded from Hugging Face or Kaggle onto the user's GPU machines, with their exact paths on each machine. Use these paths in training code instead of downloading again.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "converlt_wallet",
    description: "The user's Converlt credit balance, current spend per hour, and running cloud GPU pods with their cost.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "converlt_launchRun",
    description:
      "Launch a training run on a GPU machine through Converlt: syncs the project, runs the command under Converlt's supervisor, and records metrics and diagnostics. The user approves every launch. Returns the run name; follow it with converlt_getRun.",
    inputSchema: {
      type: "object",
      properties: {
        command: { type: "string", description: "Shell command run in the project root on the machine, e.g. python3 train.py --lr 3e-4" },
        machine: { type: "string", description: "Machine name from converlt_listMachines; omit for the user's default" },
      },
      required: ["command"],
    },
    needsApproval: true,
  },
  {
    name: "converlt_stopRun",
    description: "Stop a running Converlt training run (SIGTERM, then SIGKILL after the grace period). The user approves it.",
    inputSchema: { type: "object", properties: { run: { type: "string", description: "Run name or id" } }, required: ["run"] },
    needsApproval: true,
  },
];

/** Asks the user to allow a call; resolves false when they decline. */
export type ApproveFn = (title: string, detail: string) => Promise<boolean>;

const MAX = 60_000;

/** When a running run will finish, if its length is known. */
function forecastFor(v: RunView) {
  const f = v.status === "running" ? forecastRun(v.summary, v.effectiveConfig, Date.now() / 1000) : null;
  return f && { step: f.currentStep, totalSteps: f.totalSteps, stepsPerSec: Number(f.stepsPerSec.toPrecision(3)), remainingMinutes: Math.round(f.remainingSec / 60), lengthFrom: f.totalSource };
}

export interface ToolContext {
  service: ConvergeService;
  approve: ApproveFn;
  /** Who is asking, for the approval prompt ("Claude Code", "Converlt"). */
  client: string;
  defaultMachineId?: string | null;
}

export async function runAgentTool(name: string, input: Record<string, unknown>, ctx: ToolContext): Promise<string> {
  const s = ctx.service;
  const findRun = (key: string) => s.listRuns().find((r) => r.name === key || r.runId === key);
  switch (name) {
    case "converlt_listRuns": {
      if (!s.project) return "No project is open in Converlt.";
      const runs = s.listRuns();
      if (!runs.length) return "No runs in this project yet.";
      return runs
        .map((r) => `${r.name} (${r.runId}) ${r.status}${r.primaryMetric ? ` ${r.primaryMetric.key}=${r.primaryMetric.last ?? "NaN"}` : ""}${r.diagnosticKinds.length ? ` diagnostics=${r.diagnosticKinds.join(",")}` : ""} on ${r.machineName} :: ${r.command}`)
        .join("\n");
    }
    case "converlt_getRun": {
      const item = findRun(String(input.run ?? ""));
      const v = item ? s.getRun(item.runId) : null;
      if (!v) return `No run named ${input.run}. Use converlt_listRuns.`;
      const sum = v.summary;
      const metrics = Object.fromEntries(
        Object.entries(sum.metrics).map(([k, pts]) => {
          const finite = pts.filter((p) => p.value !== null).map((p) => p.value as number);
          return [k, { last: pts.at(-1)?.value ?? null, lastStep: pts.at(-1)?.step ?? null, min: finite.length ? Math.min(...finite) : null, max: finite.length ? Math.max(...finite) : null }];
        }),
      );
      return JSON.stringify(
        {
          name: v.manifest.name,
          status: v.status,
          command: v.manifest.command,
          config: v.effectiveConfig,
          git: v.manifest.git ? { commit: v.manifest.git.commit, dirty: v.manifest.git.dirty } : null,
          machine: v.manifest.machine.name,
          exitCode: sum.exitCode,
          reason: sum.reason,
          peakGpuMemMiB: sum.peakGpuMemMiB,
          metrics,
          diagnostics: sum.diagnostics.map((d) => ({ kind: d.kind, severity: d.severity, message: d.message, step: d.step, data: d.data })),
          forecast: forecastFor(v),
          inputs: sum.inputs.map((i) => ({ kind: i.kind, name: i.name, fingerprint: i.fingerprint ?? null, revision: i.revision ?? null })),
          env: sum.env,
          lastLogLines: sum.logs.slice(-80).map((l) => (l.stream === "stderr" ? `[stderr] ${l.line}` : l.line)),
        },
        null,
        1,
      ).slice(0, MAX);
    }
    case "converlt_listMachines": {
      const probes = s.listProbes();
      const ms = s.listMachines();
      if (!ms.length) return "No machines. The user can add one, or launch a cloud GPU from the Converlt dashboard.";
      return ms
        .map((m) => {
          const p = probes[m.id];
          const gpus = p?.gpus?.map((g) => `${g.name} ${Math.round(g.memTotalMiB / 1024)}GB`).join(", ") ?? "unknown GPU";
          return `${m.name}${m.id === ctx.defaultMachineId ? " (default)" : ""} [${m.cloudPodId ? "cloud pod" : m.host}] python=${m.python} ${!p ? "not tested" : !p.ok ? `unreachable: ${p.error}` : p.ready ? "ready" : "needs attention"} · ${gpus}${p?.python?.torch ? ` · torch ${p.python.torch}` : ""}`;
        })
        .join("\n");
    }
    case "converlt_listDownloads": {
      const out: string[] = [];
      for (const m of s.listMachines()) {
        try {
          for (const j of await s.hubJobs(m.id)) out.push(`${m.name}: ${j.source} ${j.kind} ${j.id} [${j.status}] at ${j.path}`);
        } catch (e) {
          out.push(`${m.name}: unreachable (${e instanceof Error ? e.message : e})`);
        }
      }
      return out.length ? out.join("\n") : "No datasets or models downloaded through Converlt yet (Datasets & Models in the Converlt dashboard).";
    }
    case "converlt_wallet": {
      const st = await s.cloudStatus();
      if (!st.connected) return "Not signed in to Converlt Cloud.";
      const w = await s.cloudWallet();
      const pods = await s.gpuPods().catch(() => []);
      return [
        `Balance: ${w.balance.toFixed(2)} credits (${w.creditsPerUsd} credits = $1), spending ${w.burnPerHour.toFixed(2)}/hr`,
        `This month: GPUs ${w.spend.gpu.month.toFixed(2)}, models ${w.spend.models.month.toFixed(2)}`,
        ...pods.filter((p) => p.status !== "terminated").map((p) => `Pod ${p.name}: ${p.gpuCount}× ${p.gpuName} ${p.status}, ${p.pricePerHour.toFixed(2)}/hr, spent ${p.spent.toFixed(2)}`),
      ].join("\n");
    }
    case "converlt_launchRun": {
      if (!s.project) throw new Error("No project is open in Converlt.");
      const command = String(input.command ?? "").trim();
      if (!command) throw new Error("command is required");
      const wanted = typeof input.machine === "string" && input.machine.trim() ? input.machine.trim().toLowerCase() : null;
      const machines = s.listMachines();
      const machine = wanted ? machines.find((m) => m.name.toLowerCase() === wanted || m.name.toLowerCase().startsWith(wanted)) : (machines.find((m) => m.id === ctx.defaultMachineId) ?? machines[0]);
      if (!machine) throw new Error(wanted ? `No machine named ${input.machine}. Use converlt_listMachines.` : "No machines. Add one or launch a cloud GPU first.");
      const ok = await ctx.approve(`${ctx.client} wants to launch a training run`, `${command}\n\non ${machine.name}${machine.cloudPodId ? " (cloud pod, billed per hour)" : ""}`);
      if (!ok) return "The user declined this launch.";
      const { runId } = await s.launchRun({ machineId: machine.id, command, options: s.defaultRunOptions() });
      const name = s.listRuns().find((r) => r.runId === runId)?.name ?? runId;
      return `Launched ${name} on ${machine.name}. Check progress with converlt_getRun ${name}.`;
    }
    case "converlt_stopRun": {
      const item = findRun(String(input.run ?? ""));
      if (!item) return `No run named ${input.run}.`;
      const ok = await ctx.approve(`${ctx.client} wants to stop ${item.name}`, `${item.command}\n\non ${item.machineName}`);
      if (!ok) return "The user declined.";
      await s.cancelRun(item.runId);
      return `Stopping ${item.name}.`;
    }
    default:
      throw new Error(`Unknown tool ${name}`);
  }
}
