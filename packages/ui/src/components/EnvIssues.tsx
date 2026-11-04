import { useMemo, useState } from "react";
import { LoaderCircle, OctagonAlert, TriangleAlert, Wrench } from "lucide-react";
import { checkProbe, type EnvIssue, type Machine } from "@converge/run-protocol";
import type { ProbeResult } from "@converge/core/api";
import { api, errorMessage } from "../api.ts";
import { useToast } from "./ui.tsx";

/** Problems with a machine's PyTorch build, driver or GPU support, each with a one-click fix when there is one. */
export function EnvIssues({ machine, probe }: { machine: Machine; probe: ProbeResult | undefined }) {
  const issues = useMemo(() => checkProbe(probe), [probe]);
  const [busy, setBusy] = useState<EnvIssue["id"] | null>(null);
  const [log, setLog] = useState<string | null>(null);
  const toast = useToast();
  if (!issues.length) return null;

  const fix = async (issue: EnvIssue) => {
    setBusy(issue.id);
    setLog(null);
    try {
      const r = await api.installPackages(machine.id, machine.python, { requirements: issue.fix!.requirements });
      if (!r.ok) {
        setLog(r.log);
        toast("error", "Install failed", "The pip output is below.");
        return;
      }
      const left = checkProbe(await api.probeMachine(machine.id));
      if (left.some((i) => i.severity === "error")) toast("info", "Installed, but a problem remains", left[0]!.title);
      else toast("success", "Environment fixed", `${machine.name} is ready to train on the GPU.`);
    } catch (e) {
      toast("error", "Couldn't install", errorMessage(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="col" style={{ gap: 8 }}>
      {issues.map((i) => (
        <div key={i.id} className={`callout ${i.severity === "error" ? "err" : ""}`}>
          {i.severity === "error" ? <OctagonAlert size={15} /> : <TriangleAlert size={15} />}
          <div style={{ flex: 1, minWidth: 0 }}>
            <b>{i.title}</b>
            <div style={{ marginTop: 2 }}>{i.detail}</div>
            {i.fix && (
              <div className="row wrap" style={{ marginTop: 8, gap: 8 }}>
                <button className="btn sm" style={{ whiteSpace: "normal", height: "auto", textAlign: "left" }} disabled={!!busy} onClick={() => void fix(i)} title={i.fix.requirements}>
                  {busy === i.id ? <LoaderCircle size={13} className="spin" /> : <Wrench size={13} />} {i.fix.label}
                </button>
                <span className="faint mono selectable" style={{ fontSize: 11 }}>
                  pip install {i.fix.requirements.replace(/\n/g, " ")}
                </span>
              </div>
            )}
          </div>
        </div>
      ))}
      {log && <pre className="code-block" style={{ maxHeight: 200 }}>{log}</pre>}
    </div>
  );
}
