import { spawn, type ChildProcess } from "node:child_process";
import os from "node:os";
import path from "node:path";
import type { Readable } from "node:stream";
import type { MachineRef } from "@converge/run-protocol";

export interface ExecResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

export interface ExecOptions {
  input?: string | Buffer;
  /** Piped into the remote command's stdin (e.g. a tar stream). */
  stdinStream?: Readable;
  timeoutMs?: number;
}

/** Runs POSIX shell commands on a machine. SSH in production; WSL in local end-to-end tests. */
export interface RemoteTransport {
  exec(command: string, opts?: ExecOptions): Promise<ExecResult>;
  spawn(command: string): ChildProcess;
}

/** POSIX single-quote escaping. */
export function shq(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/** Quotes a remote path while keeping a leading ~/ expandable. */
export function remotePath(p: string): string {
  if (p === "~") return `"$HOME"`;
  if (p.startsWith("~/")) return `"$HOME"/${shq(p.slice(2))}`;
  return shq(p);
}

/** Every remote command runs under bash so behaviour doesn't depend on the login shell (zsh, fish...). */
export function wrapBash(command: string): string {
  return `bash -c ${shq(command)}`;
}

/** Known-hosts file for one cloud pod. Pods get recycled IPs, so each pod pins its own host key. */
export function cloudKnownHosts(podId: string): string {
  return path.join(os.homedir(), ".ssh", "converlt", `known_hosts-${podId.replace(/[^\w-]/g, "")}`);
}

export function sshArgs(m: Pick<MachineRef, "host" | "port" | "identityFile" | "cloudPodId">, remoteCommand: string): string[] {
  const args = [
    "-o", "BatchMode=yes",
    "-o", "ConnectTimeout=12",
    "-o", "ServerAliveInterval=15",
    "-o", "ServerAliveCountMax=3",
  ];
  // A fresh pod's host key can't be known in advance: trust it on first connect, then pin it.
  if (m.cloudPodId) args.push("-o", "StrictHostKeyChecking=accept-new", "-o", `UserKnownHostsFile=${cloudKnownHosts(m.cloudPodId)}`);
  if (m.port) args.push("-p", String(m.port));
  if (m.identityFile) args.push("-i", m.identityFile, "-o", "IdentitiesOnly=yes");
  args.push("--", m.host, wrapBash(remoteCommand));
  return args;
}

/** Turns raw ssh stderr into an actionable message. */
export function explainSshError(stderr: string, host: string): string {
  // wsl.exe writes UTF-16 errors; drop the NULs so they're readable.
  const s = stderr.replace(/\0/g, "").trim();
  if (parseWslHost(host) && /no distribution|WSL_E_DISTRO_NOT_FOUND|ERROR_PATH_NOT_FOUND|not recognized/i.test(s))
    return `WSL distribution for ${host} was not found. Run \`wsl -l -v\` to list installed distributions.`;
  if (/Host key verification failed|REMOTE HOST IDENTIFICATION HAS CHANGED/i.test(s))
    return `Host key for ${host} is unknown or changed. Run \`ssh ${host}\` once in a terminal to verify and accept it.`;
  if (/Permission denied \(/i.test(s))
    return `SSH authentication to ${host} failed. Converlt uses key-based auth: add your key to the server (ssh-copy-id) or set an identity file.`;
  if (/Could not resolve hostname/i.test(s)) return `Cannot resolve host "${host}". Check the hostname or your ~/.ssh/config alias.`;
  if (/Connection refused/i.test(s)) return `Connection to ${host} was refused. Is sshd running and the port correct?`;
  if (/timed out|Operation timed out/i.test(s)) return `Connection to ${host} timed out. Check the network, VPN, or firewall.`;
  if (/No such file or directory.*converge_agent|can't open file/i.test(s)) return "The Converlt agent is missing on the machine. Reconnect to reinstall it.";
  if (/python3?: (command )?not found|No such file or directory/i.test(s)) return `Python was not found on ${host}. Set the machine's Python path.`;
  return s.split("\n").filter(Boolean).slice(-3).join("\n") || "Unknown SSH error";
}

/** Picks the last line of output that parses as a JSON object (login banners may precede it). */
export function lastJsonLine<T>(stdout: string): T | null {
  const lines = stdout.split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i--) {
    const l = lines[i]!.trim();
    if (!l.startsWith("{")) continue;
    try {
      return JSON.parse(l) as T;
    } catch {
      // keep looking
    }
  }
  return null;
}

export function runProcess(cmd: string, args: string[], opts: ExecOptions = {}): Promise<ExecResult> {
  return new Promise((resolve) => {
    let child: ChildProcess;
    try {
      child = spawn(cmd, args, { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    } catch (e) {
      resolve({ code: null, stdout: "", stderr: String(e) });
      return;
    }
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let done = false;
    const finish = (code: number | null, extraErr = "") => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({ code, stdout: Buffer.concat(out).toString("utf8"), stderr: Buffer.concat(err).toString("utf8") + extraErr });
    };
    const timer = opts.timeoutMs
      ? setTimeout(() => {
          child.kill();
          finish(null, `\nTimed out after ${Math.round(opts.timeoutMs! / 1000)}s`);
        }, opts.timeoutMs)
      : undefined;
    child.stdout!.on("data", (d) => out.push(d));
    child.stderr!.on("data", (d) => err.push(d));
    child.on("error", (e) => finish(null, String(e)));
    child.on("close", (code) => finish(code));
    child.stdin!.on("error", () => {});
    if (opts.stdinStream) opts.stdinStream.pipe(child.stdin!);
    else child.stdin!.end(opts.input ?? "");
  });
}

/** Hosts written as "wsl:<distro>" run in a local WSL2 distribution (Windows local GPU). */
export function parseWslHost(host: string): string | null {
  const m = /^wsl:([\w.-]+)$/i.exec(host.trim());
  return m ? m[1]! : null;
}

export class WslTransport implements RemoteTransport {
  private readonly distro: string;

  constructor(distro: string) {
    this.distro = distro;
  }

  private args(command: string): string[] {
    return ["-d", this.distro, "--", "bash", "-c", command];
  }

  exec(command: string, opts: ExecOptions = {}): Promise<ExecResult> {
    return runProcess("wsl.exe", this.args(command), { timeoutMs: 120_000, ...opts });
  }

  spawn(command: string): ChildProcess {
    return spawn("wsl.exe", this.args(command), { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  }
}

/** The host of "this computer" on macOS and Linux: commands run here directly, no SSH. */
export const LOCAL_HOST = "local";

export function isLocalHost(host: string): boolean {
  return host.trim().toLowerCase() === LOCAL_HOST;
}

/** Runs on this computer with bash (macOS and Linux; on Windows this computer's GPU is reached through WSL). */
export class LocalTransport implements RemoteTransport {
  constructor() {
    if (process.platform === "win32") throw new Error("On Windows, this computer's GPU is used through WSL: add it as wsl:<distro> (Compute → Find this PC's GPU).");
  }

  exec(command: string, opts: ExecOptions = {}): Promise<ExecResult> {
    return runProcess("bash", ["-c", command], { timeoutMs: 120_000, ...opts });
  }

  spawn(command: string): ChildProcess {
    return spawn("bash", ["-c", command], { stdio: ["ignore", "pipe", "pipe"] });
  }
}

export function transportFor(machine: Pick<MachineRef, "host" | "port" | "identityFile" | "cloudPodId">, sshPath: string): RemoteTransport {
  if (isLocalHost(machine.host)) return new LocalTransport();
  const distro = parseWslHost(machine.host);
  return distro ? new WslTransport(distro) : new SshTransport(machine, sshPath);
}

export class SshTransport implements RemoteTransport {
  private readonly machine: Pick<MachineRef, "host" | "port" | "identityFile" | "cloudPodId">;
  private readonly sshPath: string;

  constructor(machine: Pick<MachineRef, "host" | "port" | "identityFile" | "cloudPodId">, sshPath: string) {
    this.machine = machine;
    this.sshPath = sshPath;
  }

  async exec(command: string, opts: ExecOptions = {}): Promise<ExecResult> {
    return runProcess(this.sshPath, sshArgs(this.machine, command), { timeoutMs: 60_000, ...opts });
  }

  spawn(command: string): ChildProcess {
    return spawn(this.sshPath, sshArgs(this.machine, command), { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  }
}
