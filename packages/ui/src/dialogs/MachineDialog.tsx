import { useState } from "react";
import { Info, LoaderCircle, Server } from "lucide-react";
import type { Machine } from "@converge/run-protocol";
import { api, errorMessage } from "../api.ts";
import { Dialog, useToast } from "../components/ui.tsx";

export function MachineDialog({ machine, onClose }: { machine?: Machine; onClose: () => void }) {
  const toast = useToast();
  const [name, setName] = useState(machine?.name ?? "");
  const [host, setHost] = useState(machine ? machine.host : "");
  const [port, setPort] = useState(machine?.port ? String(machine.port) : "");
  const [identityFile, setIdentityFile] = useState(machine?.identityFile ?? "");
  const [python, setPython] = useState(machine?.python ?? "python3");
  const [rate, setRate] = useState(machine?.hourlyRate !== undefined ? String(machine.hourlyRate) : "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    setBusy(true);
    setError(null);
    const input = {
      name: name.trim(),
      host: host.trim(),
      port: port.trim() ? Number(port) : undefined,
      identityFile: identityFile.trim() || undefined,
      python: python.trim() || "python3",
      hourlyRate: rate.trim() ? Number(rate) : undefined,
    };
    try {
      const saved = machine ? await api.updateMachine(machine.id, input) : await api.addMachine(input);
      const probe = await api.probeMachine(saved.id);
      if (!probe.ok) {
        toast("error", `Saved, but can't reach ${saved.name}`, probe.error);
      } else toast("success", `${saved.name} connected`, probe.gpus?.length ? probe.gpus.map((g) => g.name).join(", ") : "No NVIDIA GPU detected");
      onClose();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      title={machine ? "Edit machine" : "Add GPU machine"}
      icon={<Server size={18} />}
      onClose={onClose}
      footer={
        <>
          <span className="faint" style={{ fontSize: 12 }}>
            Saving tests the connection and installs the agent.
          </span>
          <div className="spacer" />
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" disabled={!host.trim() || busy} onClick={submit}>
            {busy && <LoaderCircle size={14} className="spin" />} {machine ? "Save" : "Connect"}
          </button>
        </>
      }
    >
      <div className="callout info">
        <Info size={15} />
        <div>
          Converlt uses your system <span className="mono">ssh</span> with key-based auth and your <span className="mono">~/.ssh/config</span>. If this is a new
          host, run <span className="mono">ssh {host.trim() || "user@host"}</span> once in a terminal to verify its host key.
        </div>
      </div>
      <div className="field">
        <label>SSH host</label>
        <input className="input mono" autoFocus placeholder="ubuntu@203.0.113.7  or  my-gpu-alias" value={host} onChange={(e) => setHost(e.target.value)} onKeyDown={(e) => e.key === "Enter" && host.trim() && submit()} />
      </div>
      <div className="grid-2">
        <div className="field">
          <label>Display name</label>
          <input className="input" placeholder="A100 box" value={name} onChange={(e) => setName(e.target.value)} />
        </div>
        <div className="field">
          <label>Port</label>
          <input className="input mono" placeholder="22" inputMode="numeric" value={port} onChange={(e) => setPort(e.target.value.replace(/\D/g, ""))} />
        </div>
      </div>
      <div className="grid-2">
        <div className="field">
          <label>Python on the machine</label>
          <input className="input mono" placeholder="python3" value={python} onChange={(e) => setPython(e.target.value)} />
          <span className="hint">Interpreter with PyTorch, e.g. ~/venv/bin/python or a conda env's python.</span>
        </div>
        <div className="field">
          <label>Hourly rate (USD, optional)</label>
          <input className="input mono" placeholder="1.50" inputMode="decimal" value={rate} onChange={(e) => setRate(e.target.value.replace(/[^\d.]/g, ""))} />
          <span className="hint">Used only for cost estimates. Not provider-billed amounts.</span>
        </div>
      </div>
      <div className="field">
        <label>Identity file (optional)</label>
        <input className="input mono" placeholder="~/.ssh/id_ed25519" value={identityFile} onChange={(e) => setIdentityFile(e.target.value)} />
      </div>
      {error && (
        <div className="callout err">
          <Info size={15} />
          <span className="selectable">{error}</span>
        </div>
      )}
    </Dialog>
  );
}
