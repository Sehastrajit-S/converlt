import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import type { AgentStartRequest, RunEvent, TailControlLine } from "@converge/run-protocol";
import type { ProbeResult, TelemetryResult } from "./api.ts";
import { lastJsonLine, remotePath, shq, type RemoteTransport } from "./transport.ts";

export const REMOTE_LIB = "~/.converge/lib";
const AGENT_SCRIPT = `${REMOTE_LIB}/agent/converge_agent.py`;

export class AgentError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

function pythonCmd(python: string): string {
  return /^[\w./-]+$/.test(python) ? python : python.startsWith("~/") ? remotePath(python) : shq(python);
}

/** Talks to converge_agent.py on one machine through a transport. */
export class AgentClient {
  readonly transport: RemoteTransport;
  private readonly python: string;
  private readonly explain: (stderr: string) => string;

  constructor(transport: RemoteTransport, python: string, explain: (stderr: string) => string) {
    this.transport = transport;
    this.python = python;
    this.explain = explain;
  }

  agentCommand(args: string): string {
    return `${pythonCmd(this.python)} ${remotePath(AGENT_SCRIPT)} ${args}`;
  }

  /** Uploads agent + SDK (a small tar of resourcesDir/{agent,sdk}). */
  async install(resourcesDir: string): Promise<void> {
    const tar = spawn("tar", ["-cf", "-", "agent", "sdk"], { cwd: resourcesDir, windowsHide: true });
    const tarErr: Buffer[] = [];
    tar.stderr.on("data", (d) => tarErr.push(d));
    const res = await this.transport.exec(`mkdir -p ${remotePath(REMOTE_LIB)} && tar -xf - -C ${remotePath(REMOTE_LIB)}`, {
      stdinStream: tar.stdout,
      timeoutMs: 60_000,
    });
    if (res.code !== 0) throw new AgentError("install_failed", this.explain(res.stderr || Buffer.concat(tarErr).toString()));
  }

  private async call<T>(args: string, input?: string, timeoutMs = 60_000): Promise<T> {
    const t0 = Date.now();
    const res = await this.transport.exec(this.agentCommand(args), { input, timeoutMs });
    const json = lastJsonLine<T & { ok?: boolean; error?: string; message?: string }>(res.stdout);
    if (!json) throw new AgentError("no_response", this.explain(res.stderr) || `Agent returned no output (exit ${res.code})`);
    if (json.ok === false) throw new AgentError(json.error ?? "error", json.message ?? "Agent error");
    (json as { latencyMs?: number }).latencyMs = Date.now() - t0;
    return json;
  }

  probe(workdir: string): Promise<ProbeResult> {
    return this.call<ProbeResult>(`probe --workdir ${shq(workdir)} --python ${shq(this.python)}`, undefined, 120_000);
  }

  telemetry(workdir: string): Promise<TelemetryResult> {
    return this.call<TelemetryResult>(`telemetry --workdir ${shq(workdir)}`, undefined, 30_000);
  }

  start(req: AgentStartRequest): Promise<{ ok: boolean; runId: string; alreadyStarted?: boolean }> {
    return this.call("start", JSON.stringify(req));
  }

  status(runId: string): Promise<{ effectiveStatus: string; lastSeq: number }> {
    return this.call(`status ${shq(runId)}`);
  }

  cancel(runId: string): Promise<{ ok: boolean }> {
    return this.call(`cancel ${shq(runId)}`);
  }

  async uploadDirectory(tarStream: NodeJS.ReadableStream, remoteDir: string): Promise<void> {
    const res = await this.transport.exec(`mkdir -p ${remotePath(remoteDir)} && tar -xf - -C ${remotePath(remoteDir)}`, {
      stdinStream: tarStream as import("node:stream").Readable,
      timeoutMs: 15 * 60_000,
    });
    if (res.code !== 0) throw new AgentError("sync_failed", this.explain(res.stderr));
  }
}

export interface TailHandlers {
  onEvents(events: RunEvent[]): void;
  onControl(line: TailControlLine): void;
  onConnection(state: "live" | "reconnecting" | "lost", detail?: string): void;
}

const BACKOFF_MS = [1000, 2000, 5000, 10_000, 20_000, 30_000];
const SILENCE_TIMEOUT_MS = 25_000;

/**
 * Follows a run's event log, replaying from the last seen sequence number and
 * reconnecting with backoff. Losing the stream never changes the run's outcome.
 */
export class TailSession {
  private readonly client: AgentClient;
  private readonly runId: string;
  private lastSeq: number;
  private readonly handlers: TailHandlers;
  private child: ReturnType<RemoteTransport["spawn"]> | null = null;
  private stopped = false;
  private attempt = 0;
  private retryTimer: NodeJS.Timeout | null = null;
  private silenceTimer: NodeJS.Timeout | null = null;

  constructor(client: AgentClient, runId: string, lastSeq: number, handlers: TailHandlers) {
    this.client = client;
    this.runId = runId;
    this.lastSeq = lastSeq;
    this.handlers = handlers;
  }

  start(): void {
    this.stopped = false;
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    if (this.silenceTimer) clearTimeout(this.silenceTimer);
    this.child?.kill();
    this.child = null;
  }

  /** Reconnect now, skipping any pending backoff. */
  kick(): void {
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.child?.kill();
    this.attempt = 0;
    this.stopped = false;
    this.connect();
  }

  private armSilence(): void {
    if (this.silenceTimer) clearTimeout(this.silenceTimer);
    // The agent heartbeats every 5s; silence means a half-open connection.
    this.silenceTimer = setTimeout(() => this.child?.kill(), SILENCE_TIMEOUT_MS);
  }

  private connect(): void {
    if (this.stopped) return;
    const child = this.client.transport.spawn(this.client.agentCommand(`tail ${shq(this.runId)} --from-seq ${this.lastSeq} --follow`));
    this.child = child;
    let ended = false;
    let gotLine = false;
    let stderr = "";
    let batch: RunEvent[] = [];
    let flushTimer: NodeJS.Timeout | null = null;
    const flush = () => {
      flushTimer = null;
      if (batch.length) {
        const b = batch;
        batch = [];
        this.handlers.onEvents(b);
      }
    };
    this.armSilence();
    child.stderr?.on("data", (d) => (stderr += d.toString()).length > 8000 && (stderr = stderr.slice(-4000)));
    const rl = createInterface({ input: child.stdout! });
    rl.on("line", (line) => {
      const t = line.trim();
      if (!t.startsWith("{")) return;
      let obj: any;
      try {
        obj = JSON.parse(t);
      } catch {
        return;
      }
      this.armSilence();
      if (!gotLine) {
        gotLine = true;
        this.attempt = 0;
        this.handlers.onConnection("live");
      }
      if (typeof obj.seq === "number") {
        if (obj.seq <= this.lastSeq) return;
        this.lastSeq = obj.seq;
        batch.push(obj as RunEvent);
        if (batch.length >= 500) flush();
        else if (!flushTimer) flushTimer = setTimeout(flush, 100);
        return;
      }
      if (obj.type === "end") ended = true;
      flush();
      this.handlers.onControl(obj as TailControlLine);
    });
    child.on("close", () => {
      if (flushTimer) clearTimeout(flushTimer);
      flush();
      if (this.silenceTimer) clearTimeout(this.silenceTimer);
      if (this.child === child) this.child = null;
      if (this.stopped || ended) return;
      const delay = BACKOFF_MS[Math.min(this.attempt, BACKOFF_MS.length - 1)]!;
      this.attempt++;
      this.handlers.onConnection(this.attempt > 3 ? "lost" : "reconnecting", stderr.trim().split("\n").slice(-2).join("\n"));
      this.retryTimer = setTimeout(() => this.connect(), delay);
    });
    child.on("error", () => {
      /* close follows */
    });
  }
}
