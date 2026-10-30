// HTTP client for the Converlt Gateway, plus the SSH key Converlt installs in cloud pods.
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { CloudPod, GpuOffer, LaunchPodRequest, LedgerEntry, ModelInfo, SpendLimits, WalletSummary } from "./cloudApi.ts";

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
