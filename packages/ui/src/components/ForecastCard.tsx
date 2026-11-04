import { useEffect, useMemo, useState } from "react";
import { Clock, Info, Rocket } from "lucide-react";
import { compareGpus, forecastCost, forecastRun, type RunOptions } from "@converge/run-protocol";
import type { RunView } from "@converge/core/api";
import type { GpuOffer } from "@converge/core/cloud";
import { api } from "../api.ts";
import { creditsUsd, formatCredits } from "../cloud.ts";
import { formatDuration, formatUsd } from "../format.ts";
import { Meter } from "./ui.tsx";

export interface RentRequest {
  offer: GpuOffer;
  thenRun: { command: string; options: RunOptions };
}

/** An estimate shouldn't claim second-level precision: whole minutes, or 5 minutes past two hours. */
function rough(sec: number): string {
  const step = sec >= 7200 ? 300 : 60;
  return formatDuration(Math.max(step, Math.round(sec / step) * step));
}

function finishTime(atSec: number): string {
  const d = new Date(atSec * 1000);
  const time = d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  const days = Math.floor((d.getTime() - new Date().setHours(0, 0, 0, 0)) / 86_400_000);
  return days <= 0 ? time : days === 1 ? `tomorrow ${time}` : `${d.toLocaleDateString([], { weekday: "short" })} ${time}`;
}

/** While a run trains: when it will finish, what it will cost, and what the same run costs on other GPUs. */
export function ForecastCard({ run, onRent }: { run: RunView; onRent?: (r: RentRequest) => void }) {
  const live = run.status === "running";
  const [now, setNow] = useState(() => Date.now() / 1000);
  useEffect(() => {
    if (!live) return;
    const iv = window.setInterval(() => setNow(Date.now() / 1000), 15_000);
    return () => clearInterval(iv);
  }, [live]);
  const f = useMemo(() => (live ? forecastRun(run.summary, run.effectiveConfig, Math.max(now, run.summary.lastEventAt ?? 0)) : null), [live, run.summary, run.effectiveConfig, now]);

  const [offers, setOffers] = useState<GpuOffer[] | null>(null);
  const [perUsd, setPerUsd] = useState(100);
  const hasForecast = !!f;
  useEffect(() => {
    if (!hasForecast) return;
    let gone = false;
    api
      .cloudStatus()
      .then((st) => (st.connected ? Promise.all([api.gpuOffers(), api.cloudWallet()]) : null))
      .then((r) => {
        if (!gone && r) {
          setOffers(r[0]);
          setPerUsd(r[1].creditsPerUsd);
        }
      })
      .catch(() => {});
    return () => {
      gone = true;
    };
  }, [hasForecast]);

  const m = run.manifest.machine;
  const s = run.summary;
  if (!f) {
    const elapsed = s.startedAt !== null ? now - s.startedAt : 0;
    if (!live || elapsed < 300 || !Object.keys(s.metrics).length) return null;
    return (
      <div className="callout info" style={{ marginBottom: 14 }}>
        <Info size={15} />
        <span>
          To see when this run finishes and what it costs, tell Converlt its length: <span className="mono">converge.run(..., total_steps=N)</span>, or a{" "}
          <span className="mono">max_steps</span> / <span className="mono">epochs</span> + <span className="mono">steps_per_epoch</span> setting.
        </span>
      </div>
    );
  }

  const cost = m.cloudPricePerHour !== undefined ? forecastCost(f, m.cloudPricePerHour, "credits") : m.hourlyRate !== undefined ? forecastCost(f, m.hourlyRate, "usd") : null;
  const money = (v: number, unit: "credits" | "usd") => (unit === "usd" ? formatUsd(v) : `${formatCredits(v, 0)} credits (≈ ${creditsUsd(v, perUsd)})`);
  const gpus = s.env?.gpus ?? [];
  const gpuName = gpus[0]?.name ?? s.latestTelemetry?.gpus[0]?.name ?? null;
  const count = Math.max(1, gpus.length || s.latestTelemetry?.gpus.length || 1);
  const creditsPerHour = m.cloudPricePerHour ?? (m.hourlyRate !== undefined ? m.hourlyRate * perUsd : null);
  const cmp = gpuName && offers ? compareGpus(f, { name: gpuName, count, creditsPerHour, peakMemMiBPerGpu: s.peakGpuMemMiB !== null ? s.peakGpuMemMiB / count : null }, offers) : null;
  const fastest = cmp?.options.reduce<(typeof cmp.options)[number] | null>((best, o) => (!best || o.speedup > best.speedup ? o : best), null) ?? null;
  const shown = cmp ? [...new Set([...(cmp.recommended ? [cmp.recommended] : []), ...cmp.options.slice(0, 3), ...(fastest?.faster ? [fastest] : [])])].slice(0, 4) : [];

  return (
    <div className="card" style={{ marginBottom: 14 }}>
      <div className="card-head">
        <Clock size={15} />
        <div className="card-title">Forecast</div>
        <div className="spacer" />
        <span className="faint" style={{ fontSize: 12 }}>
          estimate
        </span>
      </div>
      <div className="card-body col" style={{ gap: 10 }}>
        <div className="row wrap" style={{ gap: 24, alignItems: "flex-end" }}>
          <div>
            <div style={{ fontSize: 20, fontWeight: 650 }}>Finishes in about {rough(f.remainingSec)}</div>
            <div className="faint">
              around {finishTime(now + f.remainingSec)} · step {f.currentStep.toLocaleString()} of {f.totalSteps.toLocaleString()} ({Math.round(f.progress * 100)}%)
            </div>
          </div>
          {cost && (
            <div>
              <div style={{ fontSize: 20, fontWeight: 650 }}>about {money(cost.total, cost.unit)}</div>
              <div className="faint">
                {money(cost.soFar, cost.unit)} so far{cost.unit === "usd" ? " at your hourly rate" : ""}
              </div>
            </div>
          )}
        </div>
        <Meter value={f.progress} max={1} />
        <div className="faint" style={{ fontSize: 12 }}>
          At {f.stepsPerSec >= 10 ? Math.round(f.stepsPerSec).toLocaleString() : f.stepsPerSec.toPrecision(2)} steps/s over the last few minutes, toward the length from {f.totalSource}.
          {!cost && " Set an hourly rate on the machine to see the cost."}
        </div>

        {shown.length > 0 && cmp && (
          <>
            <div className="label" style={{ marginTop: 4 }}>
              The same run on another GPU
            </div>
            <table className="table">
              <thead>
                <tr>
                  <th>GPU</th>
                  <th className="num">Whole run</th>
                  <th className="num">Cost</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td>
                    {count > 1 ? `${count}× ` : ""}
                    {gpuName} <span className="faint">(this run)</span>
                  </td>
                  <td className="num mono">{rough(cmp.current.fullSec)}</td>
                  <td className="num mono">{cmp.current.fullCredits !== null ? creditsUsd(cmp.current.fullCredits, perUsd) : "—"}</td>
                  <td />
                </tr>
                {shown.map((o) => (
                  <tr key={o.offer.id + (o.offer as GpuOffer).cloud}>
                    <td>
                      {o.count > 1 ? `${o.count}× ` : ""}
                      {o.offer.name} {o === cmp.recommended && <span className="tag accent">suggested</span>} {o.cheaper && <span className="tag ok">cheaper</span>} {o.faster && <span className="tag">{o.speedup.toFixed(1)}× faster</span>}
                    </td>
                    <td className="num mono">{rough(o.fullSec)}</td>
                    <td className="num mono">{creditsUsd(o.fullCredits, perUsd)}</td>
                    <td style={{ textAlign: "right" }}>
                      {onRent && (
                        <button className="btn sm" title="Rent this GPU and start the same command there as soon as it's ready" onClick={() => onRent({ offer: o.offer as GpuOffer, thenRun: { command: run.manifest.command, options: run.manifest.options } })}>
                          <Rocket size={13} /> Run next on this
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="faint" style={{ fontSize: 12 }}>
              GPU speeds are rough, from public training benchmarks; memory bandwidth and model size shift them. GPUs with less memory than this run used are left out.
            </div>
          </>
        )}
      </div>
    </div>
  );
}
