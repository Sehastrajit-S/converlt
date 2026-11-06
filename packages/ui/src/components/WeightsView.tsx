// The Model Builder's weights view: what training did to each layer's weights, from the
// snapshots run.watch(model) records. Overlays sit next to canvas nodes; the inspector shows
// one layer in detail (histogram, the matrix as a heatmap, and how it moved over the run).
import { healthOf, mainTensor, tensorsOf, weightIssues, type WeightIssue, type WeightsEvent, type WeightTensor } from "@converge/run-protocol";

export interface LayerWeights {
  tensors: WeightTensor[];
  issues: WeightIssue[];
  health: "ok" | "warning" | "error";
}

export function layerWeights(snapshots: WeightsEvent[], index: number, module: string): LayerWeights | null {
  const latest = tensorsOf(snapshots[index], module);
  if (!latest.length) return null;
  const first = snapshots[0];
  const issues = weightIssues(latest, tensorsOf(first, module), { first: first?.step ?? null, latest: snapshots[index]?.step ?? null });
  return { tensors: latest, issues, health: healthOf(issues) };
}

export function fmt(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return "—";
  if (v === 0) return "0";
  const a = Math.abs(v);
  return a >= 1e4 || a < 1e-3 ? v.toExponential(1) : v.toPrecision(3).replace(/\.?0+$/, "");
}

/** Bars of a value histogram; the zero line is marked when 0 is in range. */
export function Histogram({ t, width, height }: { t: WeightTensor; width: number; height: number }) {
  const { counts, min, max } = t.hist;
  const peak = Math.max(1, ...counts);
  const bw = width / Math.max(1, counts.length);
  const zero = min < 0 && max > 0 ? ((0 - min) / (max - min)) * width : null;
  return (
    <svg className="w-hist" width={width} height={height} role="img" aria-label={`${t.name} values from ${fmt(min)} to ${fmt(max)}`}>
      {counts.map((c, i) => {
        const h = c ? Math.max(1, (c / peak) * (height - 1)) : 0;
        return <rect key={i} x={i * bw + 0.5} y={height - h} width={Math.max(1, bw - 1)} height={h} />;
      })}
      {zero !== null && <line className="w-zero" x1={zero} x2={zero} y1={0} y2={height} />}
    </svg>
  );
}

/** The weight matrix, averaged into cells: blue negative, red positive, white near zero. */
export function Heatmap({ grid, width }: { grid: number[][]; width: number }) {
  const rows = grid.length;
  const cols = grid[0]?.length ?? 0;
  if (!rows || !cols) return null;
  const peak = Math.max(1e-12, ...grid.flat().map(Math.abs));
  const cw = width / cols;
  const ch = Math.min(cw, 10);
  return (
    <svg className="w-heat" width={width} height={rows * ch} role="img" aria-label="Weight matrix heatmap">
      {grid.map((row, r) =>
        row.map((v, c) => {
          const a = Math.min(1, Math.abs(v) / peak);
          return <rect key={`${r}-${c}`} x={c * cw} y={r * ch} width={cw + 0.3} height={ch + 0.3} fill={v >= 0 ? `rgba(220, 60, 60, ${a})` : `rgba(50, 110, 230, ${a})`} />;
        }),
      )}
    </svg>
  );
}

/** A small line over the run's snapshots, with the selected one marked. */
export function Trend({ values, index, width = 220, height = 34 }: { values: (number | null)[]; index: number; width?: number; height?: number }) {
  const finite = values.filter((v): v is number => v != null && Number.isFinite(v));
  if (finite.length < 2) return <div className="faint" style={{ fontSize: 11.5 }}>Needs two snapshots</div>;
  const lo = Math.min(...finite);
  const hi = Math.max(...finite);
  const x = (i: number) => (values.length < 2 ? 0 : (i / (values.length - 1)) * (width - 4) + 2);
  const y = (v: number) => (hi === lo ? height / 2 : height - 3 - ((v - lo) / (hi - lo)) * (height - 6));
  const d = values.map((v, i) => (v == null || !Number.isFinite(v) ? null : `${x(i)},${y(v)}`)).filter(Boolean).join(" L ");
  const cur = values[index];
  return (
    <svg className="w-trend" width={width} height={height}>
      <path d={`M ${d}`} />
      {cur != null && Number.isFinite(cur) && <circle cx={x(index)} cy={y(cur)} r={3} />}
    </svg>
  );
}

/** Next to a canvas node: the main weight's distribution and spread, colored by health. */
export function NodeWeights({ lw, x, y }: { lw: LayerWeights; x: number; y: number }) {
  const t = mainTensor(lw.tensors)!;
  return (
    <div className={`node-weights ${lw.health}`} style={{ left: x, top: y }} title={lw.issues.map((i) => `${i.tensor}: ${i.message}`).join("\n") || `${t.name}: σ ${fmt(t.std)}, max |w| ${fmt(t.absMax)}`}>
      <Histogram t={t} width={104} height={26} />
      <div className="mono">
        σ {fmt(t.std)} · ∇ {fmt(t.gradNorm)}
      </div>
    </div>
  );
}

/** Inspector detail for one layer across the run. */
export function LayerWeightsDetail({ module, snapshots, index }: { module: string; snapshots: WeightsEvent[]; index: number }) {
  const lw = layerWeights(snapshots, index, module);
  if (!lw) return <div className="faint">This layer has no weights in the run{snapshots.length ? " (the design may have changed since it ran)" : ""}.</div>;
  return (
    <div className="w-detail">
      {lw.issues.map((i, k) => (
        <div key={k} className={`callout ${i.severity === "error" ? "err" : "warn"}`} style={{ marginBottom: 8 }}>
          <b className="mono">{i.tensor}</b> {i.message}
        </div>
      ))}
      {lw.tensors.map((t) => {
        const series = snapshots.map((s) => s.tensors.find((x) => x.name === t.name) ?? null);
        return (
          <div key={t.name} className="w-tensor">
            <div className="row">
              <b className="mono">{t.name.slice(module.length + 1) || t.name}</b>
              <span className="faint mono">{t.shape.join("×")}</span>
            </div>
            <Histogram t={t} width={236} height={44} />
            <div className="w-range faint mono">
              <span>{fmt(t.hist.min)}</span>
              <span>{fmt(t.hist.max)}</span>
            </div>
            <dl className="kv w-stats">
              <dt>mean</dt>
              <dd className="mono">{fmt(t.mean)}</dd>
              <dt>std</dt>
              <dd className="mono">{fmt(t.std)}</dd>
              <dt>max |w|</dt>
              <dd className="mono">{fmt(t.absMax)}</dd>
              <dt>grad norm</dt>
              <dd className="mono">{fmt(t.gradNorm)}</dd>
              {t.nonFinite ? (
                <>
                  <dt>NaN/Inf</dt>
                  <dd className="mono">{t.nonFinite.toLocaleString()}</dd>
                </>
              ) : null}
            </dl>
            {t.grid && (
              <>
                <div className="label">Matrix · {t.shape[0]} outputs × {t.shape.slice(1).reduce((a, b) => a * b, 1)} inputs</div>
                <Heatmap grid={t.grid} width={236} />
              </>
            )}
            {snapshots.length > 1 && (
              <>
                <div className="label">std over training</div>
                <Trend values={series.map((s) => s?.std ?? null)} index={index} />
                <div className="label">grad norm over training</div>
                <Trend values={series.map((s) => s?.gradNorm ?? null)} index={index} />
              </>
            )}
          </div>
        );
      })}
    </div>
  );
}
