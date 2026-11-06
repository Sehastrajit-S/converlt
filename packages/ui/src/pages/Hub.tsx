import { useCallback, useEffect, useRef, useState } from "react";
import { Check, CircleCheck, CircleX, Cloud, Copy, Database, Download, ExternalLink, FileText, Heart, KeyRound, LoaderCircle, Lock, Package, Search, Server, Trash2 } from "lucide-react";
import type { Machine } from "@converge/run-protocol";
import type { AppState, HubAccounts, HubDetails, HubItem, HubJob, HubKind, HubSource } from "@converge/core/api";
import { api, errorMessage, ask } from "../api.ts";
import { Dialog, Empty, Segmented, useToast } from "../components/ui.tsx";
import { formatBytes, timeAgo } from "../format.ts";

const compact = (n: number | null) => (n === null ? null : n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : String(n));
const hubRoot = (m: Machine | undefined) => (m?.cloudPodId ? "/workspace/.converge/hub" : "~/.converge/hub");

function predictedPath(m: Machine | undefined, source: HubSource, kind: HubKind, id: string): string {
  return source === "huggingface" ? `${hubRoot(m)}/hf/${kind}s/${id}` : `${hubRoot(m)}/kaggle/${kind}s/${id}`;
}

function snippet(source: HubSource, kind: HubKind, path: string): string {
  if (source === "huggingface" && kind === "model")
    return `from transformers import AutoModelForCausalLM, AutoTokenizer\n\npath = "${path}"\ntokenizer = AutoTokenizer.from_pretrained(path)\nmodel = AutoModelForCausalLM.from_pretrained(path, device_map="auto")`;
  if (source === "huggingface") return `from datasets import load_dataset\n\nds = load_dataset("${path}")\nprint(ds)`;
  return `import os\n\npath = "${path}"\nfor root, _, files in os.walk(path):\n    print(root, files[:5])`;
}

export function Hub({ state, initialMachineId }: { state: AppState; initialMachineId?: string | null }) {
  const toast = useToast();
  const [source, setSource] = useState<HubSource>("huggingface");
  const [kind, setKind] = useState<HubKind>("model");
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<HubItem[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<HubItem | null>(null);
  const [accounts, setAccounts] = useState<HubAccounts | null>(null);
  const [editingAccounts, setEditingAccounts] = useState(false);
  const [machineId, setMachineId] = useState<string | null>(initialMachineId ?? state.machines[0]?.id ?? null);
  const machine = state.machines.find((m) => m.id === machineId) ?? state.machines[0];
  const seq = useRef(0);

  useEffect(() => {
    api.hubAccounts().then(setAccounts, () => {});
  }, []);

  // Search as you type (debounced); the newest query wins.
  useEffect(() => {
    const n = ++seq.current;
    setSearching(true);
    const t = setTimeout(
      () =>
        api
          .hubSearch(source, kind, query)
          .then((r) => {
            if (n !== seq.current) return;
            setResults(r);
            setError(null);
            setSelected((s) => (s && r.some((x) => x.id === s.id) ? s : (r[0] ?? null)));
          })
          .catch((e) => n === seq.current && setError(errorMessage(e)))
          .finally(() => n === seq.current && setSearching(false)),
      query ? 350 : 0,
    );
    return () => clearTimeout(t);
  }, [source, kind, query]);

  const jobs = useJobs(machine?.id ?? null);

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h1 className="page-title">Datasets & Models</h1>
          <div className="page-sub">Search Hugging Face and Kaggle, then download straight onto a GPU machine. Files never pass through this computer.</div>
        </div>
        <div className="spacer" />
        <button className="btn ghost sm" onClick={() => setEditingAccounts(true)}>
          <KeyRound size={13} /> Accounts
          {accounts && (
            <span className="faint" style={{ fontSize: 11.5 }}>
              {[accounts.huggingface && "HF", accounts.kaggle && "Kaggle"].filter(Boolean).join(" · ") || "none"}
            </span>
          )}
        </button>
      </div>

      <div className="toolbar">
        <Segmented<HubSource>
          value={source}
          onChange={(s) => {
            setSource(s);
            setSelected(null);
          }}
          options={[
            { value: "huggingface", label: "Hugging Face" },
            { value: "kaggle", label: "Kaggle" },
          ]}
        />
        <Segmented<HubKind>
          value={kind}
          onChange={(k) => {
            setKind(k);
            setSelected(null);
          }}
          options={[
            { value: "model", label: "Models" },
            { value: "dataset", label: "Datasets" },
          ]}
        />
        <div className="spacer" />
        <div className="search" style={{ width: 340 }}>
          <Search size={14} />
          <input className="input" placeholder={kind === "model" ? "llama, qwen, whisper, resnet…" : "cifar, imagenet, squad, titanic…"} value={query} onChange={(e) => setQuery(e.target.value)} />
        </div>
      </div>

      <div className="hub-layout">
        <div className="card hub-results">
          {error ? (
            <div className="callout err" style={{ margin: 12 }}>
              {error}
            </div>
          ) : !results ? (
            <div className="empty">
              <LoaderCircle className="spin" />
            </div>
          ) : results.length === 0 ? (
            <div className="empty faint">Nothing matches “{query}”.</div>
          ) : (
            <div className={searching ? "hub-list dim" : "hub-list"}>
              {results.map((r) => (
                <button key={r.id} className={`hub-row ${selected?.id === r.id ? "sel" : ""}`} onClick={() => setSelected(r)}>
                  <span className={`hub-icon ${r.kind}`}>{r.kind === "model" ? <Package size={15} /> : <Database size={15} />}</span>
                  <span className="hub-text">
                    <span className="row" style={{ gap: 6 }}>
                      <b className="truncate">{r.title}</b>
                      {r.gated && (
                        <span className="tag warn" title="Requires accepting the license on the website and a token">
                          <Lock size={10} /> gated
                        </span>
                      )}
                    </span>
                    {r.title !== r.id && <span className="mono faint truncate" style={{ fontSize: 11 }}>{r.id}</span>}
                    {r.subtitle && <span className="faint truncate" style={{ fontSize: 12 }}>{r.subtitle}</span>}
                  </span>
                  <span className="hub-stats">
                    {r.downloads !== null && (
                      <span title="Downloads">
                        <Download size={11} /> {compact(r.downloads)}
                      </span>
                    )}
                    {r.likes !== null && (
                      <span title="Likes / votes">
                        <Heart size={11} /> {compact(r.likes)}
                      </span>
                    )}
                    {r.sizeBytes !== null && <span>{formatBytes(r.sizeBytes)}</span>}
                  </span>
                </button>
              ))}
            </div>
          )}
        </div>
        <div className="hub-side">
          {selected ? (
            <ItemDetail
              key={`${selected.source}:${selected.kind}:${selected.id}`}
              item={selected}
              machines={state.machines}
              machine={machine}
              onMachine={setMachineId}
              accounts={accounts}
              onNeedAccount={() => setEditingAccounts(true)}
              onStarted={() => void jobs.reload()}
            />
          ) : (
            <div className="card">
              <Empty icon={<Search size={22} />} title="Pick something to see its details" />
            </div>
          )}
          <MachineDownloads machine={machine} jobs={jobs.data} error={jobs.error} onRemove={async (j) => {
            if (!machine || !(await ask(`Delete ${j.id} from ${machine.name}? Its files are removed from the machine.`, "Delete"))) return;
            try {
              await api.hubRemove(machine.id, j.jobId);
              await jobs.reload();
            } catch (e) {
              toast("error", "Could not delete", errorMessage(e));
            }
          }} />
        </div>
      </div>

      {editingAccounts && accounts && (
        <AccountsDialog
          accounts={accounts}
          onClose={() => setEditingAccounts(false)}
          onSaved={(a) => {
            setAccounts(a);
            setEditingAccounts(false);
          }}
        />
      )}
    </div>
  );
}

function useJobs(machineId: string | null) {
  const [data, setData] = useState<HubJob[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const reload = useCallback(async () => {
    if (!machineId) return;
    try {
      setData(await api.hubJobs(machineId));
      setError(null);
    } catch (e) {
      setError(errorMessage(e));
    }
  }, [machineId]);
  useEffect(() => {
    setData(null);
    void reload();
  }, [reload]);
  // Poll faster while something is downloading.
  const busy = data?.some((j) => j.status === "downloading");
  useEffect(() => {
    const iv = setInterval(() => void reload(), busy ? 3000 : 20000);
    return () => clearInterval(iv);
  }, [reload, busy]);
  return { data, error, reload };
}

function CopyButton({ text, label }: { text: string; label?: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      className="btn ghost sm"
      title="Copy"
      onClick={() => {
        void navigator.clipboard.writeText(text);
        setDone(true);
        setTimeout(() => setDone(false), 1200);
      }}
    >
      {done ? <Check size={13} /> : <Copy size={13} />}
      {label}
    </button>
  );
}

function ItemDetail({
  item,
  machines,
  machine,
  onMachine,
  accounts,
  onNeedAccount,
  onStarted,
}: {
  item: HubItem;
  machines: Machine[];
  machine: Machine | undefined;
  onMachine: (id: string) => void;
  accounts: HubAccounts | null;
  onNeedAccount: () => void;
  onStarted: () => void;
}) {
  const toast = useToast();
  const [details, setDetails] = useState<HubDetails | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [variant, setVariant] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.hubDetails(item.source, item.kind, item.id).then(
      (d) => {
        setDetails(d);
        setVariant(d.variants[0]?.handle ?? null);
      },
      (e) => setError(errorMessage(e)),
    );
  }, [item]);

  const d = details ?? { ...item, files: [], fileCount: 0, description: item.subtitle, variants: [] };
  const downloadId = item.source === "kaggle" && item.kind === "model" ? variant : item.id;
  const needsKaggle = item.source === "kaggle" && !accounts?.kaggle;
  const needsHf = item.source === "huggingface" && d.gated && !accounts?.huggingface;
  const path = machine && downloadId ? predictedPath(machine, item.source, item.kind, downloadId) : "";

  const download = async () => {
    if (!machine || !downloadId) return;
    if (needsKaggle || needsHf) {
      onNeedAccount();
      return;
    }
    setBusy(true);
    try {
      await api.hubDownload(machine.id, item.source, item.kind, downloadId);
      toast("success", `Downloading ${downloadId} on ${machine.name}`, "It keeps going if you close the editor. Progress is below.");
      onStarted();
    } catch (e) {
      toast("error", "Could not start the download", errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <div className="card hub-detail">
        <div className="row" style={{ gap: 10, alignItems: "flex-start" }}>
          <span className={`hub-icon big ${item.kind}`}>{item.kind === "model" ? <Package size={18} /> : <Database size={18} />}</span>
          <div style={{ minWidth: 0, flex: 1 }}>
            <div style={{ fontWeight: 650, fontSize: 15 }} className="truncate">
              {d.title}
            </div>
            <div className="row mono faint" style={{ fontSize: 11.5, gap: 4 }}>
              <span className="truncate">{d.id}</span>
            </div>
          </div>
          <a className="btn ghost sm icon" href={d.url} target="_blank" rel="noreferrer" title="Open on the website">
            <ExternalLink size={14} />
          </a>
        </div>
        <div className="hub-facts">
          {d.downloads !== null && (
            <span>
              <b>{compact(d.downloads)}</b> downloads
            </span>
          )}
          {d.likes !== null && (
            <span>
              <b>{compact(d.likes)}</b> {item.source === "kaggle" ? "votes" : "likes"}
            </span>
          )}
          {d.sizeBytes !== null && (
            <span>
              <b>{formatBytes(d.sizeBytes)}</b>
              {d.fileCount ? ` · ${d.fileCount} files` : ""}
            </span>
          )}
          {d.license && (
            <span>
              <b>{d.license}</b> license
            </span>
          )}
          {d.updated && <span>updated {timeAgo(Date.parse(d.updated) / 1000)}</span>}
        </div>
        {d.gated && (
          <div className="callout" style={{ marginTop: 10 }}>
            <Lock size={14} />
            <span>
              Gated: accept its license on the Hugging Face page, then add your Hugging Face token under Accounts.
            </span>
          </div>
        )}
        {d.description && <p className="muted hub-desc">{d.description}</p>}
        {error && <div className="callout err">{error}</div>}
        {details && details.files.length > 0 && (
          <div className="hub-files">
            {details.files.slice(0, 6).map((f) => (
              <div key={f.path} className="pkg-row">
                <span className="mono truncate">
                  <FileText size={11} /> {f.path}
                </span>
                <span className="mono faint">{f.size !== null ? formatBytes(f.size) : ""}</span>
              </div>
            ))}
            {details.fileCount > 6 && <div className="faint" style={{ fontSize: 11.5, padding: "4px 12px" }}>+ {details.fileCount - 6} more files</div>}
          </div>
        )}
        {details && details.variants.length > 0 && (
          <div className="field" style={{ marginTop: 10 }}>
            <label>Variant</label>
            <select className="select" value={variant ?? ""} onChange={(e) => setVariant(e.target.value)}>
              {details.variants.map((v) => (
                <option key={v.handle} value={v.handle}>
                  {v.label}
                  {v.sizeBytes ? ` · ${formatBytes(v.sizeBytes)}` : ""}
                </option>
              ))}
            </select>
          </div>
        )}

        <div className="hub-download">
          {machines.length === 0 ? (
            <div className="faint" style={{ fontSize: 12.5 }}>
              Add a machine or launch a cloud GPU to download onto it.
            </div>
          ) : (
            <>
              <select className="select" value={machine?.id ?? ""} onChange={(e) => onMachine(e.target.value)} style={{ flex: 1 }}>
                {machines.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.cloudPodId ? "☁ " : ""}
                    {m.name}
                  </option>
                ))}
              </select>
              <button className="btn primary" disabled={busy || !downloadId} onClick={() => void download()}>
                {busy ? <LoaderCircle size={14} className="spin" /> : needsKaggle || needsHf ? <KeyRound size={14} /> : <Download size={14} />}
                {needsKaggle ? "Add Kaggle token" : needsHf ? "Add HF token" : "Download"}
              </button>
            </>
          )}
        </div>
      </div>

      {machine && downloadId && (
        <div className="card">
          <div className="card-head">
            <div className="card-title">Use it in your code</div>
            <div className="spacer" />
            <CopyButton text={snippet(item.source, item.kind, path)} />
          </div>
          <pre className="code-block selectable" style={{ margin: 0, borderRadius: 0, border: "none" }}>
            {snippet(item.source, item.kind, path)}
          </pre>
          <div className="card-body hint">
            {item.source === "kaggle" ? "Kaggle files land in a versioned folder under this path; the downloads list shows the exact one." : "The path on the machine after the download finishes."}
          </div>
        </div>
      )}
    </>
  );
}

function MachineDownloads({ machine, jobs, error, onRemove }: { machine: Machine | undefined; jobs: HubJob[] | null; error: string | null; onRemove: (j: HubJob) => void }) {
  if (!machine) return null;
  return (
    <div className="card" style={{ overflow: "hidden" }}>
      <div className="card-head">
        {machine.cloudPodId ? <Cloud size={14} /> : <Server size={14} />}
        <div className="card-title truncate">On {machine.name}</div>
      </div>
      {error ? (
        <div className="callout err" style={{ margin: "0 12px 12px" }}>
          {error}
        </div>
      ) : !jobs ? (
        <div className="empty">
          <LoaderCircle className="spin" />
        </div>
      ) : jobs.length === 0 ? (
        <div className="faint" style={{ padding: "0 16px 16px", fontSize: 12.5 }}>
          Nothing downloaded here yet.
        </div>
      ) : (
        <div className="hub-jobs">
          {jobs.map((j) => (
            <div key={j.jobId} className={`hub-job ${j.status}`}>
              <span className="hub-job-icon">
                {j.status === "downloading" ? <LoaderCircle size={14} className="spin" /> : j.status === "completed" ? <CircleCheck size={14} /> : <CircleX size={14} />}
              </span>
              <span className="hub-text">
                <b className="truncate">{j.id}</b>
                <span className="mono faint truncate" style={{ fontSize: 11 }} title={j.path}>
                  {j.path}
                </span>
                {j.status === "failed" && j.error && <span className="hub-err truncate" title={j.error}>{j.error.split("\n").pop()}</span>}
              </span>
              <span className="faint mono" style={{ fontSize: 11.5, whiteSpace: "nowrap" }}>
                {formatBytes(j.bytes)}
              </span>
              {j.status === "completed" && <CopyButton text={j.path} />}
              {j.status !== "downloading" && (
                <button className="btn ghost sm icon" title="Delete from the machine" onClick={() => onRemove(j)}>
                  <Trash2 size={13} />
                </button>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function AccountsDialog({ accounts, onClose, onSaved }: { accounts: HubAccounts; onClose: () => void; onSaved: (a: HubAccounts) => void }) {
  const toast = useToast();
  const [hf, setHf] = useState("");
  const [kaggle, setKaggle] = useState("");
  const save = async (source: HubSource, value: string | null) => {
    try {
      const a = await api.hubSetAccount(source, value);
      toast("success", value ? "Token saved" : "Token removed");
      onSaved(a);
    } catch (e) {
      toast("error", "Could not save the token", errorMessage(e));
    }
  };
  const row = (source: HubSource, title: string, hint: string, value: string, set: (v: string) => void, connected: boolean, placeholder: string) => (
    <div className="hub-account">
      <div className="row" style={{ gap: 8 }}>
        <b>{title}</b>
        {connected ? <span className="tag ok">connected</span> : <span className="tag">not set</span>}
      </div>
      <div className="hint" style={{ margin: "4px 0 8px" }}>{hint}</div>
      <div className="row">
        <input className="input mono" type="password" placeholder={placeholder} value={value} onChange={(e) => set(e.target.value)} />
        <button className="btn primary sm" disabled={!value.trim()} onClick={() => void save(source, value)}>
          Save
        </button>
        {connected && (
          <button className="btn ghost sm" onClick={() => void save(source, null)}>
            Remove
          </button>
        )}
      </div>
    </div>
  );
  return (
    <Dialog title="Accounts" icon={<KeyRound size={16} />} onClose={onClose}>
      <p className="muted" style={{ marginTop: 0, lineHeight: 1.55 }}>
        Tokens are stored in your OS keychain. They're sent to a machine only for a download you start, in a private file that is deleted as soon as the download begins.
      </p>
      {row("huggingface", "Hugging Face", "Needed for gated or private models (Llama, Gemma, …). Create one at huggingface.co/settings/tokens.", hf, setHf, accounts.huggingface, "hf_…")}
      {row("kaggle", "Kaggle", "Needed for every Kaggle download. Paste an API token from kaggle.com/settings, or username:key from kaggle.json.", kaggle, setKaggle, accounts.kaggle, "KGAT_…  or  username:key")}
    </Dialog>
  );
}
