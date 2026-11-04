import { Fragment, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  ChevronLeft,
  CircleX,
  Clock,
  Cpu,
  Database,
  DollarSign,
  FileDiff,
  Gauge,
  GitCommitHorizontal,
  Info,
  LoaderCircle,
  MemoryStick,
  NotebookPen,
  OctagonAlert,
  RefreshCw,
  RotateCcw,
  Search,
  Square,
  TriangleAlert,
  Unplug,
} from "lucide-react";
import { isTerminal, primaryMetricKey, seriesStats, type DiagnosticEvent, type RunNotes } from "@converge/run-protocol";
import type { RunView } from "@converge/core/api";
import { api, errorMessage, useRun } from "../api.ts";
import { LineChart, SERIES_COLORS, smooth } from "../components/Chart.tsx";
import { formatCredits } from "../cloud.ts";
import { ForecastCard, type RentRequest } from "../components/ForecastCard.tsx";
import { Empty, Meter, StatusPill, Switch, useToast } from "../components/ui.tsx";
import { formatBytes, formatDate, formatDuration, formatMiB, formatNumber, formatUsd, formatValue } from "../format.ts";

type Tab = "overview" | "logs" | "config" | "env" | "notes";

export function RunDetail({ runId, onBack, onReproduce, onRent }: { runId: string; onBack: () => void; onReproduce: (runId: string) => void; onRent?: (r: RentRequest) => void }) {
  const run = useRun(runId);
  const [tab, setTab] = useState<Tab>("overview");
  const toast = useToast();
  const [cancelling, setCancelling] = useState(false);

  if (run === undefined)
    return (
      <div className="page">
        <div className="empty">
          <LoaderCircle className="spin" />
        </div>
      </div>
    );
  if (run === null)
    return (
      <div className="page">
        <button className="btn ghost sm" onClick={onBack}>
          <ChevronLeft size={14} /> Runs
        </button>
        <Empty icon={<CircleX size={22} />} title="Run not found" />
      </div>
    );

  const m = run.manifest;
  const s = run.summary;
  const canCancel = !isTerminal(run.status) && run.local?.phase === "launched";
  const errorCount = s.diagnostics.filter((d) => d.severity === "error").length;

  const cancel = async () => {
    setCancelling(true);
    try {
      await api.cancelRun(runId);
      toast("info", "Cancellation requested", "Training is being stopped on the machine.");
    } catch (e) {
      toast("error", "Could not cancel", errorMessage(e));
    } finally {
      setCancelling(false);
    }
  };

  return (
    <div className="page">
      <button className="btn ghost sm" onClick={onBack} style={{ marginLeft: -8, marginBottom: 10 }}>
        <ChevronLeft size={14} /> Runs
      </button>
      <div className="page-header">
        <div style={{ minWidth: 0 }}>
          <div className="row" style={{ gap: 12 }}>
            <h1 className="page-title">{m.name}</h1>
            <StatusPill status={run.status} connection={run.connection} />
            {run.notes.group && <span className="tag accent">{run.notes.group}</span>}
            {m.reproducedFrom && <span className="tag">reproduction</span>}
          </div>
          <div className="page-sub">
            <span className="mono selectable" style={{ fontSize: 12 }}>{m.command}</span>
          </div>
        </div>
        <div className="spacer" />
        {(run.connection === "lost" || run.connection === "reconnecting") && run.local?.phase === "launched" && (
          <button className="btn" onClick={() => api.reconnectRun(runId)}>
            <RefreshCw size={14} /> Reconnect
          </button>
        )}
        {canCancel && (
          <button className="btn danger" onClick={cancel} disabled={cancelling || run.status === "cancelling"}>
            {cancelling || run.status === "cancelling" ? <LoaderCircle size={14} className="spin" /> : <Square size={13} fill="currentColor" />} Stop
          </button>
        )}
        <button className="btn" onClick={() => onReproduce(runId)}>
          <RotateCcw size={14} /> Reproduce
        </button>
      </div>

      {run.local?.phase === "launch_failed" && (
        <div className="callout err" style={{ marginBottom: 14 }}>
          <CircleX size={16} />
          <div>
            <b>Launch failed.</b> <span className="selectable">{run.local.error}</span>
          </div>
        </div>
      )}
      {run.connectionDetail && run.connection !== "live" && (
        <div className={`callout ${run.connection === "lost" ? "" : "info"}`} style={{ marginBottom: 14 }}>
          <Unplug size={16} />
          <div>
            <b>{run.connection === "lost" ? "Can't observe this run right now." : "Reconnecting…"}</b>{" "}
            <span className="selectable">{run.connectionDetail}</span>
            <div className="faint" style={{ marginTop: 3 }}>
              Training runs independently of Converlt. Its last known state is shown, not assumed failed.
            </div>
          </div>
        </div>
      )}

      <Stats run={run} />
      <ForecastCard run={run} onRent={onRent} />

      {s.diagnostics.map((d) => (
        <DiagnosticCard key={d.kind} d={d} run={run} />
      ))}

      <div className="tabs">
        {(
          [
            ["overview", "Overview", null],
            ["logs", "Logs", s.logCount ? <span className={`badge ${errorCount ? "err" : ""}`}>{s.logCount > 999 ? `${Math.floor(s.logCount / 1000)}k` : s.logCount}</span> : null],
            ["config", "Config", null],
            ["env", "Code & environment", null],
            ["notes", "Notes", run.notes.hypothesis || run.notes.conclusion ? <NotebookPen size={12} /> : null],
          ] as [Tab, string, ReactNode][]
        ).map(([id, label, extra]) => (
          <button key={id} className={`tab ${tab === id ? "on" : ""}`} onClick={() => setTab(id)}>
            {label}
            {extra}
          </button>
        ))}
      </div>

      {tab === "overview" && <Overview run={run} />}
      {tab === "logs" && <Logs run={run} />}
      {tab === "config" && <ConfigTab run={run} />}
      {tab === "env" && <EnvTab run={run} />}
      {tab === "notes" && <NotesTab run={run} />}
    </div>
  );
}

// ---------------------------------------------------------------- stats

function Stat({ icon, label, value, sub, children }: { icon: ReactNode; label: string; value: ReactNode; sub?: ReactNode; children?: ReactNode }) {
  return (
    <div className="card stat">
      <div className="stat-label">
        {icon}
        {label}
      </div>
      <div className="stat-value">{value}</div>
      {sub && <div className="stat-sub">{sub}</div>}
      {children}
    </div>
  );
}

function Stats({ run }: { run: RunView }) {
  const s = run.summary;
  const key = primaryMetricKey(Object.keys(s.metrics));
  const st = key ? seriesStats(s.metrics[key]) : null;
  const gpus = s.latestTelemetry?.gpus ?? [];
  const used = gpus.reduce((a, g) => a + g.memUsedMiB, 0);
  const total = gpus.reduce((a, g) => a + g.memTotalMiB, 0);
  const utils = gpus.map((g) => g.utilPct).filter((u): u is number => u !== null);
  const live = run.status === "running";
  const cloudRate = run.manifest.machine.cloudPricePerHour;
  return (
    <div className="stat-grid">
      <Stat icon={<Gauge size={13} />} label={key ?? "Metric"} value={st ? (st.last === null ? <span style={{ color: "var(--err)" }}>NaN</span> : formatNumber(st.last)) : "—"} sub={st ? `min ${formatNumber(st.min)} · step ${formatNumber(st.lastStep)}` : "Log metrics with the Converlt SDK"} />
      <Stat icon={<Clock size={13} />} label="Duration" value={run.durationSec === null ? "—" : formatDuration(run.durationSec)} sub={s.startedAt ? `started ${formatDate(s.startedAt)}` : "not started"} />
      <Stat
        icon={<DollarSign size={13} />}
        label="Est. compute cost"
        value={cloudRate !== undefined ? `${formatCredits(((run.durationSec ?? 0) / 3600) * cloudRate, 0)} credits` : formatUsd(run.costUsd)}
        sub={
          cloudRate !== undefined
            ? `at ${formatCredits(cloudRate, 0)} credits/hr (Converlt Cloud)`
            : run.manifest.machine.hourlyRate !== undefined
              ? `at $${run.manifest.machine.hourlyRate}/hr (your estimate)`
              : "set an hourly rate on the machine"
        }
      />
      <Stat
        icon={<MemoryStick size={13} />}
        label="GPU memory"
        value={gpus.length ? `${formatMiB(used)} / ${formatMiB(total)}` : "—"}
        sub={s.peakGpuMemMiB !== null ? `peak ${formatMiB(s.peakGpuMemMiB)}${live ? "" : " during run"}` : "no GPU telemetry"}
      >
        {gpus.length > 0 && live && <Meter value={used} max={total} />}
      </Stat>
      <Stat
        icon={<Cpu size={13} />}
        label={gpus[0]?.name ?? s.env?.gpus?.[0]?.name ?? "GPU"}
        value={utils.length && live ? `${Math.round(utils.reduce((a, b) => a + b, 0) / utils.length)}%` : "—"}
        sub={live ? `utilization${gpus[0]?.tempC != null ? ` · ${gpus[0].tempC}°C` : ""}${gpus[0]?.powerW != null ? ` · ${Math.round(gpus[0].powerW)} W` : ""}` : run.manifest.machine.name}
      />
    </div>
  );
}

// ---------------------------------------------------------------- diagnostics

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <span>
      <b>{label}</b>
      <span className="mono">{children}</span>
    </span>
  );
}

function DiagnosticCard({ d, run }: { d: DiagnosticEvent; run: RunView }) {
  const [open, setOpen] = useState(false);
  const data = (d.data ?? {}) as Record<string, any>;
  const icon = d.severity === "error" ? <OctagonAlert size={18} /> : d.severity === "warning" ? <TriangleAlert size={18} /> : <Info size={18} />;
  let title = d.message;
  /** A plain-language explanation of the cause, shown under the title. */
  let why: string | null = null;
  let facts: ReactNode = null;
  let tips: string[] = [];
  let code: string | null = null;
  let detail: string | null = null;

  if (d.kind === "nan") {
    title = "Non-finite training loss detected";
    why = data.nanVerdict ?? null;
    const where: Record<string, string> = { weights: "weights", gradients: "gradients (backward pass)", forward: "forward pass or loss" };
    facts = (
      <>
        <Fact label="Metric">{String(data.metric ?? "loss")}</Fact>
        <Fact label="Step">{d.step ?? "—"}</Fact>
        <Fact label="Observed">{String(data.value ?? "NaN")}</Fact>
        {data.lastFiniteValue !== undefined && (
          <Fact label="Last finite">
            {formatNumber(data.lastFiniteValue)} @ step {data.lastFiniteStep ?? "?"}
          </Fact>
        )}
        {data.nanWhere && <Fact label="Started in">{where[data.nanWhere] ?? data.nanWhere}</Fact>}
        {data.nanLayer && <Fact label="First layer">{data.nanLayer}</Fact>}
        <Fact label="Source">{data.source === "sdk" ? "SDK metric" : "log output"}</Fact>
        {data.stoppedRun && <Fact label="Action">run stopped</Fact>}
      </>
    );
    if (data.nanWhere === "forward")
      tips = [
        "Look for log, sqrt or division in the model and the loss; add a small epsilon (e.g. torch.log(x + 1e-8), x / (y + 1e-8)).",
        "Check the input batch at this step for NaN/Inf values or empty targets.",
        "With mixed precision, run the loss computation in float32.",
      ];
    else if (data.nanWhere === "gradients")
      tips = [
        "With fp16, wrap the step in torch.amp.GradScaler, or switch to bf16, which has fp32's range.",
        "Clip gradients before the optimizer step: torch.nn.utils.clip_grad_norm_(model.parameters(), 1.0).",
        `Lower the learning rate, or lengthen warmup${data.nanLayer ? `; ${data.nanLayer} is where it starts` : ""}.`,
      ];
    else if (data.nanWhere === "weights")
      tips = [
        "The bad update happened before this step: lower the learning rate and add gradient clipping.",
        "Resume from a checkpoint before the failing step rather than continuing.",
        "Compare with the last good run: Compare → Why are these different?",
      ];
    else
      tips = [
        "Check whether the learning rate or schedule changed near this step.",
        "With mixed precision, check loss scaling; try bf16 or a lower initial scale.",
        "Add gradient clipping and inspect gradient norms around the failing step.",
        "To have Converlt find where the NaN starts, add run.watch(model) after converge.run().",
      ];
    const norms = (data.largestGradNorms as { name: string; norm: number }[] | undefined) ?? [];
    const list = (names: string[] | undefined, count: number | undefined) =>
      names?.length ? names.join(", ") + (count && count > names.length ? ` and ${count - names.length} more` : "") : null;
    const grads = list(data.nonFiniteGrads, data.nonFiniteGradCount);
    const weights = list(data.nonFiniteWeights, data.nonFiniteWeightCount);
    const parts = [
      data.line,
      norms.length ? `Largest gradient norms:\n${norms.map((g) => `  ${g.name}: ${formatNumber(g.norm)}`).join("\n")}` : null,
      grads && `Non-finite gradients: ${grads}`,
      weights && `Non-finite weights: ${weights}`,
    ];
    detail = parts.filter(Boolean).join("\n\n") || null;
  } else if (d.kind === "dataloader") {
    title = "The data loader is the bottleneck";
    why = d.message;
    const workers = data.numWorkers as number | null | undefined;
    const suggested = data.suggestedWorkers as number;
    facts = (
      <>
        <Fact label="Waiting for data">{Math.round(data.dataWaitPct)}% of the time</Fact>
        {workers != null && <Fact label="num_workers">{workers}</Fact>}
        {data.batchSize != null && <Fact label="batch_size">{data.batchSize}</Fact>}
        {data.pinMemory != null && <Fact label="pin_memory">{String(data.pinMemory)}</Fact>}
        {data.avgUtilPct != null && <Fact label="GPU busy">{Math.round(data.avgUtilPct)}%</Fact>}
        <Fact label="CPU cores">{data.cpuCount}</Fact>
      </>
    );
    if (workers != null && workers < suggested) {
      tips.push(`Load in parallel: num_workers=${suggested} (this machine has ${data.cpuCount} CPU cores).`);
      if (data.pinMemory === false) tips.push("pin_memory=True speeds up copies to the GPU.");
      if (data.persistentWorkers === false) tips.push("persistent_workers=True keeps workers alive between epochs instead of restarting them.");
      code = `DataLoader(dataset, batch_size=${data.batchSize ?? "…"}, num_workers=${suggested}, pin_memory=True, persistent_workers=True, prefetch_factor=4)`;
    } else {
      tips.push(`Loading is slow even with ${workers ?? "several"} workers: each sample takes too long to prepare.`);
      tips.push("Do less per sample: pre-resize images or pre-tokenize text once and cache it, instead of on every epoch.");
      tips.push("Move augmentation onto the GPU (e.g. torchvision.transforms.v2 on GPU tensors), or use a faster decoder.");
      tips.push("If data streams from network storage, copy it to the machine's local disk first.");
    }
  } else if (d.kind === "perf" && data.avgUtilPct !== undefined && data.dataWaitPct !== undefined && data.dataWaitPct < 15) {
    title = "The GPU is underused, and the data loader isn't why";
    why = `GPU utilization averaged ${Math.round(data.avgUtilPct)}%, but the training loop waited for data only ${Math.round(data.dataWaitPct)}% of the time. The time goes to work between GPU kernels.`;
    tips = [
      "Increase the batch size: small batches leave the GPU idle between kernels.",
      "Avoid a CPU sync every step: .item(), .cpu(), printing tensors, or logging metrics on every step.",
      "Try torch.compile(model) and bf16 autocast to cut kernel launch overhead.",
      "Look for Python-side work in the step: loops over the batch, numpy conversions, metric computation.",
    ];
  } else if (d.kind === "oom") {
    title = "CUDA out of memory";
    const gpu = (data.gpus as any[] | undefined)?.[0];
    const total = data.totalMiB ?? gpu?.memTotalMiB;
    facts = (
      <>
        {total && <Fact label="Device">{formatMiB(total)}{data.deviceName ? ` ${data.deviceName}` : ""}</Fact>}
        {data.allocatedMiB !== undefined && <Fact label="Allocated">{formatMiB(data.allocatedMiB)}</Fact>}
        {data.reservedMiB !== undefined && <Fact label="Reserved">{formatMiB(data.reservedMiB)}</Fact>}
        {data.peakAllocatedMiB !== undefined && <Fact label="Peak">{formatMiB(data.peakAllocatedMiB)}</Fact>}
        {data.freeMiB !== undefined && <Fact label="Free">{formatMiB(data.freeMiB)}</Fact>}
        {run.summary.peakGpuMemMiB !== null && <Fact label="Peak observed">{formatMiB(run.summary.peakGpuMemMiB)}</Fact>}
        {data.failingFrame && <Fact label="At">{data.failingFrame}</Fact>}
        {data.batchHints &&
          Object.entries(data.batchHints as Record<string, unknown>).map(([k, v]) => (
            <Fact key={k} label={k}>
              {String(v)}
            </Fact>
          ))}
      </>
    );
    tips = [
      "Reduce the batch size (or sequence length) and use gradient accumulation to keep the effective batch.",
      "Enable mixed precision (bf16/fp16) and activation checkpointing for large models.",
      "If reserved ≫ allocated, try PYTORCH_CUDA_ALLOC_CONF=expandable_segments:True to reduce fragmentation.",
      "Pick a machine with more VRAM on the Compute page.",
    ];
    detail = data.message ?? data.line ?? null;
  } else if (d.kind === "exit") {
    title = d.message;
    detail = ((data.stderrTail as string[] | undefined) ?? []).join("\n") || null;
  } else if (d.kind === "perf") {
    title = "Performance";
    tips = data.avgUtilPct !== undefined
      ? ["Increase DataLoader num_workers and enable pin_memory.", "Move CPU-side preprocessing onto the GPU or precompute it.", "Check disk/network throughput if data is streamed."]
      : ["Memory is close to the limit; an OOM is likely if batch or sequence size grows."];
  } else if (d.kind === "stall") {
    title = "Training may be stalled";
    tips = ["Check for a deadlocked DataLoader, a hung collective (NCCL), or waiting on input.", "Logs below show the last output before the silence."];
  } else if (d.kind === "exception") {
    detail = data.traceback ?? null;
  } else if (d.kind === "launch") {
    detail = data.traceback ?? null;
  }

  return (
    <div className={`diag ${d.severity}`}>
      <div className="diag-icon">{icon}</div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div className="row">
          <div className="diag-title">{title}</div>
          <div className="spacer" />
          {detail && (
            <button className="btn ghost sm" onClick={() => setOpen(!open)}>
              {open ? "Hide details" : "Details"}
            </button>
          )}
        </div>
        {why ? (
          <div style={{ marginTop: 3 }}>{why}</div>
        ) : (
          d.kind !== "exit" && d.kind !== "nan" && d.kind !== "oom" && title !== d.message && <div className="muted" style={{ marginTop: 3 }}>{d.message}</div>
        )}
        {facts && <div className="diag-facts">{facts}</div>}
        {tips.length > 0 && (
          <ul>
            {tips.map((t) => (
              <li key={t}>{t}</li>
            ))}
          </ul>
        )}
        {code && (
          <pre className="code-block selectable" style={{ marginTop: 8 }}>
            {code}
          </pre>
        )}
        {open && detail && (
          <pre className="code-block" style={{ marginTop: 10 }}>
            {detail}
          </pre>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- overview

function Overview({ run }: { run: RunView }) {
  const s = run.summary;
  const [smoothing, setSmoothing] = useState(0);
  const keys = useMemo(() => {
    const all = Object.keys(s.metrics);
    const p = primaryMetricKey(all);
    return all.sort((a, b) => (a === p ? -1 : b === p ? 1 : a.localeCompare(b)));
  }, [s.metrics]);
  const t0 = s.telemetry[0]?.ts ?? 0;
  const elapsed = (sec: number) => formatDuration(sec);

  return (
    <>
      {keys.length > 0 ? (
        <>
          <div className="row" style={{ marginBottom: 12 }}>
            <div className="section-title" style={{ margin: 0 }}>
              Metrics
            </div>
            <div className="spacer" />
            <span className="faint" style={{ fontSize: 12 }}>
              Smoothing
            </span>
            <input type="range" min={0} max={0.99} step={0.01} value={smoothing} onChange={(e) => setSmoothing(Number(e.target.value))} style={{ width: 140, accentColor: "var(--accent)" }} />
            <span className="mono faint" style={{ width: 32 }}>
              {smoothing.toFixed(2)}
            </span>
          </div>
          <div className="charts">
            {keys.map((k, i) => {
              const raw = s.metrics[k]!.map((p) => ({ x: p.step, y: p.value }));
              const st = seriesStats(s.metrics[k]);
              return (
                <div key={k} className="card chart-card">
                  <div className="chart-title">
                    {k}
                    <span className="value">{st.last === null ? "NaN" : formatNumber(st.last, 5)}</span>
                  </div>
                  <LineChart series={[{ name: k, color: SERIES_COLORS[i % SERIES_COLORS.length]!, points: smooth(raw, smoothing) }]} />
                </div>
              );
            })}
          </div>
        </>
      ) : (
        <div className="callout info" style={{ marginBottom: 6 }}>
          <Info size={16} />
          <div>
            No metrics recorded yet. Logs and GPU telemetry work without changes. For metric curves and precise NaN/OOM diagnostics, add the SDK (it is installed on the machine automatically):
            <pre className="code-block" style={{ marginTop: 8 }}>{`import converge\n\nrun = converge.run(config=vars(args))\nrun.log({"train/loss": loss}, step=step)`}</pre>
          </div>
        </div>
      )}

      <div className="section-title">System</div>
      <div className="charts">
        <div className="card chart-card">
          <div className="chart-title">GPU memory</div>
          <LineChart
            xLabel="elapsed"
            xFormat={(v) => elapsed(v)}
            yFormat={(v) => formatMiB(v)}
            yMin={0}
            yMax={s.telemetry[0]?.memTotalMiB || undefined}
            series={[{ name: "used", color: "var(--s2)", points: s.telemetry.map((p) => ({ x: p.ts - t0, y: p.memUsedMiB })) }]}
          />
        </div>
        <div className="card chart-card">
          <div className="chart-title">GPU utilization</div>
          <LineChart
            xLabel="elapsed"
            xFormat={(v) => elapsed(v)}
            yFormat={(v) => `${Math.round(v)}%`}
            yMin={0}
            yMax={100}
            series={[{ name: "util", color: "var(--s3)", points: s.telemetry.map((p) => ({ x: p.ts - t0, y: p.utilPct })) }]}
          />
        </div>
      </div>

      {s.artifacts.length > 0 && (
        <>
          <div className="section-title">Checkpoints</div>
          <div className="card" style={{ overflow: "hidden" }}>
            <table className="table">
              <thead>
                <tr>
                  <th>Path</th>
                  <th className="num">Step</th>
                  <th className="num">Size</th>
                  <th>SHA-256</th>
                </tr>
              </thead>
              <tbody>
                {s.artifacts.map((a) => (
                  <tr key={a.seq}>
                    <td className="mono selectable">{a.path}</td>
                    <td className="num mono">{a.step ?? "—"}</td>
                    <td className="num mono">{a.sizeBytes != null ? formatBytes(a.sizeBytes) : "—"}</td>
                    <td className="mono faint selectable">{a.sha256 ? `${a.sha256.slice(0, 16)}…` : "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </>
  );
}

// ---------------------------------------------------------------- logs

const HIGHLIGHT = /(CUDA out of memory|OutOfMemoryError|Traceback \(most recent call last\)|\bnan\b|\binf\b|Error:|error:)/gi;

function highlight(line: string): ReactNode {
  const parts = line.split(HIGHLIGHT);
  if (parts.length === 1) return line;
  return parts.map((p, i) => (i % 2 ? <span key={i} className="hl">{p}</span> : p));
}

function Logs({ run }: { run: RunView }) {
  const [query, setQuery] = useState("");
  const [stderrOnly, setStderrOnly] = useState(false);
  const [follow, setFollow] = useState(true);
  const box = useRef<HTMLDivElement>(null);
  const logs = run.summary.logs;
  const shown = useMemo(() => {
    const q = query.toLowerCase();
    return logs.filter((l) => (!stderrOnly || l.stream === "stderr") && (!q || l.line.toLowerCase().includes(q)));
  }, [logs, query, stderrOnly]);
  const firstIndex = run.summary.logCount - logs.length;

  useEffect(() => {
    if (follow && box.current) box.current.scrollTop = box.current.scrollHeight;
  }, [shown, follow]);

  return (
    <>
      <div className="toolbar">
        <div className="search">
          <Search size={14} />
          <input className="input" placeholder="Filter log lines…" value={query} onChange={(e) => setQuery(e.target.value)} />
        </div>
        <label className="row muted" style={{ gap: 8 }}>
          <Switch on={stderrOnly} onChange={setStderrOnly} label="stderr only" /> stderr only
        </label>
        <label className="row muted" style={{ gap: 8 }}>
          <Switch on={follow} onChange={setFollow} label="Follow" /> Follow
        </label>
        <div className="spacer" />
        <span className="faint">
          {firstIndex > 0 ? `showing last ${logs.length.toLocaleString()} of ` : ""}
          {run.summary.logCount.toLocaleString()} lines
        </span>
      </div>
      <div
        className="logs"
        ref={box}
        onScroll={(e) => {
          const el = e.currentTarget;
          const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
          if (!atBottom && follow) setFollow(false);
        }}
      >
        {shown.length === 0 && <div className="faint" style={{ padding: "0 16px" }}>{logs.length ? "No matching lines." : "Waiting for output…"}</div>}
        {shown.map((l) => (
          <div key={l.seq} className={`log-line ${l.stream}`}>
            <span className="ln">{l.seq}</span>
            <span className="txt">{highlight(l.line) || " "}</span>
          </div>
        ))}
      </div>
    </>
  );
}

// ---------------------------------------------------------------- config / env

function ConfigTab({ run }: { run: RunView }) {
  const rows = Object.entries(run.effectiveConfig).sort(([a], [b]) => a.localeCompare(b));
  const sdk = run.summary.config;
  return rows.length === 0 ? (
    <div className="card">
      <Empty icon={<NotebookPen size={22} />} title="No configuration captured">
        Converlt reads --key value flags from the command, and anything passed to converge.run(config=...).
      </Empty>
    </div>
  ) : (
    <div className="card" style={{ overflow: "hidden" }}>
      <table className="table">
        <thead>
          <tr>
            <th>Parameter</th>
            <th>Value</th>
            <th>Source</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(([k, v]) => (
            <tr key={k}>
              <td className="mono">{k}</td>
              <td className="mono selectable">{formatValue(v)}</td>
              <td className="faint">{k in sdk ? "SDK config" : "command line"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function EnvTab({ run }: { run: RunView }) {
  const m = run.manifest;
  const env = run.summary.env;
  const [pkgQuery, setPkgQuery] = useState("");
  const pkgs = (env?.packages ?? []).filter((p) => !pkgQuery || p.toLowerCase().includes(pkgQuery.toLowerCase()));
  return (
    <div className="grid-2" style={{ alignItems: "start" }}>
      <div className="col" style={{ gap: 14 }}>
        <div className="card">
          <div className="card-head">
            <GitCommitHorizontal size={15} />
            <div className="card-title">Code</div>
            <div className="spacer" />
            {run.hasPatch && (
              <button className="btn sm" onClick={() => api.openPatch(m.runId)}>
                <FileDiff size={13} /> Uncommitted diff
              </button>
            )}
          </div>
          <div className="card-body">
            {m.git ? (
              <dl className="kv">
                <dt>Commit</dt>
                <dd className="mono selectable">{m.git.commit ?? "—"}</dd>
                <dt>Branch</dt>
                <dd>{m.git.branch ?? "—"}</dd>
                <dt>Working tree</dt>
                <dd>{m.git.dirty ? <span className="tag warn">uncommitted changes{m.git.diffStat ? ` · ${m.git.diffStat}` : ""}</span> : <span className="tag ok">clean</span>}</dd>
                {m.git.untracked.length > 0 && (
                  <>
                    <dt>Untracked</dt>
                    <dd className="mono" style={{ fontSize: 11.5 }}>
                      {m.git.untracked.slice(0, 8).join(", ")}
                      {m.git.untracked.length > 8 ? ` +${m.git.untracked.length - 8} more` : ""}
                    </dd>
                  </>
                )}
                <dt>Synced</dt>
                <dd>
                  {m.sync.files} files · {formatBytes(m.sync.bytes)}
                  {m.sync.skipped ? <span className="faint"> · {m.sync.skipped} skipped</span> : null}
                </dd>
              </dl>
            ) : (
              <span className="faint">Project is not a git repository. Code version was not recorded.</span>
            )}
          </div>
        </div>
        <InputsCard run={run} />
        <div className="card">
          <div className="card-head">
            <Cpu size={15} />
            <div className="card-title">Machine</div>
          </div>
          <div className="card-body">
            <dl className="kv">
              <dt>Machine</dt>
              <dd>{m.machine.name}</dd>
              <dt>Host</dt>
              <dd className="mono selectable">{m.machine.host}{m.machine.port ? `:${m.machine.port}` : ""}</dd>
              <dt>Hostname</dt>
              <dd className="mono">{env?.hostname ?? "—"}</dd>
              <dt>Workdir</dt>
              <dd className="mono selectable">{m.workdir}</dd>
              <dt>GPUs</dt>
              <dd>{env?.gpus?.length ? env.gpus.map((g) => `${g.name} (${formatMiB(g.memTotalMiB)})`).join(", ") : "—"}</dd>
              <dt>Driver / CUDA</dt>
              <dd className="mono">{env?.driver ?? "—"} / {env?.cudaVersion ?? "—"}</dd>
              <dt>Run ID</dt>
              <dd className="mono selectable faint">{m.runId}</dd>
            </dl>
          </div>
        </div>
      </div>
      <div className="card">
        <div className="card-head">
          <div className="card-title">Python environment</div>
        </div>
        <div className="card-body">
          <dl className="kv" style={{ marginBottom: 14 }}>
            <dt>Python</dt>
            <dd className="mono">{env?.python ?? "—"}</dd>
            <dt>Interpreter</dt>
            <dd className="mono selectable" style={{ fontSize: 11.5 }}>{env?.pythonPath ?? m.machine.python}</dd>
            <dt>PyTorch</dt>
            <dd className="mono">{env?.torch ?? "not detected"}</dd>
            <dt>CUDA (torch)</dt>
            <dd className="mono">{env?.torchCuda ?? "—"} {env?.cudaAvailable === false && <span className="tag warn">CUDA unavailable</span>}</dd>
          </dl>
          <div className="row" style={{ marginBottom: 8 }}>
            <div className="label">Packages ({env?.packages?.length ?? 0})</div>
            <div className="spacer" />
            <input className="input" style={{ width: 180, height: 28 }} placeholder="Filter…" value={pkgQuery} onChange={(e) => setPkgQuery(e.target.value)} />
          </div>
          <pre className="code-block" style={{ maxHeight: 420 }}>{pkgs.join("\n") || "—"}</pre>
        </div>
      </div>
    </div>
  );
}

/** Datasets and pretrained weights the run read, with the fingerprints Compare uses to spot data changes. */
function InputsCard({ run }: { run: RunView }) {
  const inputs = run.summary.inputs ?? [];
  return (
    <div className="card">
      <div className="card-head">
        <Database size={15} />
        <div className="card-title">Data & weights</div>
      </div>
      <div className="card-body">
        {inputs.length === 0 ? (
          <span className="faint">
            None recorded. Hugging Face <span className="mono">load_dataset</span> and <span className="mono">from_pretrained</span> are recorded automatically; for local data, call{" "}
            <span className="mono">run.log_dataset("data/train")</span>.
          </span>
        ) : (
          <dl className="kv">
            {inputs.map((i) => (
              <Fragment key={`${i.kind}:${i.name}`}>
                <dt>{i.kind === "dataset" ? "Dataset" : "Weights"}</dt>
                <dd>
                  <span className="mono selectable">{i.name}</span>
                  <div className="faint" style={{ fontSize: 11.5 }}>
                    {[
                      i.fingerprint ? `fingerprint ${i.fingerprint.slice(0, 12)}` : "no fingerprint",
                      i.revision ? `revision ${i.revision.slice(0, 10)}` : null,
                      i.files != null ? `${i.files.toLocaleString()} files` : null,
                      i.bytes != null ? formatBytes(i.bytes) : null,
                      i.source === "auto" ? "recorded automatically" : null,
                    ]
                      .filter(Boolean)
                      .join(" · ")}
                  </div>
                </dd>
              </Fragment>
            ))}
          </dl>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- notes

const NOTE_FIELDS: { key: keyof RunNotes; label: string; placeholder: string; rows?: number }[] = [
  { key: "hypothesis", label: "Hypothesis", placeholder: "What do you expect to learn from this run?" },
  { key: "changes", label: "Changes being tested", placeholder: "e.g. lr 3e-4 → 1e-4, warmup 500 steps" },
  { key: "expected", label: "Expected outcome", placeholder: "e.g. val loss < 0.9 by epoch 3" },
  { key: "observed", label: "Observed result", placeholder: "What actually happened?" },
  { key: "conclusion", label: "Conclusion", placeholder: "Decision and next step" },
];

function NotesTab({ run }: { run: RunView }) {
  const [notes, setNotes] = useState<RunNotes>(run.notes);
  const [saving, setSaving] = useState(false);
  const toast = useToast();
  const runId = run.manifest.runId;
  useEffect(() => {
    setNotes(run.notes);
  }, [runId]); // eslint-disable-line react-hooks/exhaustive-deps
  const dirty = JSON.stringify(notes) !== JSON.stringify(run.notes);
  const save = async () => {
    setSaving(true);
    try {
      await api.saveNotes(runId, notes);
      toast("success", "Notes saved");
    } catch (e) {
      toast("error", "Could not save notes", errorMessage(e));
    } finally {
      setSaving(false);
    }
  };
  return (
    <div className="card" style={{ maxWidth: 860 }}>
      <div className="card-body col" style={{ gap: 14 }}>
        <div className="field">
          <label>Experiment group</label>
          <input className="input" placeholder="e.g. lr-sweep, batch-size, ablation-no-aug" value={notes.group} onChange={(e) => setNotes({ ...notes, group: e.target.value })} />
          <span className="hint">Runs with the same group are tagged together in the run list.</span>
        </div>
        {NOTE_FIELDS.map((f) => (
          <div key={f.key} className="field">
            <label>{f.label}</label>
            <textarea className="textarea" rows={2} placeholder={f.placeholder} value={notes[f.key]} onChange={(e) => setNotes({ ...notes, [f.key]: e.target.value })} />
          </div>
        ))}
        <div className="row">
          <span className="faint">Stored with the run in .converge/ in your project.</span>
          <div className="spacer" />
          <button className="btn primary" disabled={!dirty || saving} onClick={save}>
            {saving && <LoaderCircle size={14} className="spin" />} Save notes
          </button>
        </div>
      </div>
    </div>
  );
}
