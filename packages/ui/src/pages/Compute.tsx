import { useEffect, useState } from "react";
import { CircleCheck, CircleX, HardDrive, LoaderCircle, Pencil, Plus, RefreshCw, Server, Thermometer, Trash } from "lucide-react";
import type { Machine } from "@converge/run-protocol";
import type { AppState, ProbeResult, TelemetryResult } from "@converge/core/api";
import { api, errorMessage } from "../api.ts";
import { EnvIssues } from "../components/EnvIssues.tsx";
import { Empty, Meter, useToast } from "../components/ui.tsx";
import { formatMiB, timeAgo } from "../format.ts";

export function Compute({ state, onAdd, onEdit }: { state: AppState; onAdd: () => void; onEdit: (m: Machine) => void }) {
  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h1 className="page-title">Compute</h1>
          <div className="page-sub">GPU machines reachable over SSH. Converlt installs a small, dependency-free agent in ~/.converge.</div>
        </div>
        <div className="spacer" />
        <button className="btn primary" onClick={onAdd}>
          <Plus size={15} /> Add machine
        </button>
      </div>
      {state.machines.length === 0 ? (
        <div className="card">
          <Empty
            icon={<Server size={24} />}
            title="Connect your first GPU"
            action={
              <button className="btn primary" onClick={onAdd}>
                <Plus size={15} /> Add SSH machine
              </button>
            }
          >
            Use any Linux machine you can <span className="mono">ssh</span> into with a key: a cloud GPU instance, a lab server, or a workstation.
          </Empty>
        </div>
      ) : (
        <div className="machines">
          {state.machines.map((m) => (
            <MachineCard key={m.id} machine={m} probe={state.probes[m.id]} onEdit={() => onEdit(m)} />
          ))}
          <button className="add-card" onClick={onAdd}>
            <div className="col" style={{ alignItems: "center" }}>
              <Plus size={22} />
              <span style={{ fontWeight: 600 }}>Add machine</span>
            </div>
          </button>
        </div>
      )}
    </div>
  );
}

function MachineCard({ machine, probe, onEdit }: { machine: Machine; probe?: ProbeResult; onEdit: () => void }) {
  const toast = useToast();
  const [testing, setTesting] = useState(false);
  const [telemetry, setTelemetry] = useState<TelemetryResult | null>(null);

  const test = async () => {
    setTesting(true);
    try {
      const r = await api.probeMachine(machine.id);
      if (!r.ok) toast("error", `Can't reach ${machine.name}`, r.error);
      else toast(r.ready ? "success" : "info", r.ready ? `${machine.name} is ready` : `${machine.name} is reachable`, r.ready ? undefined : "Some readiness checks failed. See the card for details.");
    } catch (e) {
      toast("error", "Test failed", errorMessage(e));
    } finally {
      setTesting(false);
    }
  };

  // Live telemetry while the page is open, once the machine has been reached.
  useEffect(() => {
    if (!probe?.ok) return;
    let alive = true;
    const tick = async () => {
      const t = await api.machineTelemetry(machine.id);
      if (alive) setTelemetry(t);
    };
    void tick();
    const iv = window.setInterval(tick, 15000);
    return () => {
      alive = false;
      clearInterval(iv);
    };
  }, [machine.id, probe?.ok, probe?.at]);

  const remove = async () => {
    if (!confirm(`Remove ${machine.name}? Runs that used it keep their history.`)) return;
    await api.removeMachine(machine.id);
  };

  const gpus = telemetry?.ok ? telemetry.gpus ?? [] : probe?.gpus ?? [];
  const host = telemetry?.ok ? telemetry.host : probe?.host;
  const health = !probe ? "" : !probe.ok ? "err" : probe.ready ? "ok" : "warn";
  const statusText = !probe ? "Not tested" : !probe.ok ? "Unreachable" : probe.ready ? "Ready" : "Needs attention";

  return (
    <div className="card machine">
      <div className="machine-top">
        <div className="machine-icon">
          <Server size={18} />
        </div>
        <div style={{ minWidth: 0, flex: 1 }}>
          <div className="row">
            <span className="machine-name truncate">{machine.name}</span>
            <span className={`health ${health}`} />
            <span className="faint" style={{ fontSize: 12 }}>{statusText}</span>
          </div>
          <div className="mono faint truncate" style={{ fontSize: 11.5, marginTop: 2 }}>
            {machine.host}
            {machine.port ? `:${machine.port}` : ""} · {machine.python}
          </div>
        </div>
        {machine.hourlyRate !== undefined && <span className="tag">${machine.hourlyRate}/hr</span>}
      </div>

      {probe && !probe.ok && (
        <div className="callout err" style={{ margin: "0 16px 12px" }}>
          <CircleX size={15} />
          <span className="selectable">{probe.error}</span>
        </div>
      )}

      {gpus.map((g) => (
        <div key={g.index} className="gpu-row">
          <div className="top">
            <b>{g.name}</b>
            <span className="faint">#{g.index}</span>
            <div className="spacer" />
            {g.utilPct !== null && <span className="mono muted">{Math.round(g.utilPct)}%</span>}
            {g.tempC !== null && (
              <span className="mono faint row" style={{ gap: 3 }}>
                <Thermometer size={12} />
                {g.tempC}°
              </span>
            )}
            <span className="mono muted">
              {formatMiB(g.memUsedMiB)} / {formatMiB(g.memTotalMiB)}
            </span>
          </div>
          <Meter value={g.memUsedMiB} max={g.memTotalMiB} />
        </div>
      ))}

      {probe?.ok && probe.checks && (
        <div className="checks">
          {probe.checks.map((c) => (
            <div key={c.name} className={`check ${c.ok ? "ok" : "bad"}`} title={c.detail}>
              {c.ok ? <CircleCheck size={13} /> : <CircleX size={13} />}
              <div style={{ minWidth: 0 }}>
                <div>{c.name}</div>
                <div className="faint truncate" style={{ fontSize: 11 }}>{c.detail}</div>
              </div>
            </div>
          ))}
        </div>
      )}
      {probe?.ok && (
        <div style={{ marginTop: 10 }}>
          <EnvIssues machine={machine} probe={probe} />
        </div>
      )}

      {host && (
        <div className="gpu-row row faint" style={{ fontSize: 12, gap: 14 }}>
          <span>load {host.load1 ?? "—"} / {host.cpuCount ?? "?"} CPUs</span>
          <span>RAM {formatMiB(host.memUsedMiB)} / {formatMiB(host.memTotalMiB)}</span>
          <span className="row" style={{ gap: 4 }}>
            <HardDrive size={12} /> {host.diskFreeGiB ?? "—"} GB free
          </span>
        </div>
      )}

      <div className="machine-actions">
        <button className="btn sm" onClick={test} disabled={testing}>
          {testing ? <LoaderCircle size={13} className="spin" /> : <RefreshCw size={13} />} {probe ? "Re-test" : "Test connection"}
        </button>
        {probe?.ok && probe.latencyMs !== undefined && <span className="faint" style={{ fontSize: 11.5, alignSelf: "center" }}>{timeAgo(probe.at / 1000)}</span>}
        <div className="spacer" />
        <button className="btn ghost sm icon" onClick={onEdit} title="Edit" aria-label="Edit machine">
          <Pencil size={13} />
        </button>
        <button className="btn ghost sm icon danger" onClick={remove} title="Remove" aria-label="Remove machine">
          <Trash size={13} />
        </button>
      </div>
    </div>
  );
}
