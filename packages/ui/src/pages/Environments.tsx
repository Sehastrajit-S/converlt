import { useCallback, useEffect, useMemo, useState } from "react";
import { Boxes, CircleCheck, CircleX, Cloud, FileText, LoaderCircle, Package, Plus, RefreshCw, Search, Server, Trash2, Zap } from "lucide-react";
import type { Machine } from "@converge/run-protocol";
import type { AppState, EnvInfo, EnvList, EnvOpResult, EnvPackage } from "@converge/core/api";
import { api, errorMessage } from "../api.ts";
import { Dialog, Empty, Segmented, Switch, useToast } from "../components/ui.tsx";

/** Whether runs on `m` use this environment's interpreter. */
function inUse(m: Machine, env: EnvInfo): boolean {
  const py = m.python.trim();
  if (py === env.python) return true;
  if (py.startsWith("~/") && env.python.endsWith(py.slice(1))) return true;
  return env.kind === "system" && /^python3?$/.test(py);
}

export function Environments({ state, initialMachineId }: { state: AppState; initialMachineId?: string | null }) {
  const [machineId, setMachineId] = useState<string | null>(initialMachineId ?? state.machines[0]?.id ?? null);
  useEffect(() => {
    if (initialMachineId) setMachineId(initialMachineId);
  }, [initialMachineId]);
  const machine = state.machines.find((m) => m.id === machineId) ?? state.machines[0] ?? null;

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h1 className="page-title">Environments</h1>
          <div className="page-sub">Python environments on each machine: see what has PyTorch and CUDA, create venvs or conda envs, install packages, and pick the one runs use.</div>
        </div>
      </div>
      {state.machines.length === 0 ? (
        <div className="card">
          <Empty icon={<Server size={24} />} title="No machines yet">
            Add a machine in Compute, or launch a cloud GPU, to manage its environments.
          </Empty>
        </div>
      ) : (
        <>
          <div className="machine-tabs">
            {state.machines.map((m) => (
              <button key={m.id} className={`machine-tab ${m.id === machine?.id ? "on" : ""}`} onClick={() => setMachineId(m.id)}>
                {m.cloudPodId ? <Cloud size={14} /> : <Server size={14} />}
                <span className="truncate">{m.name}</span>
              </button>
            ))}
          </div>
          {machine && <MachineEnvs key={machine.id} machine={machine} />}
        </>
      )}
    </div>
  );
}

function MachineEnvs({ machine }: { machine: Machine }) {
  const toast = useToast();
  const [list, setList] = useState<EnvList | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [creating, setCreating] = useState(false);
  const [packagesOf, setPackagesOf] = useState<EnvInfo | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setList(await api.listEnvs(machine.id));
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setLoading(false);
    }
  }, [machine.id]);
  useEffect(() => {
    void load();
  }, [load]);

  const use = async (env: EnvInfo) => {
    try {
      await api.useEnv(machine.id, env.python);
      toast("success", `Runs on ${machine.name} now use ${env.name}`, env.python);
    } catch (e) {
      toast("error", "Could not switch environment", errorMessage(e));
    }
  };
  const remove = async (env: EnvInfo) => {
    if (!confirm(`Delete the environment ${env.name} on ${machine.name}? Its packages are removed.`)) return;
    try {
      await api.removeEnv(machine.id, env.name);
      toast("success", `Deleted ${env.name}`);
      void load();
    } catch (e) {
      toast("error", "Could not delete", errorMessage(e));
    }
  };

  return (
    <>
      <div className="toolbar">
        <div className="env-current">
          <Zap size={14} />
          Runs use <span className="mono">{machine.python}</span>
        </div>
        <div className="spacer" />
        <button className="btn ghost sm" onClick={() => void load()} disabled={loading}>
          <RefreshCw size={13} className={loading ? "spin" : ""} /> Refresh
        </button>
        <button className="btn primary sm" onClick={() => setCreating(true)} disabled={!list}>
          <Plus size={14} /> New environment
        </button>
      </div>
      {error ? (
        <div className="callout err">{error}</div>
      ) : !list ? (
        <div className="card">
          <div className="empty col" style={{ alignItems: "center", gap: 10 }}>
            <LoaderCircle className="spin" />
            <span className="faint">Looking for Python environments on {machine.name}…</span>
          </div>
        </div>
      ) : (
        <div className="env-grid">
          {list.envs.map((env) => {
            const current = inUse(machine, env);
            return (
              <div key={env.prefix + env.python} className={`card env-card ${current ? "current" : ""}`}>
                <div className="row" style={{ gap: 10 }}>
                  <div className={`env-icon ${env.kind}`}>
                    <Boxes size={16} />
                  </div>
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <div className="row" style={{ gap: 6 }}>
                      <b className="truncate">{env.name}</b>
                      <span className="tag">{env.kind === "system" ? "system" : env.kind}</span>
                      {current && <span className="tag accent">in use</span>}
                    </div>
                    <div className="mono faint truncate" style={{ fontSize: 11.5, marginTop: 2 }} title={env.python}>
                      {env.python}
                    </div>
                  </div>
                </div>
                {env.error ? (
                  <div className="callout err" style={{ marginTop: 10 }}>
                    {env.error}
                  </div>
                ) : (
                  <div className="env-facts">
                    <span>
                      <b>Python</b> {env.version ?? "?"}
                    </span>
                    <span className={env.torch ? "" : "faint"}>
                      <b>PyTorch</b> {env.torch ?? "not installed"}
                    </span>
                    <span className={env.cudaAvailable ? "ok" : env.torch ? "bad" : "faint"}>
                      {env.cudaAvailable ? <CircleCheck size={12} /> : <CircleX size={12} />}
                      <b>CUDA</b> {env.cudaAvailable ? env.cuda : env.torch ? "unavailable" : "—"}
                    </span>
                    <span className="faint">{env.packages ?? "?"} packages</span>
                  </div>
                )}
                <div className="env-actions">
                  {!current && (
                    <button className="btn primary sm" onClick={() => void use(env)}>
                      Use for runs
                    </button>
                  )}
                  <button className="btn sm" onClick={() => setPackagesOf(env)}>
                    <Package size={13} /> Packages
                  </button>
                  <span className="spacer" />
                  {env.managed && (
                    <button className="btn ghost sm icon" title="Delete environment" onClick={() => void remove(env)}>
                      <Trash2 size={14} />
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
      {creating && list && (
        <CreateEnvDialog
          machine={machine}
          condaAvailable={!!list.conda}
          root={list.root}
          onClose={() => setCreating(false)}
          onCreated={() => {
            setCreating(false);
            void load();
          }}
        />
      )}
      {packagesOf && <PackagesDialog machine={machine} env={packagesOf} onClose={() => setPackagesOf(null)} onChanged={() => void load()} />}
    </>
  );
}

function OpLog({ result }: { result: EnvOpResult }) {
  return (
    <div className={`callout ${result.ok ? "info" : "err"}`} style={{ display: "block" }}>
      <b>{result.ok ? "Done" : "Failed"}</b>
      <pre className="op-log selectable">{result.log.split("\n").slice(-30).join("\n")}</pre>
    </div>
  );
}

function useRequirements() {
  const [req, setReq] = useState<string | null>(null);
  useEffect(() => {
    api.projectRequirements().then(setReq, () => setReq(null));
  }, []);
  return req;
}

const splitPackages = (s: string) => s.split(/[\s,]+/).map((x) => x.trim()).filter(Boolean);

function CreateEnvDialog({ machine, condaAvailable, root, onClose, onCreated }: { machine: Machine; condaAvailable: boolean; root: string; onClose: () => void; onCreated: () => void }) {
  const toast = useToast();
  const requirements = useRequirements();
  const [name, setName] = useState("train");
  const [kind, setKind] = useState<"venv" | "conda">("venv");
  const [pyVersion, setPyVersion] = useState("3.11");
  // Cloud images ship PyTorch + CUDA: reuse them instead of downloading GBs again.
  const [systemSite, setSystemSite] = useState(!!machine.cloudPodId);
  const [packages, setPackages] = useState("");
  const [withReq, setWithReq] = useState(true);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<EnvOpResult | null>(null);
  const reqLines = useMemo(() => requirements?.split("\n").filter((l) => l.trim() && !l.trim().startsWith("#")).length ?? 0, [requirements]);

  const create = async () => {
    setBusy(true);
    setResult(null);
    try {
      const r = await api.createEnv(machine.id, {
        name: name.trim(),
        kind,
        pythonVersion: kind === "conda" ? pyVersion : undefined,
        systemSitePackages: kind === "venv" ? systemSite : undefined,
        packages: splitPackages(packages),
        requirements: withReq && requirements ? requirements : undefined,
      });
      setResult(r);
      if (r.ok) {
        toast("success", `Created ${name} on ${machine.name}`);
        onCreated();
      }
    } catch (e) {
      setResult({ ok: false, log: errorMessage(e) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      title={`New environment on ${machine.name}`}
      icon={<Boxes size={16} />}
      onClose={busy ? () => {} : onClose}
      footer={
        <>
          {busy && (
            <span className="faint row" style={{ marginRight: "auto", fontSize: 12 }}>
              <LoaderCircle size={13} className="spin" /> Creating and installing. Large packages can take a few minutes.
            </span>
          )}
          <button className="btn ghost" onClick={onClose} disabled={busy}>
            Close
          </button>
          <button className="btn primary" onClick={() => void create()} disabled={busy || !/^[A-Za-z0-9][\w.-]{0,39}$/.test(name.trim())}>
            {busy ? <LoaderCircle size={14} className="spin" /> : <Plus size={14} />} Create
          </button>
        </>
      }
    >
      <div className="grid-2">
        <div className="field">
          <label>Name</label>
          <input className="input mono" value={name} onChange={(e) => setName(e.target.value)} />
          <span className="hint mono">
            {root}/{name || "…"}
          </span>
        </div>
        <div className="field">
          <label>Type</label>
          <Segmented
            value={kind}
            onChange={setKind}
            options={[
              { value: "venv", label: "venv" },
              { value: "conda", label: condaAvailable ? "conda" : "conda (not installed)" },
            ]}
          />
        </div>
      </div>
      {kind === "conda" ? (
        <div className="field">
          <label>Python version</label>
          <Segmented
            value={pyVersion}
            onChange={setPyVersion}
            options={["3.10", "3.11", "3.12", "3.13"].map((v) => ({ value: v, label: v }))}
          />
        </div>
      ) : (
        <div className="option-row">
          <div>
            <div style={{ fontWeight: 600 }}>Reuse the machine's packages</div>
            <div className="hint">See the machine Python's packages (like a preinstalled PyTorch with CUDA) instead of reinstalling them. Uses {machine.python}.</div>
          </div>
          <Switch on={systemSite} onChange={setSystemSite} label="Reuse system packages" />
        </div>
      )}
      <div className="field">
        <label>Packages (optional)</label>
        <input className="input mono" placeholder="torch torchvision wandb transformers==4.46.0" value={packages} onChange={(e) => setPackages(e.target.value)} />
      </div>
      {requirements !== null && (
        <div className="option-row">
          <div>
            <div style={{ fontWeight: 600 }} className="row">
              <FileText size={14} /> Install requirements.txt
            </div>
            <div className="hint">
              From the open project: {reqLines} requirement{reqLines === 1 ? "" : "s"}.
            </div>
          </div>
          <Switch on={withReq} onChange={setWithReq} label="Install requirements.txt" />
        </div>
      )}
      {kind === "conda" && !condaAvailable && <div className="callout err">conda isn't installed on this machine. Use a venv, or install Miniconda first.</div>}
      {result && <OpLog result={result} />}
    </Dialog>
  );
}

function PackagesDialog({ machine, env, onClose, onChanged }: { machine: Machine; env: EnvInfo; onClose: () => void; onChanged: () => void }) {
  const requirements = useRequirements();
  const [pkgs, setPkgs] = useState<EnvPackage[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [install, setInstall] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<EnvOpResult | null>(null);

  const load = useCallback(() => {
    api.envPackages(machine.id, env.python).then(setPkgs, (e) => setError(errorMessage(e)));
  }, [machine.id, env.python]);
  useEffect(load, [load]);

  const run = async (spec: { packages?: string[]; requirements?: string }) => {
    setBusy(true);
    setResult(null);
    try {
      const r = await api.installPackages(machine.id, env.python, spec);
      setResult(r);
      if (r.ok) {
        setInstall("");
        load();
        onChanged();
      }
    } catch (e) {
      setResult({ ok: false, log: errorMessage(e) });
    } finally {
      setBusy(false);
    }
  };

  const q = query.trim().toLowerCase();
  const shown = (pkgs ?? []).filter((p) => !q || p.name.toLowerCase().includes(q));

  return (
    <Dialog title={`Packages in ${env.name}`} icon={<Package size={16} />} onClose={busy ? () => {} : onClose} wide>
      <div className="row" style={{ gap: 8 }}>
        <input
          className="input mono"
          style={{ flex: 1 }}
          placeholder="Install: wandb lightning==2.4.0"
          value={install}
          onChange={(e) => setInstall(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && install.trim() && !busy && void run({ packages: splitPackages(install) })}
        />
        <button className="btn primary" disabled={busy || !install.trim()} onClick={() => void run({ packages: splitPackages(install) })}>
          {busy ? <LoaderCircle size={14} className="spin" /> : <Plus size={14} />} Install
        </button>
        {requirements !== null && (
          <button className="btn" disabled={busy} onClick={() => void run({ requirements })} title="pip install -r the open project's requirements.txt">
            <FileText size={14} /> requirements.txt
          </button>
        )}
      </div>
      {result && <OpLog result={result} />}
      <div className="search" style={{ width: "100%" }}>
        <Search size={14} />
        <input className="input" placeholder={`Filter ${pkgs?.length ?? ""} packages`} value={query} onChange={(e) => setQuery(e.target.value)} />
      </div>
      {error ? (
        <div className="callout err">{error}</div>
      ) : !pkgs ? (
        <div className="empty">
          <LoaderCircle className="spin" />
        </div>
      ) : (
        <div className="pkg-list">
          {shown.map((p) => (
            <div key={p.name} className="pkg-row">
              <span className="mono">{p.name}</span>
              <span className="mono faint">{p.version}</span>
            </div>
          ))}
        </div>
      )}
    </Dialog>
  );
}
