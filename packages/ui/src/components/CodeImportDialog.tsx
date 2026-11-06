// Code → graph: pick a Python file and model class from the project; it's traced on a machine
// (torch.fx and one forward pass) and opens on the canvas.
import { useEffect, useState } from "react";
import { FileCode, LoaderCircle } from "lucide-react";
import type { ImportSummary } from "@converge/run-protocol";
import type { AppState, BuilderImportResult } from "@converge/core/api";
import { api, errorMessage } from "../api.ts";
import { Dialog } from "./ui.tsx";

export function CodeImportDialog({
  state,
  initialFile,
  defaultShape,
  defaultDtype,
  defaultMachine,
  onImported,
  onClose,
}: {
  state: AppState;
  initialFile?: string | null;
  defaultShape?: number[] | null;
  defaultDtype?: "float" | "long";
  defaultMachine?: string | null;
  onImported: (s: ImportSummary, notes: string[]) => void;
  onClose: () => void;
}) {
  const [files, setFiles] = useState<string[] | null>(null);
  const [file, setFile] = useState(initialFile ?? "");
  const [reply, setReply] = useState<BuilderImportResult | null>(null);
  const [className, setClassName] = useState("");
  const [shape, setShape] = useState(defaultShape?.join(",") ?? "");
  const [dtype, setDtype] = useState<"float" | "long">(defaultDtype ?? "float");
  const ready = state.machines.filter((m) => state.probes[m.id]?.ok);
  const [machineId, setMachineId] = useState(defaultMachine && ready.some((m) => m.id === defaultMachine) ? defaultMachine : (ready[0]?.id ?? state.machines[0]?.id ?? ""));
  const [busy, setBusy] = useState<"read" | "trace" | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.builderCodeFiles().then(
      (f) => {
        setFiles(f);
        if (!initialFile && f.length === 1) setFile(f[0]!);
      },
      () => setFiles([]),
    );
  }, [initialFile]);

  // Reading the file tells us its classes and any INPUT_SHAPE it declares.
  useEffect(() => {
    if (!file || !machineId) return;
    let live = true;
    setBusy("read");
    setError(null);
    setReply(null);
    api
      .builderImport({ file, machineId })
      .then((r) => {
        if (!live) return;
        setReply(r);
        if (r.error) setError(r.error);
        setClassName(r.classes.length === 1 ? r.classes[0]! : "");
        if (r.inputShape?.length && !shape) setShape(r.inputShape.join(","));
        if (r.inputDtype) setDtype(r.inputDtype);
      })
      .catch((e) => live && setError(errorMessage(e)))
      .finally(() => live && setBusy(null));
    return () => {
      live = false;
    };
  }, [file, machineId]); // eslint-disable-line react-hooks/exhaustive-deps

  const dims = shape.split(/[,x×\s]+/).filter(Boolean).map(Number);
  const shapeOk = dims.length > 0 && dims.every((n) => Number.isInteger(n) && n > 0);

  const trace = async () => {
    setBusy("trace");
    setError(null);
    try {
      const r = await api.builderImport({ file, className, inputShape: dims, dtype, machineId });
      if (r.error) setError(r.error);
      else if (r.summary) {
        onImported(r.summary, r.notes);
        onClose();
      } else setError(r.need === "shape" ? "Enter the shape of one example." : "Choose the model class.");
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <Dialog
      wide
      title="Open model code as a graph"
      icon={<FileCode size={16} />}
      onClose={onClose}
      footer={
        <>
          <span className="faint" style={{ fontSize: 12, marginRight: "auto" }}>
            Runs one forward pass on the machine to record every layer and shape. Nothing is trained.
          </span>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" disabled={!!busy || !file || !className || !shapeOk || !machineId} onClick={() => void trace()}>
            {busy === "trace" ? <LoaderCircle size={14} className="spin" /> : <FileCode size={14} />} Open as graph
          </button>
        </>
      }
    >
      <div className="grid-2">
        <div className="field">
          <label>File</label>
          <select className="select" value={file} onChange={(e) => setFile(e.target.value)}>
            <option value="">{files === null ? "Looking for model code…" : files.length ? "Choose a file…" : "No PyTorch modules found in the project"}</option>
            {(files ?? []).map((f) => (
              <option key={f} value={f}>
                {f}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label>Model class</label>
          <select className="select" value={className} onChange={(e) => setClassName(e.target.value)} disabled={!reply?.classes.length}>
            <option value="">{busy === "read" ? "Reading the file…" : reply?.classes.length ? "Choose a class…" : "—"}</option>
            {(reply?.classes ?? []).map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
        </div>
      </div>
      <div className="grid-2">
        <div className="field">
          <label>One example's shape (no batch)</label>
          <input className="input mono" value={shape} onChange={(e) => setShape(e.target.value)} placeholder="e.g. 3,224,224 · 128 · 96,8" />
          <span className="hint">{defaultShape ? "From the chosen dataset." : reply?.inputShape ? "From the file's INPUT_SHAPE." : "What forward() gets per example."}</span>
        </div>
        <div className="field">
          <label>Input</label>
          <select className="select" value={dtype} onChange={(e) => setDtype(e.target.value as "float" | "long")}>
            <option value="float">Numbers (images, features, audio…)</option>
            <option value="long">Token ids (text)</option>
          </select>
        </div>
      </div>
      <div className="field">
        <label>Trace on</label>
        <select className="select" value={machineId} onChange={(e) => setMachineId(e.target.value)}>
          {state.machines.map((m) => (
            <option key={m.id} value={m.id}>
              {m.name}
              {state.probes[m.id]?.ok ? "" : " (not reachable)"}
            </option>
          ))}
        </select>
        <span className="hint">Needs PyTorch in that machine's Python. The project's .py files are sent so the model's own imports work.</span>
      </div>
      {error && <div className="callout err" style={{ whiteSpace: "pre-wrap" }}>{error}</div>}
    </Dialog>
  );
}
