import { useEffect, useMemo, useRef, useState } from "react";
import { formatNumber } from "../format.ts";

export const SERIES_COLORS = ["var(--s1)", "var(--s2)", "var(--s3)", "var(--s4)", "var(--s5)", "var(--s6)"];

export interface Series {
  name: string;
  color: string;
  points: { x: number; y: number | null }[];
}

function niceTicks(min: number, max: number, count: number): number[] {
  if (!Number.isFinite(min) || !Number.isFinite(max)) return [];
  if (min === max) {
    const pad = Math.abs(min) * 0.1 || 1;
    min -= pad;
    max += pad;
  }
  const raw = (max - min) / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) ?? raw;
  const ticks: number[] = [];
  for (let v = Math.ceil(min / step) * step; v <= max + step * 1e-9; v += step) ticks.push(Number(v.toPrecision(12)));
  return ticks;
}

/** Exponential moving average with debiasing, like TensorBoard's smoothing slider. */
export function smooth(points: { x: number; y: number | null }[], weight: number): { x: number; y: number | null }[] {
  if (weight <= 0) return points;
  let last = 0;
  let n = 0;
  return points.map((p) => {
    if (p.y === null) return p;
    last = last * weight + (1 - weight) * p.y;
    n++;
    return { x: p.x, y: last / (1 - weight ** n) };
  });
}

function useWidth(): [React.RefObject<HTMLDivElement | null>, number] {
  const ref = useRef<HTMLDivElement | null>(null);
  const [w, setW] = useState(400);
  useEffect(() => {
    if (!ref.current) return;
    const ro = new ResizeObserver(([e]) => setW(Math.max(120, Math.floor(e!.contentRect.width))));
    ro.observe(ref.current);
    return () => ro.disconnect();
  }, []);
  return [ref, w];
}

export function LineChart({
  series,
  height = 210,
  xLabel = "step",
  yFormat = (v: number) => formatNumber(v, 3),
  xFormat = (v: number) => formatNumber(v, 4),
  yMin,
  yMax,
  legend = series.length > 1,
}: {
  series: Series[];
  height?: number;
  xLabel?: string;
  yFormat?: (v: number) => string;
  xFormat?: (v: number) => string;
  yMin?: number;
  yMax?: number;
  legend?: boolean;
}) {
  const [ref, width] = useWidth();
  const [hoverX, setHoverX] = useState<number | null>(null);
  const pad = { l: 52, r: 12, t: 8, b: 24 };
  const iw = width - pad.l - pad.r;
  const ih = height - pad.t - pad.b;

  const bounds = useMemo(() => {
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    for (const s of series)
      for (const p of s.points) {
        if (p.x < x0) x0 = p.x;
        if (p.x > x1) x1 = p.x;
        if (p.y === null) continue;
        if (p.y < y0) y0 = p.y;
        if (p.y > y1) y1 = p.y;
      }
    if (yMin !== undefined) y0 = yMin;
    if (yMax !== undefined) y1 = yMax;
    if (x0 === x1) x1 = x0 + 1;
    if (!Number.isFinite(y0)) return null;
    const yt = niceTicks(y0, y1, 4);
    return { x0, x1, y0: Math.min(y0, yt[0] ?? y0), y1: Math.max(y1, yt.at(-1) ?? y1), yt, xt: niceTicks(x0, x1, Math.max(2, Math.floor(iw / 90))) };
  }, [series, yMin, yMax, iw]);

  if (!bounds) {
    return (
      <div ref={ref} className="chart" style={{ height, display: "grid", placeItems: "center" }}>
        <span className="faint">No data yet</span>
      </div>
    );
  }
  const { x0, x1, y0, y1, yt, xt } = bounds;
  const sx = (x: number) => pad.l + ((x - x0) / (x1 - x0)) * iw;
  const sy = (y: number) => pad.t + ih - ((y - y0) / (y1 - y0 || 1)) * ih;

  const paths = series.map((s) => {
    let d = "";
    let pen = false;
    for (const p of s.points) {
      if (p.y === null) {
        pen = false;
        continue;
      }
      d += `${pen ? "L" : "M"}${sx(p.x).toFixed(1)},${sy(p.y).toFixed(1)}`;
      pen = true;
    }
    return d;
  });

  // Non-finite points are marked on the x-axis so a NaN is visible, not just a gap.
  const nanMarks = series.flatMap((s) => s.points.filter((p) => p.y === null).slice(0, 50).map((p) => ({ x: p.x, color: s.color })));

  let hover: { x: number; rows: { name: string; color: string; y: number | null }[] } | null = null;
  if (hoverX !== null) {
    const xv = x0 + ((hoverX - pad.l) / iw) * (x1 - x0);
    const rows = series.map((s) => {
      let best = s.points[0];
      for (const p of s.points) if (Math.abs(p.x - xv) < Math.abs((best?.x ?? Infinity) - xv)) best = p;
      return { name: s.name, color: s.color, y: best?.y ?? null, x: best?.x ?? xv };
    });
    hover = { x: rows[0]?.x ?? xv, rows };
  }

  return (
    <div ref={ref} className="chart" style={{ position: "relative" }}>
      <svg
        width={width}
        height={height}
        onMouseMove={(e) => {
          const rect = e.currentTarget.getBoundingClientRect();
          const x = e.clientX - rect.left;
          setHoverX(x >= pad.l && x <= pad.l + iw ? x : null);
        }}
        onMouseLeave={() => setHoverX(null)}
      >
        <g className="axis">
          {yt.map((t) => (
            <g key={`y${t}`}>
              <line className="gridline" x1={pad.l} x2={pad.l + iw} y1={sy(t)} y2={sy(t)} />
              <text x={pad.l - 8} y={sy(t) + 3.5} textAnchor="end">
                {yFormat(t)}
              </text>
            </g>
          ))}
          {xt.map((t) => (
            <text key={`x${t}`} x={sx(t)} y={height - 6} textAnchor="middle">
              {xFormat(t)}
            </text>
          ))}
        </g>
        {paths.map((d, i) => (
          <path key={i} d={d} fill="none" stroke={series[i]!.color} strokeWidth={1.7} strokeLinejoin="round" strokeLinecap="round" />
        ))}
        {nanMarks.map((m, i) => (
          <g key={`n${i}`}>
            <line x1={sx(m.x)} x2={sx(m.x)} y1={pad.t} y2={pad.t + ih} stroke="var(--err)" strokeDasharray="3 3" strokeOpacity={0.6} />
            <circle cx={sx(m.x)} cy={pad.t + ih} r={3} fill="var(--err)" />
          </g>
        ))}
        {hover && (
          <g>
            <line x1={sx(hover.x)} x2={sx(hover.x)} y1={pad.t} y2={pad.t + ih} stroke="var(--text-3)" strokeDasharray="2 3" />
            {hover.rows.map((r, i) => r.y !== null && <circle key={i} cx={sx(hover!.x)} cy={sy(r.y)} r={3.5} fill={r.color} stroke="var(--surface)" strokeWidth={1.5} />)}
          </g>
        )}
      </svg>
      {hover && (
        <div className="chart-tooltip" style={{ left: Math.min(sx(hover.x) + 12, width - 170), top: 6 }}>
          <div className="faint" style={{ marginBottom: 3 }}>
            {xLabel} {xFormat(hover.x)}
          </div>
          {hover.rows.map((r, i) => (
            <div key={i} className="row" style={{ gap: 6 }}>
              <span className="swatch" style={{ background: r.color }} />
              <span className="muted" style={{ maxWidth: 140 }}>{series.length > 1 ? r.name : ""}</span>
              <span className="mono" style={{ marginLeft: "auto", paddingLeft: 8 }}>
                {r.y === null ? "NaN" : formatNumber(r.y, 5)}
              </span>
            </div>
          ))}
        </div>
      )}
      {legend && (
        <div className="legend">
          {series.map((s) => (
            <span key={s.name}>
              <span className="swatch" style={{ background: s.color }} />
              {s.name}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

export function Sparkline({ values, width = 84, height = 24, color = "var(--s1)" }: { values: (number | null)[]; width?: number; height?: number; color?: string }) {
  const finite = values.filter((v): v is number => v !== null);
  if (finite.length < 2) return <svg width={width} height={height} />;
  const min = Math.min(...finite);
  const max = Math.max(...finite);
  let d = "";
  let pen = false;
  values.forEach((v, i) => {
    if (v === null) {
      pen = false;
      return;
    }
    const x = (i / (values.length - 1)) * (width - 2) + 1;
    const y = height - 2 - ((v - min) / (max - min || 1)) * (height - 4);
    d += `${pen ? "L" : "M"}${x.toFixed(1)},${y.toFixed(1)}`;
    pen = true;
  });
  const hasNaN = values.some((v) => v === null);
  return (
    <svg width={width} height={height} style={{ display: "block" }}>
      <path d={d} fill="none" stroke={hasNaN ? "var(--err)" : color} strokeWidth={1.5} strokeLinejoin="round" />
    </svg>
  );
}
