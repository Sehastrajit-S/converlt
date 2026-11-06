import { useEffect, useMemo, useState } from "react";
import { Boxes, Clock, Cpu, LoaderCircle, Play, Power, Rocket, Search, Server, ShieldCheck, Square, Terminal, Trash2, Users } from "lucide-react";
import type { RunOptions } from "@converge/run-protocol";
import type { AppState, CloudPodView } from "@converge/core/api";
import { POD_IMAGES, type CloudType, type GpuOffer, type WalletSummary } from "@converge/core/cloud";
import { api, errorMessage, ask } from "../api.ts";
import { creditsUsd, formatCredits, formatHours, TIER, usePods } from "../cloud.ts";
import { Dialog, Segmented, Switch, useToast } from "../components/ui.tsx";
import { CloudGate } from "./Wallet.tsx";

export interface GpuActions {
  /** Launch a run on this machine. */
  onRun: (machineId: string) => void;
  onEnvironments: (machineId: string) => void;
}

/** Open the launch dialog for this offer, optionally with a run to start once the pod is up. */
export interface GpuPreselect {
  offerId: string;
  cloud: CloudType;
  thenRun?: ThenRun;
}
type ThenRun = { command: string; options: RunOptions };

export function Gpus({ state, preselect, ...actions }: { state: AppState; preselect?: GpuPreselect | null } & GpuActions) {
  return <CloudGate>{(w, reload) => <GpusBody state={state} wallet={w} reloadWallet={reload} preselect={preselect ?? null} {...actions} />}</CloudGate>;
}

type VramFilter = "any" | "24" | "48" | "80";
type CloudFilter = "all" | CloudType;

function GpusBody({ state, wallet, reloadWallet, preselect, onRun, onEnvironments }: { state: AppState; wallet: WalletSummary; reloadWallet: () => Promise<void>; preselect: GpuPreselect | null } & GpuActions) {
  const pods = usePods(true);
  const [offers, setOffers] = useState<GpuOffer[] | null>(null);
  const [offersError, setOffersError] = useState<string | null>(null);
  const [cloud, setCloud] = useState<CloudFilter>("all");
  const [vram, setVram] = useState<VramFilter>("any");
  const [query, setQuery] = useState("");
  const [launch, setLaunch] = useState<GpuOffer | null>(null);
  const [thenRun, setThenRun] = useState<ThenRun | null>(null);

  useEffect(() => {
    api.gpuOffers().then(setOffers, (e) => setOffersError(errorMessage(e)));
  }, []);

  useEffect(() => {
    if (!offers || !preselect) return;
    const o = offers.find((x) => x.id === preselect.offerId && x.cloud === preselect.cloud) ?? offers.find((x) => x.id === preselect.offerId);
    if (!o) return;
    setLaunch(o);
    setThenRun(preselect.thenRun ?? null);
  }, [offers, preselect]);

  // One card per GPU model, with its Secure and Community prices side by side.
  const groups = useMemo(() => {
    const q = query.trim().toLowerCase();
    const byGpu = new Map<string, { name: string; memoryGb: number; offers: GpuOffer[] }>();
    for (const o of offers ?? []) {
      if (cloud !== "all" && o.cloud !== cloud) continue;
      if (vram !== "any" && o.memoryGb < Number(vram)) continue;
      if (q && !o.name.toLowerCase().includes(q) && !o.id.toLowerCase().includes(q)) continue;
      const g = byGpu.get(o.id) ?? { name: o.name, memoryGb: o.memoryGb, offers: [] };
      g.offers.push(o);
      byGpu.set(o.id, g);
    }
    return [...byGpu.entries()].map(([id, g]) => ({ id, ...g, cheapest: Math.min(...g.offers.map((o) => o.pricePerHour)) })).sort((a, b) => a.cheapest - b.cheapest);
  }, [offers, cloud, vram, query]);

  const active = (pods.data ?? []).filter((p) => p.status !== "terminated");

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h1 className="page-title">GPUs</h1>
          <div className="page-sub">On-demand GPUs billed from your credits. Each pod becomes a Converlt machine: run on it, manage its environments, stop it when you're done.</div>
        </div>
        <div className="spacer" />
        <div className="balance-chip">
          <span className="faint">Balance</span> <b className="tabular">{formatCredits(wallet.balance)}</b>
        </div>
      </div>

      {active.length > 0 && (
        <>
          <div className="section-title" style={{ marginTop: 0 }}>
            Your pods
          </div>
          <div className="pods">
            {active.map((p) => (
              <PodCard
                key={p.id}
                pod={p}
                probe={p.machineId ? state.probes[p.machineId] : undefined}
                onRun={onRun}
                onEnvironments={onEnvironments}
                onChanged={async () => {
                  await pods.reload();
                  await reloadWallet();
                }}
              />
            ))}
          </div>
        </>
      )}

      <div className="section-title" style={{ marginTop: active.length ? 26 : 0 }}>
        Launch a GPU
      </div>
      <div className="toolbar">
        <Segmented<CloudFilter>
          value={cloud}
          onChange={setCloud}
          options={[
            { value: "all", label: "All tiers" },
            { value: "SECURE", label: TIER.SECURE.short },
            { value: "COMMUNITY", label: TIER.COMMUNITY.short },
          ]}
        />
        <Segmented<VramFilter>
          value={vram}
          onChange={setVram}
          options={[
            { value: "any", label: "Any VRAM" },
            { value: "24", label: "24 GB+" },
            { value: "48", label: "48 GB+" },
            { value: "80", label: "80 GB+" },
          ]}
        />
        <div className="spacer" />
        <div className="search">
          <Search size={14} />
          <input className="input" placeholder="H100, A100, 4090…" value={query} onChange={(e) => setQuery(e.target.value)} />
        </div>
      </div>

      {offersError ? (
        <div className="callout err">{offersError}</div>
      ) : !offers ? (
        <div className="empty">
          <LoaderCircle className="spin" />
        </div>
      ) : groups.length === 0 ? (
        <div className="empty faint">No GPUs match these filters.</div>
      ) : (
        <div className="gpu-grid">
          {groups.map((g) => (
            <div key={g.id} className="card gpu-card">
              <div className="gpu-card-top">
                <div className="gpu-chip">
                  <Cpu size={16} />
                </div>
                <div style={{ minWidth: 0 }}>
                  <div className="gpu-name truncate" title={g.id}>
                    {g.name}
                  </div>
                  <div className="faint" style={{ fontSize: 12 }}>
                    {g.memoryGb} GB VRAM
                  </div>
                </div>
              </div>
              {g.offers
                .sort((a, b) => (a.cloud === "SECURE" ? -1 : 1) - (b.cloud === "SECURE" ? -1 : 1))
                .map((o) => (
                  <div key={o.cloud} className="offer-row">
                    <span className="offer-cloud" title={TIER[o.cloud].note}>
                      {o.cloud === "SECURE" ? <ShieldCheck size={13} /> : <Users size={13} />}
                      {TIER[o.cloud].short}
                    </span>
                    <StockDot stock={o.stock} />
                    <span className="spacer" />
                    <span className="offer-price tabular">
                      {formatCredits(o.pricePerHour)}
                      <small>/hr</small>
                    </span>
                    <button className="btn primary sm" disabled={o.stock === "None" || wallet.balance < o.pricePerHour} onClick={() => setLaunch(o)} title={wallet.balance < o.pricePerHour ? "Not enough credits" : undefined}>
                      Launch
                    </button>
                  </div>
                ))}
              <div className="gpu-card-foot faint">
                ≈ {creditsUsd(g.cheapest, wallet.creditsPerUsd)}/hr · your balance buys {formatHours(wallet.balance / g.cheapest)}
              </div>
            </div>
          ))}
        </div>
      )}

      {launch && (
        <LaunchDialog
          offer={launch}
          wallet={wallet}
          thenRun={thenRun}
          onClose={() => {
            setLaunch(null);
            setThenRun(null);
          }}
          onLaunched={async () => {
            setLaunch(null);
            setThenRun(null);
            await pods.reload();
            await reloadWallet();
          }}
        />
      )}
    </div>
  );
}

function StockDot({ stock }: { stock: GpuOffer["stock"] }) {
  if (!stock) return null;
  const cls = stock === "High" ? "ok" : stock === "Medium" ? "warn" : stock === "Low" ? "warn" : "err";
  return (
    <span className="stock" title={`Availability: ${stock}`}>
      <span className={`health ${cls}`} style={{ width: 6, height: 6 }} /> {stock === "None" ? "Sold out" : stock}
    </span>
  );
}

function uptime(since: number): string {
  return formatHours((Date.now() - since) / 3_600_000);
}

function PodCard({
  pod,
  probe,
  onRun,
  onEnvironments,
  onChanged,
}: {
  pod: CloudPodView;
  probe: AppState["probes"][string] | undefined;
  onChanged: () => Promise<void>;
} & GpuActions) {
  const toast = useToast();
  const [busy, setBusy] = useState<string | null>(null);
  const act = async (label: string, fn: () => Promise<void>) => {
    setBusy(label);
    try {
      await fn();
      await onChanged();
    } catch (e) {
      toast("error", `${label} failed`, errorMessage(e));
    } finally {
      setBusy(null);
    }
  };
  const ready = pod.status === "running" && pod.machineId && probe?.ok;
  const stage =
    pod.status === "starting"
      ? "Starting: pulling the image and booting"
      : pod.status === "running" && !pod.machineId
        ? "Waiting for SSH"
        : pod.status === "running" && !probe
          ? "Installing the Converlt agent"
          : pod.status === "running" && probe && !probe.ok
            ? probe.error ?? "Not reachable yet"
            : pod.status === "stopped"
              ? (pod.statusReason ?? "Stopped")
              : null;

  return (
    <div className={`card pod-card ${pod.status}`}>
      <div className="pod-top">
        <div className={`pod-state ${pod.status}`}>{pod.status === "starting" ? <LoaderCircle size={15} className="spin" /> : <Server size={15} />}</div>
        <div style={{ minWidth: 0, flex: 1 }}>
          <div className="row" style={{ gap: 8 }}>
            <b className="truncate">{pod.name}</b>
            <span className={`pod-pill ${pod.status}`}>{pod.status}</span>
          </div>
          <div className="faint truncate" style={{ fontSize: 12, marginTop: 2 }}>
            {pod.gpuCount > 1 ? `${pod.gpuCount}× ` : ""}
            {pod.gpuName} · {TIER[pod.cloud].name} · {POD_IMAGES.find((i) => i.id === pod.image)?.label ?? pod.image}
          </div>
        </div>
      </div>
      <div className="pod-stats">
        <div>
          <span className="faint">Rate</span>
          <b className="tabular">{formatCredits(pod.status === "stopped" ? pod.storagePerHour : pod.pricePerHour)}/hr</b>
        </div>
        <div>
          <span className="faint">Spent</span>
          <b className="tabular">{formatCredits(pod.spent)}</b>
        </div>
        <div>
          <span className="faint">
            <Clock size={11} /> Age
          </span>
          <b>{uptime(pod.createdAt)}</b>
        </div>
      </div>
      {pod.ssh && (
        <div className="pod-ssh mono">
          <Terminal size={12} /> root@{pod.ssh.host} -p {pod.ssh.port}
        </div>
      )}
      {stage && (
        <div className={`pod-stage ${pod.status === "stopped" ? "" : "live"}`}>
          {pod.status !== "stopped" && <LoaderCircle size={12} className="spin" />} {stage}
        </div>
      )}
      <div className="pod-actions">
        {pod.status === "running" && (
          <>
            <button className="btn primary sm" disabled={!ready} onClick={() => pod.machineId && onRun(pod.machineId)} title={ready ? "Launch a training run on this pod" : "Available once the agent is installed"}>
              <Rocket size={13} /> Run here
            </button>
            <button className="btn sm" disabled={!pod.machineId} onClick={() => pod.machineId && onEnvironments(pod.machineId)}>
              <Boxes size={13} /> Environments
            </button>
          </>
        )}
        <span className="spacer" />
        {pod.status === "stopped" ? (
          <button className="btn sm" disabled={!!busy} onClick={() => act("Start", () => api.gpuStart(pod.id))}>
            {busy === "Start" ? <LoaderCircle size={13} className="spin" /> : <Play size={13} />} Start
          </button>
        ) : (
          <button className="btn sm" disabled={!!busy} onClick={() => act("Stop", () => api.gpuStop(pod.id))} title="Stops GPU billing; the volume is kept (small storage charge)">
            {busy === "Stop" ? <LoaderCircle size={13} className="spin" /> : <Square size={12} />} Stop
          </button>
        )}
        <button
          className="btn ghost sm icon"
          disabled={!!busy}
          title="Terminate: deletes the pod and its volume"
          onClick={async () => (await ask(`Terminate ${pod.name}? The pod and its /workspace volume are deleted. Billing stops.`, "Terminate")) && act("Terminate", () => api.gpuTerminate(pod.id))}
        >
          {busy === "Terminate" ? <LoaderCircle size={13} className="spin" /> : <Trash2 size={14} />}
        </button>
      </div>
    </div>
  );
}

function LaunchDialog({ offer, wallet, thenRun, onClose, onLaunched }: { offer: GpuOffer; wallet: WalletSummary; thenRun: ThenRun | null; onClose: () => void; onLaunched: () => Promise<void> }) {
  const toast = useToast();
  const [runAfter, setRunAfter] = useState(!!thenRun);
  const [count, setCount] = useState<"1" | "2" | "4" | "8">("1");
  const [image, setImage] = useState<string>(POD_IMAGES[0].id);
  const [customImage, setCustomImage] = useState("");
  const [volume, setVolume] = useState("50");
  const [disk, setDisk] = useState("40");
  const [name, setName] = useState(`${offer.name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-${new Date().toISOString().slice(5, 10)}`);
  const [idle, setIdle] = useState<"15" | "30" | "60" | "120" | "0">("30");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const n = Number(count);
  const perHour = offer.pricePerHour * n;
  const enough = wallet.balance >= perHour;

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const run = runAfter && thenRun ? thenRun : undefined;
      await api.gpuLaunch({ gpuTypeId: offer.id, cloud: offer.cloud, gpuCount: n, name, image: image === "custom" ? customImage.trim() : image, volumeGb: Number(volume) || 0, containerDiskGb: Number(disk) || 40, idleStopMinutes: Number(idle), thenRun: run });
      toast(
        "success",
        `${name} is starting`,
        run ? "The run starts on it by itself once the pod is reachable, usually in 1–3 minutes. Keep the editor open until then." : "It appears as a Converlt machine once SSH is up, usually in 1–3 minutes.",
      );
      await onLaunched();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      title={`Launch ${offer.name}`}
      icon={<Rocket size={16} />}
      onClose={onClose}
      footer={
        <>
          <span className="faint" style={{ fontSize: 12, marginRight: "auto" }}>
            Billed per second from launch until you stop or terminate it.
          </span>
          <button className="btn ghost" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" disabled={busy || !enough || !name.trim() || (image === "custom" && !customImage.trim())} onClick={() => void submit()}>
            {busy ? <LoaderCircle size={14} className="spin" /> : <Power size={14} />} Launch pod
          </button>
        </>
      }
    >
      <div className="launch-summary">
        <div>
          <div className="faint" style={{ fontSize: 12 }}>
            GPU
          </div>
          <b>
            {n}× {offer.name}
          </b>
          <div className="faint" style={{ fontSize: 12 }}>
            {offer.memoryGb * n} GB VRAM · {TIER[offer.cloud].name}
          </div>
        </div>
        <div style={{ textAlign: "right" }}>
          <div className="launch-price tabular">
            {formatCredits(perHour)} <small>credits/hr</small>
          </div>
          <div className="faint" style={{ fontSize: 12 }}>
            ≈ {creditsUsd(perHour, wallet.creditsPerUsd)}/hr + disk · balance lasts {formatHours(wallet.balance / perHour)}
          </div>
        </div>
      </div>
      {!enough && <div className="callout err">Your balance doesn't cover an hour of this pod.</div>}
      {thenRun && (
        <div className="option-row" style={{ border: "1px solid var(--border)", borderRadius: 8, padding: "8px 12px" }}>
          <div className="text" style={{ minWidth: 0 }}>
            <div className="title">Then run</div>
            <div className="hint mono truncate">{thenRun.command}</div>
          </div>
          <Switch on={runAfter} onChange={setRunAfter} label="Then run" />
        </div>
      )}
      <div className="field">
        <label>GPUs</label>
        <Segmented
          value={count}
          onChange={setCount}
          options={[
            { value: "1", label: "1" },
            { value: "2", label: "2" },
            { value: "4", label: "4" },
            { value: "8", label: "8" },
          ]}
        />
      </div>
      <div className="field">
        <label>Image</label>
        <select className="select" value={image} onChange={(e) => setImage(e.target.value)}>
          {POD_IMAGES.map((i) => (
            <option key={i.id} value={i.id}>
              {i.label}
            </option>
          ))}
          <option value="custom">Custom image…</option>
        </select>
        {image === "custom" && <input className="input mono" style={{ marginTop: 6 }} placeholder="myorg/trainer:latest (must run sshd with $PUBLIC_KEY)" value={customImage} onChange={(e) => setCustomImage(e.target.value)} />}
      </div>
      <div className="grid-2">
        <div className="field">
          <label>Volume (/workspace, GB)</label>
          <input className="input mono" inputMode="numeric" value={volume} onChange={(e) => setVolume(e.target.value.replace(/\D/g, ""))} />
          <span className="hint">Kept when stopped: datasets, checkpoints, environments.</span>
        </div>
        <div className="field">
          <label>Container disk (GB)</label>
          <input className="input mono" inputMode="numeric" value={disk} onChange={(e) => setDisk(e.target.value.replace(/\D/g, ""))} />
          <span className="hint">Scratch space; wiped when the pod stops.</span>
        </div>
      </div>
      <div className="field">
        <label>Auto-stop when idle</label>
        <Segmented
          value={idle}
          onChange={setIdle}
          options={[
            { value: "15", label: "15 min" },
            { value: "30", label: "30 min" },
            { value: "60", label: "1 h" },
            { value: "120", label: "2 h" },
            { value: "0", label: "Never" },
          ]}
        />
        <span className="hint">The pod stops itself after this long with no GPU work, even if this computer is off. The volume is kept.</span>
      </div>
      <div className="field">
        <label>Name</label>
        <input className="input mono" value={name} onChange={(e) => setName(e.target.value)} />
      </div>
      {error && <div className="callout err">{error}</div>}
    </Dialog>
  );
}
