import { useEffect, useState } from "react";
import { CircleCheck, Info, LoaderCircle, Sparkles } from "lucide-react";
import type { Cause, RunExplanation } from "@converge/run-protocol";
import type { RunView } from "@converge/core/api";
import { api, errorMessage } from "../api.ts";
import { formatNumber } from "../format.ts";

const LIKELIHOOD_TAG = { high: "err", medium: "warn", low: "" } as const;
const CATEGORY_LABEL: Record<Cause["category"], string> = { config: "Config", code: "Code", data: "Data", environment: "Environment", hardware: "Hardware", length: "Run length" };
const COLLAPSED = 6;

function headline(x: RunExplanation, a: string, b: string): string {
  if (x.verdict === "unknown") return `Can't compare ${b} with ${a} yet.`;
  const pct = `${Math.abs(x.gapPct ?? 0).toFixed(1)}%`;
  if (x.verdict === "within-noise") return `${b} and ${a} are within noise of each other on ${x.metric}.`;
  return `${b} is ${pct} ${x.verdict} than ${a} on ${x.metric}${x.divergedAtStep !== null ? `, and the runs split at step ${formatNumber(x.divergedAtStep)}` : ""}.`;
}

/** "Why are these runs different?": the gap, where the runs split, and every difference ranked by likely cause. */
export function WhyCard({ views }: { views: RunView[] }) {
  const [otherId, setOtherId] = useState(views[1]!.manifest.runId);
  const base = views[0]!;
  const other = views.find((v) => v.manifest.runId === otherId) ?? views[1]!;
  const [x, setX] = useState<RunExplanation | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [all, setAll] = useState(false);
  const [ai, setAi] = useState<{ busy: boolean; text?: string; meta?: string; err?: string }>({ busy: false });

  useEffect(() => {
    if (!views.some((v) => v.manifest.runId === otherId)) setOtherId(views[1]!.manifest.runId);
  }, [views, otherId]);
  useEffect(() => {
    let alive = true;
    setX(null);
    setErr(null);
    setAi({ busy: false });
    api.explainRuns(base.manifest.runId, other.manifest.runId).then(
      (r) => alive && setX(r),
      (e) => alive && setErr(errorMessage(e)),
    );
    return () => {
      alive = false;
    };
  }, [base.manifest.runId, other.manifest.runId, base.summary.lastSeq, other.summary.lastSeq]);

  const explainWithAi = async () => {
    setAi({ busy: true });
    try {
      const r = await api.explainRunsWithAi(base.manifest.runId, other.manifest.runId);
      setAi({ busy: false, text: r.text.trim(), meta: `${r.model}${r.credits !== null ? ` · ${formatNumber(r.credits)} credits` : ""}` });
    } catch (e) {
      setAi({ busy: false, err: errorMessage(e) });
    }
  };

  const causes = x ? (all ? x.causes : x.causes.slice(0, COLLAPSED)) : [];
  return (
    <>
      <div className="row" style={{ margin: "24px 0 10px" }}>
        <div className="section-title" style={{ margin: 0 }}>
          Why are these different?
        </div>
        <div className="spacer" />
        {views.length > 2 && (
          <label className="row muted" style={{ gap: 6, fontSize: 12 }}>
            {base.manifest.name} vs
            <select className="input" style={{ height: 26, width: "auto" }} value={other.manifest.runId} onChange={(e) => setOtherId(e.target.value)}>
              {views.slice(1).map((v) => (
                <option key={v.manifest.runId} value={v.manifest.runId}>
                  {v.manifest.name}
                </option>
              ))}
            </select>
          </label>
        )}
      </div>
      <div className="card card-body">
        {err ? (
          <div className="callout err">{err}</div>
        ) : !x ? (
          <div className="row muted" style={{ gap: 8 }}>
            <LoaderCircle size={14} className="spin" /> Comparing {other.manifest.name} with {base.manifest.name}…
          </div>
        ) : (
          <div className="col" style={{ gap: 12 }}>
            <div>
              <div style={{ fontWeight: 600 }}>{headline(x, base.manifest.name, other.manifest.name)}</div>
              {x.metric && x.a !== null && x.b !== null && (
                <div className="faint" style={{ fontSize: 12, marginTop: 2 }}>
                  Final {x.metric}: {formatNumber(x.a)} → {formatNumber(x.b)} ({x.lowerIsBetter ? "lower" : "higher"} is better) · {base.manifest.name}'s own noise ≈ {(x.noisePct ?? 0).toFixed(1)}%
                </div>
              )}
            </div>

            {x.causes.length > 0 ? (
              <table className="table">
                <thead>
                  <tr>
                    <th style={{ width: 80 }}>Likely</th>
                    <th>What changed</th>
                    <th>Why it ranks here</th>
                  </tr>
                </thead>
                <tbody>
                  {causes.map((c) => (
                    <tr key={`${c.category}:${c.subject}`}>
                      <td>
                        <span className={`tag ${LIKELIHOOD_TAG[c.likelihood]}`}>{c.likelihood}</span>
                      </td>
                      <td>
                        <div className="mono" style={{ overflowWrap: "anywhere" }}>
                          {c.subject}
                        </div>
                        <div className="faint" style={{ fontSize: 11.5 }}>
                          {CATEGORY_LABEL[c.category]}
                          {c.from || c.to ? (
                            <>
                              {" · "}
                              <span className="mono">{c.from ? `${c.from} → ${c.to}` : c.to}</span>
                            </>
                          ) : null}
                        </div>
                      </td>
                      <td className="muted" style={{ fontSize: 12.5 }}>
                        {c.reason}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <div className="muted">No differences found between the two runs.</div>
            )}
            {x.causes.length > COLLAPSED && (
              <button className="btn ghost sm" style={{ alignSelf: "flex-start" }} onClick={() => setAll(!all)}>
                {all ? "Show fewer" : `Show all ${x.causes.length} differences`}
              </button>
            )}

            {x.unchanged.length > 0 && (
              <div className="row" style={{ gap: 6, flexWrap: "wrap", fontSize: 12 }}>
                <span className="faint">Identical:</span>
                {x.unchanged.map((u) => (
                  <span key={u} className="tag ok">
                    <CircleCheck size={10} /> {u}
                  </span>
                ))}
              </div>
            )}
            {x.notes.map((n) => (
              <div key={n} className="row faint" style={{ gap: 6, fontSize: 12, alignItems: "flex-start" }}>
                <Info size={12} style={{ marginTop: 2, flexShrink: 0 }} /> {n}
              </div>
            ))}

            {x.verdict !== "unknown" && (
              <div className="col" style={{ gap: 8 }}>
                {!ai.text && (
                  <button className="btn sm" style={{ alignSelf: "flex-start" }} disabled={ai.busy} onClick={() => void explainWithAi()}>
                    {ai.busy ? <LoaderCircle size={13} className="spin" /> : <Sparkles size={13} />} Explain with AI
                    <span className="faint" style={{ marginLeft: 4 }}>
                      uses credits
                    </span>
                  </button>
                )}
                {ai.err && <div className="callout err">{ai.err}</div>}
                {ai.text && (
                  <div className="callout info" style={{ whiteSpace: "pre-wrap" }}>
                    <div>
                      {ai.text}
                      <div className="faint" style={{ fontSize: 11, marginTop: 6 }}>
                        {ai.meta} · based only on the differences listed above
                      </div>
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
        )}
      </div>
    </>
  );
}
