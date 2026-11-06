// "Use my own keys": runs the Converlt Gateway on this computer with the user's RunPod and
// OpenRouter keys, so on-demand GPUs and models work without a hosted Converlt account.
// One gateway serves every window: it runs detached (so it keeps metering pods and stopping them
// when the budget runs out, even with the editor closed) and is found again through a lock file.
// In this mode credits are a spending budget at cost: no margin, 100 credits = $1.
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { closeSync, existsSync, openSync } from "node:fs";
import { promises as fs } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import type { LocalGatewayStatus } from "./api.ts";
import type { SecretStore } from "./service.ts";

const KEYS = { runpod: "gateway.runpod", openrouter: "gateway.openrouter", admin: "gateway.admin", user: "gateway.userToken", enabled: "gateway.enabled" } as const;
const LOCAL_EMAIL = "you@local.converlt";

export interface LocalGatewayOptions {
  /** A Node-compatible runtime: the editor's own executable with ELECTRON_RUN_AS_NODE. */
  executable: string;
  /** The bundled gateway (dist/gateway/main.mjs). */
  script: string;
  secrets: SecretStore;
  /** Shared by every Converlt shell on this computer. */
  dataDir?: string;
}

interface Lock {
  pid: number;
  port: number;
  startedAt: number;
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const port = (s.address() as net.AddressInfo).port;
      s.close(() => resolve(port));
    });
  });
}

async function healthy(url: string): Promise<boolean> {
  try {
    const r = await fetch(`${url}/health`, { signal: AbortSignal.timeout(2000) });
    return r.ok;
  } catch {
    return false;
  }
}

export class LocalGateway {
  private readonly opts: LocalGatewayOptions;
  readonly dataDir: string;
  private lastError: string | null = null;
  private lastChecks: LocalGatewayStatus["checks"] = {};

  constructor(opts: LocalGatewayOptions) {
    this.opts = opts;
    this.dataDir = opts.dataDir ?? process.env.CONVERLT_LOCAL_GATEWAY_DIR ?? path.join(os.homedir(), ".converlt", "gateway");
  }

  private get lockFile(): string {
    return path.join(this.dataDir, "gateway.lock.json");
  }

  private async readLock(): Promise<Lock | null> {
    try {
      return JSON.parse(await fs.readFile(this.lockFile, "utf8")) as Lock;
    } catch {
      return null;
    }
  }

  /** The running gateway's URL, if one answers. */
  async runningUrl(): Promise<string | null> {
    const lock = await this.readLock();
    if (!lock) return null;
    const url = `http://127.0.0.1:${lock.port}`;
    return (await healthy(url)) ? url : null;
  }

  async status(): Promise<LocalGatewayStatus> {
    const s = this.opts.secrets;
    return {
      enabled: (await s.get(KEYS.enabled)) === "1",
      runpodKey: !!(await s.get(KEYS.runpod)),
      openrouterKey: !!(await s.get(KEYS.openrouter)),
      url: await this.runningUrl(),
      error: this.lastError,
      checks: this.lastChecks,
    };
  }

  async setKeys(keys: { runpod?: string | null; openrouter?: string | null }): Promise<void> {
    for (const [name, value] of Object.entries(keys) as [keyof typeof keys, string | null | undefined][]) {
      if (value === undefined) continue;
      const v = value?.trim() || null;
      if (v && !/^[\w.:-]{10,512}$/.test(v)) throw new Error(`That doesn't look like a ${name === "runpod" ? "RunPod" : "OpenRouter"} API key`);
      await this.opts.secrets.set(KEYS[name], v);
    }
  }

  /**
   * Starts the gateway (or finds the running one) and returns this computer's account on it.
   * `restart` picks up changed keys.
   */
  async start(initialCredits: number, restart = false): Promise<{ url: string; token: string }> {
    const s = this.opts.secrets;
    const runpod = await s.get(KEYS.runpod);
    const openrouter = await s.get(KEYS.openrouter);
    if (!runpod && !openrouter) throw new Error("Add a RunPod key, an OpenRouter key, or both.");
    let admin = await s.get(KEYS.admin);
    if (!admin) {
      admin = randomBytes(24).toString("base64url");
      await s.set(KEYS.admin, admin);
    }
    await fs.mkdir(this.dataDir, { recursive: true });

    let url = await this.runningUrl();
    if (url && restart) {
      await this.stop();
      url = null;
    }
    if (!url) url = await this.spawn(admin, runpod ?? "", openrouter ?? "");
    await s.set(KEYS.enabled, "1");

    // This computer's account, created once with the starting budget.
    let token = await s.get(KEYS.user);
    if (token && !(await fetch(`${url}/v1/me`, { headers: { Authorization: `Bearer ${token}` } }).then((r) => r.ok, () => false))) token = undefined;
    if (!token) {
      const headers = { Authorization: `Bearer ${admin}`, "Content-Type": "application/json" };
      let res = await fetch(`${url}/admin/users`, { method: "POST", headers, body: JSON.stringify({ email: LOCAL_EMAIL, name: os.userInfo().username, credits: initialCredits, note: "Starting budget" }) });
      if (res.status === 409) res = await fetch(`${url}/admin/rotate-token`, { method: "POST", headers, body: JSON.stringify({ email: LOCAL_EMAIL }) });
      const body = (await res.json().catch(() => ({}))) as { token?: string; error?: { message?: string } };
      if (!res.ok || !body.token) throw new Error(body.error?.message ?? `The local gateway refused to create your account (${res.status})`);
      token = body.token;
      await s.set(KEYS.user, token);
    }
    return { url, token };
  }

  private async spawn(admin: string, runpod: string, openrouter: string): Promise<string> {
    if (!existsSync(this.opts.script))
      throw new Error("This build of Converlt doesn't include the gateway for \"Use my own keys\" (it was built without Converlt-server). Use a Converlt account, or your own GPU machines over SSH.");
    const port = await freePort();
    const url = `http://127.0.0.1:${port}`;
    const log = openSync(path.join(this.dataDir, "gateway.log"), "a");
    const child = spawn(this.opts.executable, [this.opts.script], {
      detached: true,
      windowsHide: true,
      stdio: ["ignore", log, log],
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: "1",
        PORT: String(port),
        CONVERLT_DATA_DIR: this.dataDir,
        CONVERLT_PUBLIC_URL: url,
        CONVERLT_ADMIN_TOKEN: admin,
        RUNPOD_API_KEY: runpod,
        OPENROUTER_API_KEY: openrouter,
        // Your own keys: credits are a budget at cost.
        GPU_MARKUP: "1",
        MODEL_MARKUP: "1",
        CREDITS_PER_USD: "100",
      },
    });
    child.unref();
    closeSync(log);
    for (let i = 0; i < 50; i++) {
      await new Promise((r) => setTimeout(r, 200));
      if (await healthy(url)) {
        await fs.writeFile(this.lockFile, JSON.stringify({ pid: child.pid ?? 0, port, startedAt: Date.now() } satisfies Lock));
        this.lastError = null;
        return url;
      }
      if (child.exitCode !== null) break;
    }
    const tail = await fs.readFile(path.join(this.dataDir, "gateway.log"), "utf8").then((t) => t.trim().split("\n").slice(-5).join("\n"), () => "");
    this.lastError = `The local gateway didn't start.${tail ? `\n${tail}` : ""}`;
    try {
      if (child.pid) process.kill(child.pid);
    } catch {
      // already gone
    }
    throw new Error(this.lastError);
  }

  /**
   * Checks the keys against the providers without spending anything: RunPod through the gateway's
   * GPU list (which also proves the queries Converlt sends are accepted), OpenRouter with its
   * key-info endpoint.
   */
  async verify(url: string, token: string): Promise<LocalGatewayStatus["checks"]> {
    const checks: LocalGatewayStatus["checks"] = {};
    const s = this.opts.secrets;
    if (await s.get(KEYS.runpod)) {
      try {
        const r = await fetch(`${url}/v1/gpu/offers`, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(40_000) });
        const body = (await r.json().catch(() => null)) as { error?: { message?: string } } | unknown[] | null;
        checks.runpod = r.ok && Array.isArray(body) ? `ok: ${new Set(body.map((o) => (o as { id: string }).id)).size} GPU types available` : ((body as { error?: { message?: string } })?.error?.message ?? `RunPod check failed (${r.status})`);
      } catch (e) {
        checks.runpod = `RunPod check failed: ${e instanceof Error ? e.message : e}`;
      }
    }
    const or = await s.get(KEYS.openrouter);
    if (or) {
      const base = (process.env.OPENROUTER_URL ?? "https://openrouter.ai/api/v1").replace(/\/+$/, "");
      try {
        const r = await fetch(`${base}/key`, { headers: { Authorization: `Bearer ${or}` }, signal: AbortSignal.timeout(20_000) });
        const body = (await r.json().catch(() => null)) as { data?: { label?: string; limit_remaining?: number | null }; error?: { message?: string } } | null;
        checks.openrouter = r.ok
          ? `ok${body?.data?.limit_remaining != null ? `: $${body.data.limit_remaining.toFixed(2)} left on the key` : ""}`
          : r.status === 401
            ? "OpenRouter rejected this key"
            : (body?.error?.message ?? `OpenRouter check failed (${r.status})`);
      } catch (e) {
        checks.openrouter = `OpenRouter check failed: ${e instanceof Error ? e.message : e}`;
      }
    }
    this.lastChecks = checks;
    return checks;
  }

  /** Stops the gateway. Running pods keep running at RunPod; nothing meters or stops them until it's back. */
  async stop(): Promise<void> {
    const lock = await this.readLock();
    if (lock) {
      try {
        process.kill(lock.pid);
      } catch {
        // already gone
      }
    }
    await fs.rm(this.lockFile, { force: true });
  }

  async disable(): Promise<void> {
    await this.stop();
    await this.opts.secrets.set(KEYS.enabled, null);
  }

  async addCredits(credits: number): Promise<void> {
    const url = await this.runningUrl();
    const admin = await this.opts.secrets.get(KEYS.admin);
    if (!url || !admin) throw new Error("The local gateway isn't running.");
    if (!(credits > 0 && credits <= 10_000_000)) throw new Error("Enter a positive amount of credits");
    const res = await fetch(`${url}/admin/credits`, {
      method: "POST",
      headers: { Authorization: `Bearer ${admin}`, "Content-Type": "application/json" },
      body: JSON.stringify({ email: LOCAL_EMAIL, credits, note: "Budget added" }),
    });
    if (!res.ok) throw new Error(`Could not add budget (${res.status})`);
  }
}
