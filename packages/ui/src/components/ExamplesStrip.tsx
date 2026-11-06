// Five training inputs above the weights view, drawn for their kind of data (image, frame of a
// video, waveform, heatmap, feature bars, token ids), with the true label and what the model
// predicted at the selected training step.
import { useEffect, useRef } from "react";
import type { ExampleLabel, ExamplePrediction, ExamplesEvent, ExampleVisual } from "@converge/run-protocol";

const fmt = (v: number) => (Math.abs(v) >= 1000 || (Math.abs(v) < 0.01 && v !== 0) ? v.toExponential(1) : String(Number(v.toPrecision(3))));

function ImageCanvas({ v, size }: { v: Extract<ExampleVisual, { w: number }>; size: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const cv = ref.current;
    if (!cv) return;
    const bytes = Uint8Array.from(atob(v.data), (ch) => ch.charCodeAt(0));
    const img = new ImageData(v.w, v.h);
    for (let i = 0; i < v.w * v.h; i++) {
      const r = bytes[i * v.c]!;
      img.data[i * 4] = r;
      img.data[i * 4 + 1] = v.c === 3 ? bytes[i * 3 + 1]! : r;
      img.data[i * 4 + 2] = v.c === 3 ? bytes[i * 3 + 2]! : r;
      img.data[i * 4 + 3] = 255;
    }
    cv.getContext("2d")?.putImageData(img, 0, 0);
  }, [v]);
  const scale = size / Math.max(v.w, v.h);
  return <canvas ref={ref} width={v.w} height={v.h} className="ex-img" style={{ width: v.w * scale, height: v.h * scale }} />;
}

export function Visual({ v, size = 72 }: { v: ExampleVisual; size?: number }) {
  const kind = v.kind.replace("recon:", "");
  if ("data" in v) return <ImageCanvas v={v} size={size} />;
  if ("ids" in v)
    return (
      <div className="ex-tokens mono" style={{ width: size * 1.6 }}>
        {v.ids.slice(0, 18).join(" ")}
        {v.length > 18 ? " …" : ""}
      </div>
    );
  if ("min" in v) {
    const n = v.min.length;
    const peak = Math.max(1e-9, ...v.max.map(Math.abs), ...v.min.map(Math.abs));
    const h = size * 0.6;
    const w = size * 1.6;
    const y = (a: number) => h / 2 - (a / peak) * (h / 2 - 1);
    return (
      <svg className="ex-wave" width={w} height={h}>
        {v.max.map((mx, i) => (
          <line key={i} x1={(i / n) * w} x2={(i / n) * w} y1={y(mx)} y2={y(v.min[i]!)} />
        ))}
      </svg>
    );
  }
  if ("rows" in v) {
    const flat = v.values.flat();
    const lo = Math.min(...flat);
    const hi = Math.max(...flat);
    const w = size * 1.6;
    const cw = w / v.cols;
    const ch = Math.min(cw * 2, (size * 0.9) / v.rows);
    return (
      <svg className="ex-heat" width={w} height={ch * v.rows}>
        {v.values.map((row, r) => row.map((x, c) => <rect key={`${r}-${c}`} x={c * cw} y={r * ch} width={cw + 0.3} height={ch + 0.3} style={{ opacity: hi > lo ? (x - lo) / (hi - lo) : 0.5 }} />))}
      </svg>
    );
  }
  // A row of features: one bar each, up from the middle line for positive values.
  const vals = (v as { values: number[] }).values;
  const peak = Math.max(1e-9, ...vals.map(Math.abs));
  const w = size * 1.6;
  const h = size * 0.6;
  const bw = w / Math.max(1, vals.length);
  return (
    <svg className={`ex-bars ${kind}`} width={w} height={h}>
      <line x1={0} x2={w} y1={h / 2} y2={h / 2} className="ex-axis" />
      {vals.map((x, i) => {
        const bh = (Math.abs(x) / peak) * (h / 2 - 1);
        return <rect key={i} x={i * bw + 0.5} y={x >= 0 ? h / 2 - bh : h / 2} width={Math.max(1, bw - 1)} height={Math.max(0.5, bh)} className={x >= 0 ? "pos" : "neg"} />;
      })}
    </svg>
  );
}

function labelText(l: ExampleLabel | undefined, names: string[]): string | null {
  if (!l) return null;
  if ("class" in l) return l.name ?? names[l.class] ?? `class ${l.class}`;
  if ("value" in l) return fmt(l.value);
  return l.values.map(fmt).join(", ");
}

function Prediction({ p, label, names, binary }: { p: ExamplePrediction | undefined; label: ExampleLabel | undefined; names: string[]; binary: boolean }) {
  if (!p) return <span className="faint">no prediction yet</span>;
  if ("kind" in p) return <Visual v={p} size={48} />;
  if ("class" in p) {
    const ok = label && "class" in label ? label.class === p.class : null;
    return (
      <span className={ok === null ? "" : ok ? "ex-ok" : "ex-bad"}>
        {names[p.class] ?? `class ${p.class}`} · {Math.round(p.p * 100)}%
      </span>
    );
  }
  if ("value" in p) {
    if (binary) {
      const cls = p.p >= 0.5 ? 1 : 0;
      const ok = label && "class" in label ? label.class === cls : null;
      return (
        <span className={ok === null ? "" : ok ? "ex-ok" : "ex-bad"}>
          {names[cls] ?? `class ${cls}`} · {Math.round((cls ? p.p : 1 - p.p) * 100)}%
        </span>
      );
    }
    return <span>{fmt(p.value)}</span>;
  }
  if ("tokens" in p) return <span className="mono">{p.tokens.slice(0, 10).join(" ")}…</span>;
  return <span className="mono">{p.values.map(fmt).join(", ")}</span>;
}

export function ExamplesStrip({ examples, predictions, step, binary }: { examples: ExamplesEvent; predictions: ExamplePrediction[] | undefined; step: number | null; binary: boolean }) {
  const names = examples.classNames ?? [];
  return (
    <div className="examples-strip">
      <div className="ex-title">
        <b>Inputs</b>
        <span className="faint">{examples.inputs.length} examples from the data{step != null ? `, predicted at step ${step}` : ""}</span>
      </div>
      {examples.inputs.map((v, i) => (
        <div key={i} className="ex-card">
          <div className="ex-visual">
            <Visual v={v} />
            {"frames" in v && v.frames ? <span className="ex-note">frame {Math.floor(v.frames / 2) + 1}/{v.frames}</span> : null}
          </div>
          {labelText(examples.labels[i], names) !== null && (
            <div className="ex-line">
              <span className="faint">true</span> {labelText(examples.labels[i], names)}
            </div>
          )}
          <div className="ex-line">
            <span className="faint">{predictions?.[i] && "kind" in predictions[i]! ? "rebuilt" : "model"}</span> <Prediction p={predictions?.[i]} label={examples.labels[i]} names={names} binary={binary} />
          </div>
        </div>
      ))}
    </div>
  );
}
