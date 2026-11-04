// HTTP client for the Converlt Gateway, plus the SSH key Converlt installs in cloud pods.
import { execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { CloudPod, GpuOffer, IdeTokenResponse, LaunchPodRequest, LedgerEntry, ModelInfo, SpendLimits, WalletSummary } from "./cloudApi.ts";

/** The hosted Converlt gateway, where Converlt accounts live. */
export const DEFAULT_CLOUD_URL = "https://converlt-server.onrender.com";

export class CloudError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

export class CloudClient {
  readonly url: string;
  private readonly token: string;

  constructor(url: string, token: string) {
    this.url = url.replace(/\/+$/, "");
    this.token = token;
  }

  private async req<T>(method: string, p: string, body?: unknown, timeoutMs = 30_000): Promise<{ data: T; headers: Headers }> {
    let res: Response;
    try {
      res = await fetch(this.url + p, {
        method,
        headers: { Authorization: `Bearer ${this.token}`, ...(body !== undefined ? { "Content-Type": "application/json" } : {}) },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (e) {
      throw new CloudError(`Can't reach Converlt Cloud at ${this.url}: ${e instanceof Error ? e.message : e}`, 0);
    }
    const text = await res.text();
    let json: unknown = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      // not JSON
    }
    if (!res.ok) {
      const msg = (json as { error?: { message?: string } } | null)?.error?.message ?? (text.slice(0, 200) || res.statusText);
      throw new CloudError(res.status === 401 ? "Your Converlt token was rejected. Sign in again." : msg, res.status);
    }
    return { data: json as T, headers: res.headers };
  }

  async me(): Promise<WalletSummary> {
    return (await this.req<WalletSummary>("GET", "/v1/me")).data;
  }
  async ledger(limit = 100): Promise<LedgerEntry[]> {
    return (await this.req<LedgerEntry[]>("GET", `/v1/ledger?limit=${limit}`)).data;
  }
  async setLimits(l: SpendLimits): Promise<WalletSummary> {
    return (await this.req<WalletSummary>("PUT", "/v1/me/limits", l)).data;
  }
  async offers(): Promise<GpuOffer[]> {
    return (await this.req<GpuOffer[]>("GET", "/v1/gpu/offers")).data;
  }
  async pods(): Promise<CloudPod[]> {
    return (await this.req<CloudPod[]>("GET", "/v1/gpu/pods")).data;
  }
  async launch(req: LaunchPodRequest): Promise<CloudPod> {
    return (await this.req<CloudPod>("POST", "/v1/gpu/pods", req, 90_000)).data;
  }
  async stop(id: string): Promise<CloudPod> {
    return (await this.req<CloudPod>("POST", `/v1/gpu/pods/${encodeURIComponent(id)}/stop`, {})).data;
  }
  async start(id: string): Promise<CloudPod> {
    return (await this.req<CloudPod>("POST", `/v1/gpu/pods/${encodeURIComponent(id)}/start`, {})).data;
  }
  async terminate(id: string): Promise<void> {
    await this.req("DELETE", `/v1/gpu/pods/${encodeURIComponent(id)}`);
  }
  async models(): Promise<ModelInfo[]> {
    return (await this.req<{ data: ModelInfo[] }>("GET", "/v1/models")).data.data;
  }

  /** One non-streaming completion. Returns the reply and the credits it cost. */
  async complete(model: string, prompt: string): Promise<{ text: string; credits: number | null; tokens: { input: number; output: number } }> {
    const { data, headers } = await this.req<{ choices?: { message?: { content?: string } }[]; usage?: { prompt_tokens?: number; completion_tokens?: number } }>(
      "POST",
      "/v1/chat/completions",
      { model, messages: [{ role: "user", content: prompt }] },
      180_000,
    );
    const charged = headers.get("x-converlt-credits-charged");
    return {
      text: data.choices?.[0]?.message?.content ?? "",
      credits: charged === null ? null : Number(charged),
      tokens: { input: data.usage?.prompt_tokens ?? 0, output: data.usage?.completion_tokens ?? 0 },
    };
  }

  /** Signs this device out: the gateway revokes its token. */
  async signOut(): Promise<void> {
    await this.req("DELETE", "/v1/session", undefined, 10_000);
  }
}

/** A browser sign-in in progress: open `loginUrl`, check `code` matches the page, then `wait`. */
export interface BrowserSignIn {
  loginUrl: string;
  /** Shown both in the IDE and on the login page, so the person approves the right sign-in. */
  code: string;
  /** Polls the gateway until the browser approves; resolves to the device token. */
  wait(label: string, signal: AbortSignal): Promise<IdeTokenResponse>;
}

const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

/** The code for a login state. The login page computes the same one. */
export function signInCode(state: string): string {
  const d = createHash("sha256").update(state).digest();
  let code = "";
  for (let i = 0; i < 8; i++) code += CODE_ALPHABET[d[i]! % 32];
  return `${code.slice(0, 4)}-${code.slice(4)}`;
}

/**
 * Starts a browser sign-in against `gateway` (PKCE: only this process knows the verifier, so
 * only it can collect the token the browser approves).
 */
export function startBrowserSignIn(gateway: string, opts: { pollMs?: number; timeoutMs?: number } = {}): BrowserSignIn {
  const base = gateway.replace(/\/+$/, "");
  const state = randomBytes(32).toString("base64url");
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const pollMs = opts.pollMs ?? 2000;
  const timeoutMs = opts.timeoutMs ?? 10 * 60_000;
  return {
    loginUrl: `${base}/login?${new URLSearchParams({ state, challenge })}`,
    code: signInCode(state),
    async wait(label, signal) {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        if (signal.aborted) throw new CloudError("Sign-in cancelled", 0);
        let res: Response | null = null;
        try {
          res = await fetch(`${base}/auth/ide/token`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ state, verifier, label }),
            signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]),
          });
        } catch (e) {
          if (signal.aborted) throw new CloudError("Sign-in cancelled", 0);
          // A network blip or a cold-starting gateway: keep polling until the deadline.
        }
        if (res && res.status === 200) return (await res.json()) as IdeTokenResponse;
        if (res && res.status !== 202 && res.status < 500) {
          const j = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
          throw new CloudError(j?.error?.message ?? `Sign-in failed (${res.status})`, res.status);
        }
        await new Promise<void>((r) => {
          const t = setTimeout(r, pollMs);
          signal.addEventListener("abort", () => (clearTimeout(t), r()), { once: true });
        });
      }
      throw new CloudError("Sign-in timed out. Try again.", 0);
    },
  };
}

/** Converlt's own SSH key for cloud pods, created on first use (~/.ssh/converlt_ed25519). */
export async function ensureCloudKey(): Promise<{ privateKey: string; publicKey: string }> {
  const dir = path.join(os.homedir(), ".ssh");
  const privateKey = path.join(dir, "converlt_ed25519");
  await fs.mkdir(path.join(dir, "converlt"), { recursive: true });
  try {
    return { privateKey, publicKey: (await fs.readFile(privateKey + ".pub", "utf8")).trim() };
  } catch {
    await new Promise<void>((resolve, reject) =>
      execFile("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-C", "converlt", "-f", privateKey], { windowsHide: true }, (err, _o, stderr) =>
        err ? reject(new Error(`Could not create an SSH key with ssh-keygen: ${stderr || err.message}`)) : resolve(),
      ),
    );
    return { privateKey, publicKey: (await fs.readFile(privateKey + ".pub", "utf8")).trim() };
  }
}
