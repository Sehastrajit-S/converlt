// Contract between the Converlt IDE and the Converlt Gateway (the Converlt-server repo, which keeps an
// identical copy in src/api.ts: change both together).
// The gateway holds the provider keys (RunPod, OpenRouter) and every user's credit ledger;
// clients only ever hold a Converlt token. All money amounts here are in Converlt credits.

export interface CloudUser {
  id: string;
  email: string;
  name: string;
}

/**
 * Browser sign-in for the IDE. The IDE opens `<gateway>/login?state=…&challenge=…` (PKCE S256),
 * the person approves it there, and the IDE polls `POST /auth/ide/token` with `{ state, verifier,
 * label }`: 202 while waiting, then this, once. `DELETE /v1/session` signs that device out.
 */
export interface IdeTokenResponse {
  /** A device token (cvt_…), used like any Converlt token. */
  token: string;
  user: CloudUser;
}

/** Monthly spend caps the user sets per category. null means no cap. */
export interface SpendLimits {
  gpuMonthly: number | null;
  modelsMonthly: number | null;
}

export interface SpendBreakdown {
  day: number;
  month: number;
}

export interface WalletSummary {
  user: CloudUser;
  /** Spendable credits. Can go slightly negative between metering ticks. */
  balance: number;
  /** How many credits one US dollar buys, so clients can show both. */
  creditsPerUsd: number;
  spend: { gpu: SpendBreakdown; models: SpendBreakdown };
  limits: SpendLimits;
  activePods: number;
  /** Credits per hour currently being spent by running and stopped pods. */
  burnPerHour: number;
}

export type LedgerKind = "grant" | "gpu" | "storage" | "model" | "refund" | "adjust";

export interface LedgerEntry {
  id: number;
  /** Epoch milliseconds. */
  ts: number;
  kind: LedgerKind;
  /** Credits; negative for spend. */
  amount: number;
  description: string;
  ref: string | null;
}

export type CloudType = "SECURE" | "COMMUNITY";
export type StockStatus = "High" | "Medium" | "Low" | "None";

export interface GpuOffer {
  /** Provider GPU type id, e.g. "NVIDIA H100 80GB HBM3". */
  id: string;
  name: string;
  memoryGb: number;
  cloud: CloudType;
  /** Credits per GPU per hour, including Converlt's margin. */
  pricePerHour: number;
  stock: StockStatus | null;
}

export interface LaunchPodRequest {
  gpuTypeId: string;
  cloud: CloudType;
  gpuCount: number;
  name: string;
  image?: string;
  containerDiskGb?: number;
  volumeGb?: number;
  /** OpenSSH public key installed in the pod so Converlt can connect. */
  publicKey: string;
}

export type PodStatus = "starting" | "running" | "stopped" | "terminated" | "error";

export interface CloudPod {
  id: string;
  name: string;
  gpuName: string;
  gpuCount: number;
  cloud: CloudType;
  status: PodStatus;
  /** Credits per hour while running (GPU + disk). */
  pricePerHour: number;
  /** Credits per hour while stopped (volume storage only). */
  storagePerHour: number;
  createdAt: number;
  image: string;
  volumeGb: number;
  /** Present once the pod has a public IP and port 22 is mapped. */
  ssh: { host: string; port: number } | null;
  /** Credits charged for this pod so far. */
  spent: number;
  /** Why the gateway stopped it, e.g. out of credits. */
  statusReason: string | null;
}

export interface ModelInfo {
  id: string;
  name: string;
  contextLength: number;
  /** Credits per million tokens, including Converlt's margin. */
  inputPerMTok: number;
  outputPerMTok: number;
  modality: string;
  description: string;
}

/** Images offered in the launch dialog; any image that runs sshd with $PUBLIC_KEY works. */
export const POD_IMAGES = [
  { id: "runpod/pytorch:2.8.0-py3.11-cuda12.8.1-cudnn-devel-ubuntu22.04", label: "PyTorch 2.8 · CUDA 12.8 · Python 3.11" },
  { id: "runpod/pytorch:2.4.0-py3.11-cuda12.4.1-devel-ubuntu22.04", label: "PyTorch 2.4 · CUDA 12.4 · Python 3.11" },
] as const;

/** Client-side view of the connection to the gateway. */
export interface CloudStatus {
  connected: boolean;
  /** Connected to the gateway this computer runs with the user's own keys. */
  local?: boolean;
  url: string | null;
  user: CloudUser | null;
  error: string | null;
}
