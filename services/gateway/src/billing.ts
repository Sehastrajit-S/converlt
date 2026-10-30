// Pricing, launch checks, metering and enforcement. GPU time is charged from pod creation (that
// is when the provider starts billing) in small increments by the meter; stopped pods keep
// paying for their volume. When a balance or a monthly cap runs out, running pods are stopped.
import { randomUUID } from "node:crypto";
import type { CloudPod, GpuOffer, LaunchPodRequest, ModelInfo, PodStatus, WalletSummary } from "@converge/core/cloud";
import { POD_IMAGES } from "@converge/core/cloud";
import type { Config } from "./config.ts";
import { fromMicro, toMicro, type PodRow, type Store, type UserRow } from "./db.ts";
import { usageCostUsd, type OpenRouter, type OpenRouterModel } from "./openrouter.ts";
import type { Runpod, RunpodPod } from "./runpod.ts";

export class BillingError extends Error {
  readonly status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
  }
}

const HOURS_PER_MONTH = 730;
const startOfUtcDay = (now: number) => {
  const d = new Date(now);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
};
const startOfUtcMonth = (now: number) => {
  const d = new Date(now);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
};

export class Billing {
  private readonly cfg: Config;
  private readonly store: Store;
  private readonly runpod: Runpod;
  private readonly openrouter: OpenRouter;
  private offersCache: { at: number; offers: GpuOffer[] } | null = null;

  constructor(cfg: Config, store: Store, runpod: Runpod, openrouter: OpenRouter) {
    this.cfg = cfg;
    this.store = store;
    this.runpod = runpod;
    this.openrouter = openrouter;
  }

  private usdToMicro(usd: number, markup: number): number {
    return toMicro(usd * markup * this.cfg.creditsPerUsd);
  }

  // ------------------------------------------------------------ wallet

  wallet(user: UserRow, now = Date.now()): WalletSummary {
    const s = this.store;
    const pods = s.userPods(user.id);
    const burn = pods.reduce((sum, p) => sum + (p.status === "running" || p.status === "starting" ? p.rate_running : p.status === "stopped" ? p.rate_stopped : 0), 0);
    const day = startOfUtcDay(now);
    const month = startOfUtcMonth(now);
    return {
      user: { id: user.id, email: user.email, name: user.name },
      balance: fromMicro(s.balanceMicro(user.id)),
      creditsPerUsd: this.cfg.creditsPerUsd,
      spend: {
        gpu: { day: fromMicro(s.spentSince(user.id, ["gpu", "storage"], day)), month: fromMicro(s.spentSince(user.id, ["gpu", "storage"], month)) },
        models: { day: fromMicro(s.spentSince(user.id, ["model"], day)), month: fromMicro(s.spentSince(user.id, ["model"], month)) },
      },
      limits: s.limits(user),
      activePods: pods.filter((p) => p.status === "running" || p.status === "starting").length,
      burnPerHour: fromMicro(burn),
    };
  }

  /** Why the user can't spend on this category right now, or null if they can. */
  private blocker(user: UserRow, kind: "gpu" | "models", now = Date.now()): string | null {
    if (this.store.balanceMicro(user.id) <= 0) return "Out of credits. Add credits to continue.";
    const cap = kind === "gpu" ? user.gpu_monthly_cap : user.models_monthly_cap;
    if (cap !== null) {
      const spent = this.store.spentSince(user.id, kind === "gpu" ? ["gpu", "storage"] : ["model"], startOfUtcMonth(now));
      if (spent >= cap) return `Your monthly ${kind === "gpu" ? "GPU" : "model"} limit is used up. Raise it in your wallet to continue.`;
    }
    return null;
  }

  // ------------------------------------------------------------ GPUs

  async offers(): Promise<GpuOffer[]> {
    if (this.offersCache && Date.now() - this.offersCache.at < 60_000) return this.offersCache.offers;
    const types = await this.runpod.gpuTypes();
    const offers: GpuOffer[] = [];
    for (const t of types) {
      for (const [cloud, p] of [["SECURE", t.secure], ["COMMUNITY", t.community]] as const) {
        if (!p) continue;
        offers.push({ id: t.id, name: t.displayName, memoryGb: t.memoryInGb, cloud, pricePerHour: fromMicro(this.usdToMicro(p.price, this.cfg.gpuMarkup)), stock: p.stock });
      }
    }
    offers.sort((a, b) => a.pricePerHour - b.pricePerHour);
    this.offersCache = { at: Date.now(), offers };
    return offers;
  }

  private storageRates(volumeGb: number, containerGb: number): { running: number; stopped: number } {
    const c = this.cfg;
    return {
      running: this.usdToMicro(((volumeGb + containerGb) * c.storageRunningUsdPerGbMonth) / HOURS_PER_MONTH, c.gpuMarkup),
      stopped: this.usdToMicro((volumeGb * c.storageStoppedUsdPerGbMonth) / HOURS_PER_MONTH, c.gpuMarkup),
    };
  }

  async launch(user: UserRow, req: LaunchPodRequest): Promise<CloudPod> {
    const blocked = this.blocker(user, "gpu");
    if (blocked) throw new BillingError(blocked, 402);
    const gpuCount = Math.trunc(req.gpuCount);
    if (!(gpuCount >= 1 && gpuCount <= 8)) throw new BillingError("GPU count must be 1 to 8");
    if (req.cloud !== "SECURE" && req.cloud !== "COMMUNITY") throw new BillingError("Unknown cloud type");
    if (!/^(ssh-ed25519|ssh-rsa|ecdsa-sha2-[\w-]+) [A-Za-z0-9+/=]+( [^\r\n]*)?$/.test(req.publicKey.trim())) throw new BillingError("Invalid SSH public key");
    const image = req.image?.trim() || POD_IMAGES[0].id;
    if (!/^[\w./:@-]+$/.test(image)) throw new BillingError("Invalid image name");
    const volumeGb = Math.max(0, Math.min(2000, Math.trunc(req.volumeGb ?? 50)));
    const containerGb = Math.max(10, Math.min(500, Math.trunc(req.containerDiskGb ?? 40)));
    const name = (req.name || "converlt-pod").replace(/[^\w .-]/g, "").slice(0, 60) || "converlt-pod";

    const offer = (await this.offers()).find((o) => o.id === req.gpuTypeId && o.cloud === req.cloud);
    if (!offer) throw new BillingError("That GPU isn't offered in this cloud right now");
    const storage = this.storageRates(volumeGb, containerGb);
    const estimate = toMicro(offer.pricePerHour) * gpuCount + storage.running;
    const balance = this.store.balanceMicro(user.id);
    if (balance < estimate * this.cfg.minLaunchHours)
      throw new BillingError(`Not enough credits: this pod costs ${fromMicro(estimate).toFixed(2)} credits/hour and launching needs at least ${this.cfg.minLaunchHours} hour(s) of balance.`, 402);

    const created = await this.runpod.createPod({
      name,
      imageName: image,
      gpuTypeId: req.gpuTypeId,
      gpuCount,
      cloudType: req.cloud,
      containerDiskInGb: containerGb,
      volumeInGb: volumeGb,
      env: { PUBLIC_KEY: req.publicKey.trim() },
    });
    // Bill what the provider actually charges for this pod when it says so.
    const gpuRate = typeof created.costPerHr === "number" && created.costPerHr > 0 ? this.usdToMicro(created.costPerHr, this.cfg.gpuMarkup) : toMicro(offer.pricePerHour) * gpuCount;
    const now = Date.now();
    const row: PodRow = {
      id: randomUUID(),
      user_id: user.id,
      provider_id: created.id,
      name,
      gpu_name: offer.name,
      gpu_count: gpuCount,
      cloud: req.cloud,
      image,
      volume_gb: volumeGb,
      container_disk_gb: containerGb,
      rate_running: gpuRate + storage.running,
      rate_stopped: storage.stopped,
      status: "starting",
      status_reason: null,
      ...sshOf(created),
      created_at: now,
      last_billed_at: now,
      spent: 0,
    };
    this.store.insertPod(row);
    return this.view(row);
  }

  view(p: PodRow): CloudPod {
    return {
      id: p.id,
      name: p.name,
      gpuName: p.gpu_name,
      gpuCount: p.gpu_count,
      cloud: p.cloud,
      status: p.status,
      pricePerHour: fromMicro(p.rate_running),
      storagePerHour: fromMicro(p.rate_stopped),
      createdAt: p.created_at,
      image: p.image,
      volumeGb: p.volume_gb,
      ssh: p.ssh_host && p.ssh_port ? { host: p.ssh_host, port: p.ssh_port } : null,
      spent: fromMicro(p.spent),
      statusReason: p.status_reason,
    };
  }

  ownedPod(user: UserRow, id: string): PodRow {
    const p = this.store.pod(id);
    if (!p || p.user_id !== user.id) throw new BillingError("Pod not found", 404);
    return p;
  }

  async stop(user: UserRow, id: string): Promise<CloudPod> {
    const p = this.ownedPod(user, id);
    if (p.status === "terminated") throw new BillingError("Pod is terminated");
    this.chargePod(p, Date.now());
    await this.runpod.stopPod(p.provider_id);
    this.store.updatePod(p.id, { status: "stopped", status_reason: "Stopped by you", ssh_host: null, ssh_port: null });
    return this.view(this.store.pod(p.id)!);
  }

  async start(user: UserRow, id: string): Promise<CloudPod> {
    const p = this.ownedPod(user, id);
    if (p.status !== "stopped") throw new BillingError("Only a stopped pod can be started");
    const blocked = this.blocker(user, "gpu");
    if (blocked) throw new BillingError(blocked, 402);
    this.chargePod(p, Date.now());
    await this.runpod.startPod(p.provider_id);
    this.store.updatePod(p.id, { status: "starting", status_reason: null });
    return this.view(this.store.pod(p.id)!);
  }

  async terminate(user: UserRow, id: string): Promise<void> {
    const p = this.ownedPod(user, id);
    if (p.status === "terminated") return;
    this.chargePod(p, Date.now());
    await this.runpod.deletePod(p.provider_id);
    this.store.updatePod(p.id, { status: "terminated", status_reason: "Terminated by you", ssh_host: null, ssh_port: null });
  }

  /** Charges the pod for the time since it was last billed, at its current state's rate. */
  private chargePod(p: PodRow, now: number): void {
    const hours = Math.max(0, now - p.last_billed_at) / 3_600_000;
    const rate = p.status === "running" || p.status === "starting" ? p.rate_running : p.status === "stopped" ? p.rate_stopped : 0;
    const amount = Math.round(rate * hours);
    this.store.tx(() => {
      if (amount > 0) this.store.addEntry(p.user_id, p.status === "stopped" ? "storage" : "gpu", -amount, `${p.status === "stopped" ? "Storage" : "GPU"}: ${p.name} (${p.gpu_count}× ${p.gpu_name})`, p.id, now);
      this.store.updatePod(p.id, { last_billed_at: now, spent: p.spent + amount });
    });
    p.last_billed_at = now;
    p.spent += amount;
  }

  /** One metering pass: refresh state from the provider, charge, and enforce balances and caps. */
  async meter(now = Date.now()): Promise<void> {
    for (const p of this.store.livePods()) {
      try {
        // Charge at the state the pod was in during the interval, then learn its new state.
        this.chargePod(p, now);
        await this.syncPod(p);
        if (p.status !== "running" && p.status !== "starting") continue;
        const user = this.store.listUsers().find((u) => u.id === p.user_id);
        const reason = user ? this.blocker(user, "gpu", now) : "Unknown user";
        if (reason) {
          await this.runpod.stopPod(p.provider_id);
          this.store.updatePod(p.id, { status: "stopped", status_reason: reason, ssh_host: null, ssh_port: null });
        }
      } catch (e) {
        console.error(`meter: pod ${p.id}:`, e instanceof Error ? e.message : e);
      }
    }
  }

  private async syncPod(p: PodRow): Promise<void> {
    const remote = await this.runpod.getPod(p.provider_id);
    let status: PodStatus;
    if (!remote || remote.desiredStatus === "TERMINATED") status = "terminated";
    else if (remote.desiredStatus === "EXITED") status = "stopped";
    else status = sshOf(remote).ssh_host ? "running" : "starting";
    const ssh = remote ? sshOf(remote) : { ssh_host: null, ssh_port: null };
    if (status !== p.status || ssh.ssh_host !== p.ssh_host || ssh.ssh_port !== p.ssh_port) {
      const reason = status === "terminated" && p.status !== "terminated" ? (p.status_reason ?? "Terminated at the provider") : status === p.status ? p.status_reason : status === "stopped" ? (p.status_reason ?? "Stopped at the provider") : null;
      this.store.updatePod(p.id, { status, status_reason: reason, ...ssh });
      p.status = status;
      p.status_reason = reason;
      p.ssh_host = ssh.ssh_host;
      p.ssh_port = ssh.ssh_port;
    }
  }

  // ------------------------------------------------------------ models

  async models(): Promise<ModelInfo[]> {
    const perM = (usdPerToken: string) => fromMicro(this.usdToMicro(Number(usdPerToken) * 1_000_000, this.cfg.modelMarkup));
    return (await this.openrouter.models())
      .filter((m) => Number(m.pricing.prompt) >= 0 && Number(m.pricing.completion) >= 0)
      .map((m) => ({
        id: m.id,
        name: m.name,
        contextLength: m.context_length,
        inputPerMTok: perM(m.pricing.prompt),
        outputPerMTok: perM(m.pricing.completion),
        modality: m.architecture?.modality ?? "text->text",
        description: (m.description ?? "").slice(0, 400),
      }));
  }

  assertCanUseModels(user: UserRow): void {
    const blocked = this.blocker(user, "models");
    if (blocked) throw new BillingError(blocked, 402);
  }

  async chargeCompletion(user: UserRow, modelId: string, usage: unknown, generationId: string | null): Promise<number> {
    const model = (await this.openrouter.models().catch(() => [] as OpenRouterModel[])).find((m) => m.id === modelId);
    const micro = this.usdToMicro(usageCostUsd(usage, model), this.cfg.modelMarkup);
    const u = (usage ?? {}) as { prompt_tokens?: number; completion_tokens?: number };
    if (micro > 0) this.store.addEntry(user.id, "model", -micro, `Model: ${modelId} (${u.prompt_tokens ?? 0} in / ${u.completion_tokens ?? 0} out tokens)`, generationId);
    return fromMicro(micro);
  }
}

function sshOf(p: RunpodPod): { ssh_host: string | null; ssh_port: number | null } {
  const port = p.portMappings?.["22"];
  return p.publicIp && port ? { ssh_host: p.publicIp, ssh_port: Number(port) } : { ssh_host: null, ssh_port: null };
}
