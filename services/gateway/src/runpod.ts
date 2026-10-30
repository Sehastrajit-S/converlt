// RunPod: GPU price list (GraphQL) and the pod lifecycle (REST v1).
import type { CloudType, StockStatus } from "@converge/core/cloud";

export interface RunpodGpuType {
  id: string;
  displayName: string;
  memoryInGb: number;
  /** USD per GPU-hour, on-demand (not spot); null when not offered in that cloud. */
  secure: { price: number; stock: StockStatus | null } | null;
  community: { price: number; stock: StockStatus | null } | null;
}

export interface RunpodPod {
  id: string;
  name: string;
  desiredStatus: "RUNNING" | "EXITED" | "TERMINATED";
  publicIp: string | null;
  portMappings: Record<string, number> | null;
  /** USD per hour for the GPUs. */
  costPerHr: number | null;
}

export interface CreatePodInput {
  name: string;
  imageName: string;
  gpuTypeId: string;
  gpuCount: number;
  cloudType: CloudType;
  containerDiskInGb: number;
  volumeInGb: number;
  env: Record<string, string>;
}

export class RunpodError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

const GPU_TYPES_QUERY = `query GpuTypes {
  gpuTypes {
    id
    displayName
    memoryInGb
    secureCloud
    communityCloud
    secure: lowestPrice(input: { gpuCount: 1, secureCloud: true }) { uninterruptablePrice stockStatus }
    community: lowestPrice(input: { gpuCount: 1, secureCloud: false }) { uninterruptablePrice stockStatus }
  }
}`;

type PriceNode = { uninterruptablePrice?: number | null; stockStatus?: string | null } | null | undefined;

function price(node: PriceNode, offered: unknown): RunpodGpuType["secure"] {
  if (offered === false || !node || typeof node.uninterruptablePrice !== "number" || node.uninterruptablePrice <= 0) return null;
  const s = node.stockStatus;
  return { price: node.uninterruptablePrice, stock: s === "High" || s === "Medium" || s === "Low" || s === "None" ? s : null };
}

export class Runpod {
  private readonly key: string;
  private readonly restUrl: string;
  private readonly graphqlUrl: string;

  constructor(key: string, restUrl: string, graphqlUrl: string) {
    this.key = key;
    this.restUrl = restUrl.replace(/\/$/, "");
    this.graphqlUrl = graphqlUrl;
  }

  get configured(): boolean {
    return !!this.key;
  }

  private async rest<T>(method: string, path: string, body?: unknown): Promise<T> {
    if (!this.key) throw new RunpodError("GPU provider is not configured on this gateway (RUNPOD_API_KEY).", 503);
    const res = await fetch(this.restUrl + path, {
      method,
      headers: { Authorization: `Bearer ${this.key}`, ...(body ? { "Content-Type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(30_000),
    });
    const text = await res.text();
    if (!res.ok) {
      let msg = text;
      try {
        const j = JSON.parse(text);
        msg = j.error ?? j.message ?? text;
      } catch {
        // not JSON
      }
      throw new RunpodError(`RunPod ${method} ${path} failed (${res.status}): ${String(msg).slice(0, 300)}`, res.status);
    }
    return (text ? JSON.parse(text) : null) as T;
  }

  async gpuTypes(): Promise<RunpodGpuType[]> {
    if (!this.key) throw new RunpodError("GPU provider is not configured on this gateway (RUNPOD_API_KEY).", 503);
    const res = await fetch(`${this.graphqlUrl}?api_key=${encodeURIComponent(this.key)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query: GPU_TYPES_QUERY }),
      signal: AbortSignal.timeout(30_000),
    });
    const j = (await res.json().catch(() => null)) as { data?: { gpuTypes?: unknown[] }; errors?: { message: string }[] } | null;
    if (!res.ok || !j?.data?.gpuTypes) throw new RunpodError(`RunPod GPU list failed (${res.status}): ${j?.errors?.map((e) => e.message).join("; ") ?? "no data"}`, res.status || 502);
    return j.data.gpuTypes
      .map((g) => g as Record<string, any>)
      .filter((g) => typeof g.id === "string" && g.id !== "unknown")
      .map((g) => ({
        id: g.id,
        displayName: String(g.displayName ?? g.id),
        memoryInGb: Number(g.memoryInGb ?? 0),
        secure: price(g.secure, g.secureCloud),
        community: price(g.community, g.communityCloud),
      }));
  }

  createPod(input: CreatePodInput): Promise<RunpodPod> {
    return this.rest<RunpodPod>("POST", "/pods", {
      name: input.name,
      imageName: input.imageName,
      gpuTypeIds: [input.gpuTypeId],
      gpuCount: input.gpuCount,
      cloudType: input.cloudType,
      computeType: "GPU",
      containerDiskInGb: input.containerDiskInGb,
      volumeInGb: input.volumeInGb,
      volumeMountPath: "/workspace",
      ports: ["22/tcp"],
      // Community hosts only get a public IP (needed for SSH) when asked.
      ...(input.cloudType === "COMMUNITY" ? { supportPublicIp: true } : {}),
      env: input.env,
    });
  }

  /** null when the pod no longer exists at the provider. */
  async getPod(id: string): Promise<RunpodPod | null> {
    try {
      return await this.rest<RunpodPod>("GET", `/pods/${encodeURIComponent(id)}`);
    } catch (e) {
      if (e instanceof RunpodError && e.status === 404) return null;
      throw e;
    }
  }

  async stopPod(id: string): Promise<void> {
    await this.rest("POST", `/pods/${encodeURIComponent(id)}/stop`);
  }

  async startPod(id: string): Promise<void> {
    await this.rest("POST", `/pods/${encodeURIComponent(id)}/start`);
  }

  async deletePod(id: string): Promise<void> {
    try {
      await this.rest("DELETE", `/pods/${encodeURIComponent(id)}`);
    } catch (e) {
      if (!(e instanceof RunpodError && e.status === 404)) throw e;
    }
  }
}
