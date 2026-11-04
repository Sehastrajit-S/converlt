import { useEffect, useState, type ReactNode } from "react";
import { ArrowDownLeft, Bot, CircleCheck, CircleDashed, CircleX, Cloud, Coins, Cpu, Flame, HardDrive, KeyRound, LoaderCircle, LogIn, LogOut, Pencil, Plus, Power, Server, Sparkles } from "lucide-react";
import type { LocalGatewayStatus } from "@converge/core/api";
import type { CloudStatus, LedgerEntry, SpendLimits, WalletSummary } from "@converge/core/cloud";
import { Segmented } from "../components/ui.tsx";
import { api, errorMessage } from "../api.ts";
import { creditsUsd, formatCredits, formatHours, useCloudStatus, useWallet } from "../cloud.ts";
import { Dialog, useToast } from "../components/ui.tsx";
import { formatDate } from "../format.ts";

/** Shows children only once Converlt Cloud is connected; otherwise the sign-in card. */
export function CloudGate({ children }: { children: (wallet: WalletSummary, reload: () => Promise<void>, status: CloudStatus) => ReactNode }) {
  const status = useCloudStatus();
  const connected = !!status.data?.connected;
  const wallet = useWallet(connected);
  if (!status.data)
    return (
      <div className="page">
        <div className="empty">
          <LoaderCircle className="spin" />
        </div>
      </div>
    );
  if (!connected) return <ConnectCard url={status.data.url} error={status.data.error} onConnected={status.reload} />;
  if (!wallet.data)
    return (
      <div className="page">
        <div className="empty">{wallet.error ? <span className="muted">{wallet.error}</span> : <LoaderCircle className="spin" />}</div>
      </div>
    );
  return <>{children(wallet.data, wallet.reload, status.data)}</>;
}

function ConnectCard({ url, error, onConnected }: { url: string | null; error: string | null; onConnected: () => Promise<void> }) {
  const [mode, setMode] = useState<"keys" | "account">("account");
  return (
    <div className="page">
      <div className="cloud-hero card">
        <div className="cloud-hero-art">
          <Cloud size={30} />
        </div>
        <h1 className="page-title">On-demand GPUs and AI models</h1>
        <p className="muted" style={{ maxWidth: 540, margin: "6px auto 0", lineHeight: 1.6 }}>
          Launch GPUs from RTX 4090 to H100 by the second, and use hundreds of AI models through one endpoint, from one balance you control.
        </p>
        <div className="cloud-points">
          <span>
            <Cpu size={14} /> RunPod GPUs, ready for your runs
          </span>
          <span>
            <Sparkles size={14} /> Claude, GPT, Gemini, Llama… via OpenRouter
          </span>
          <span>
            <Coins size={14} /> Budgets and monthly limits
          </span>
        </div>
        <div className="connect-tabs">
          <Segmented<"keys" | "account">
            value={mode}
            onChange={setMode}
            options={[
              { value: "account", label: "Converlt account" },
              { value: "keys", label: "Use my own keys" },
            ]}
          />
        </div>
        {mode === "keys" ? <OwnKeysForm onConnected={onConnected} /> : <AccountForm url={url} error={error} onConnected={onConnected} />}
      </div>
    </div>
  );
}

function AccountForm({ url, error, onConnected }: { url: string | null; error: string | null; onConnected: () => Promise<void> }) {
  const [err, setErr] = useState<string | null>(error);
  const [code, setCode] = useState<string | null>(null);
  const [loginUrl, setLoginUrl] = useState<string | null>(null);
  const [advanced, setAdvanced] = useState(false);
  useEffect(() => () => void api.cloudSignInCancel(), []);

  const signIn = async (gateway?: string) => {
    setErr(null);
    try {
      const started = await api.cloudSignInStart(gateway);
      setCode(started.code);
      setLoginUrl(started.loginUrl);
      await api.cloudSignInWait();
      await onConnected();
    } catch (e) {
      if (!/cancelled/i.test(errorMessage(e))) setErr(errorMessage(e));
    } finally {
      setCode(null);
      setLoginUrl(null);
    }
  };

  if (code)
    return (
      <div className="connect-form">
        <div className="field">
          <label>Finish signing in in your browser</label>
          <span className="hint">Approve the sign-in if the page shows this code:</span>
          <div className="mono" style={{ fontSize: 22, fontWeight: 600, letterSpacing: "0.08em", textAlign: "center", padding: "10px 0" }}>
            {code}
          </div>
          {loginUrl && (
            <span className="hint" style={{ wordBreak: "break-all" }}>
              Browser didn't open? Go to <span className="mono">{loginUrl}</span>
            </span>
          )}
        </div>
        <div className="row" style={{ gap: 8 }}>
          <span className="muted row" style={{ gap: 6 }}>
            <LoaderCircle size={14} className="spin" /> Waiting for approval…
          </span>
          <button className="btn ghost" onClick={() => void api.cloudSignInCancel()}>
            Cancel
          </button>
        </div>
      </div>
    );

  return (
    <div className="connect-form">
      <button className="btn primary" onClick={() => void signIn()}>
        <LogIn size={14} /> Sign in with GitHub or Google
      </button>
      <span className="hint">Opens your browser. New to Converlt? Signing in creates your account.</span>
      {err && <div className="callout err">{err}</div>}
      <button className="btn ghost sm" onClick={() => setAdvanced(!advanced)}>
        {advanced ? "Hide" : "Use another gateway or a token"}
      </button>
      {advanced && <TokenForm url={url} onConnected={onConnected} onBrowserSignIn={(g) => void signIn(g)} />}
    </div>
  );
}

/** Self-hosted gateways, and tokens an administrator created. */
function TokenForm({ url, onConnected, onBrowserSignIn }: { url: string | null; onConnected: () => Promise<void>; onBrowserSignIn: (gateway: string) => void }) {
  const [gateway, setGateway] = useState(url && !/127\.0\.0\.1/.test(url) ? url : "https://");
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const connect = async () => {
    setBusy(true);
    setErr(null);
    try {
      await api.cloudConnect(gateway, token);
      await onConnected();
    } catch (e) {
      setErr(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <div className="field">
        <label>Gateway URL</label>
        <input className="input mono" value={gateway} onChange={(e) => setGateway(e.target.value)} />
      </div>
      <button className="btn" disabled={!/^https?:\/\/\S+/.test(gateway)} onClick={() => onBrowserSignIn(gateway)}>
        <LogIn size={14} /> Sign in to this gateway in the browser
      </button>
      <div className="field">
        <label>Or a Converlt token</label>
        <input className="input mono" type="password" placeholder="cvt_…" value={token} onChange={(e) => setToken(e.target.value)} onKeyDown={(e) => e.key === "Enter" && token && void connect()} />
        <span className="hint">From your Converlt administrator. Stored in your OS keychain.</span>
      </div>
      {err && <div className="callout err">{err}</div>}
      <button className="btn" disabled={!token || !gateway || busy} onClick={() => void connect()}>
        {busy ? <LoaderCircle size={14} className="spin" /> : <KeyRound size={14} />} Sign in with token
      </button>
    </>
  );
}

function KeyCheck({ result }: { result?: string }) {
  if (!result) return null;
  const ok = result.startsWith("ok");
  return (
    <span className={`key-check ${ok ? "ok" : "bad"}`}>
      {ok ? <CircleCheck size={12} /> : <CircleX size={12} />} {ok ? `Key works${result.length > 2 ? ` · ${result.slice(4)}` : ""}` : result}
    </span>
  );
}

function KeyField({ label, hint, href, placeholder, set, value, onChange, check }: { label: string; hint: string; href: string; placeholder: string; set: boolean; value: string; onChange: (v: string) => void; check?: string }) {
  return (
    <div className="field">
      <label className="row" style={{ gap: 6 }}>
        {label}
        {set ? (
          <span className="tag ok">
            <CircleCheck size={10} /> saved
          </span>
        ) : (
          <span className="tag">
            <CircleDashed size={10} /> not set
          </span>
        )}
      </label>
      <input className="input mono" type="password" placeholder={set ? "•••••••• (leave empty to keep)" : placeholder} value={value} onChange={(e) => onChange(e.target.value)} />
      <KeyCheck result={check} />
      <span className="hint">
        {hint}{" "}
        <a href={href} target="_blank" rel="noreferrer">
          Get a key
        </a>
      </span>
    </div>
  );
}

/** Bring your own keys: Converlt runs the gateway on this computer with them. */
function OwnKeysForm({ onConnected, onDone, editing }: { onConnected: () => Promise<void>; onDone?: () => void; editing?: boolean }) {
  const [status, setStatus] = useState<LocalGatewayStatus | null>(null);
  const [runpod, setRunpod] = useState("");
  const [openrouter, setOpenrouter] = useState("");
  const [budget, setBudget] = useState("20");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    api.localGateway().then(setStatus, (e) => setErr(errorMessage(e)));
  }, []);

  const start = async () => {
    setBusy(true);
    setErr(null);
    try {
      const keys: { runpod?: string; openrouter?: string } = {};
      if (runpod.trim()) keys.runpod = runpod.trim();
      if (openrouter.trim()) keys.openrouter = openrouter.trim();
      if (Object.keys(keys).length) await api.localGatewaySetKeys(keys);
      if (!editing) await api.localGatewayStart(Math.round(Number(budget || 0) * 100));
      await onConnected();
      onDone?.();
    } catch (e) {
      setErr(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  const haveAny = !!(runpod.trim() || openrouter.trim() || status?.runpodKey || status?.openrouterKey);

  return (
    <div className="connect-form">
      {!editing && (
        <p className="hint" style={{ margin: 0, lineHeight: 1.55 }}>
          Converlt runs its gateway on this computer with your keys: you pay RunPod and OpenRouter directly, at cost. Keys stay in your OS keychain and never leave this
          computer except to call those providers.
        </p>
      )}
      <KeyField label="RunPod API key" hint="For on-demand GPUs." href="https://www.runpod.io/console/user/settings" placeholder="rpa_…" set={!!status?.runpodKey} value={runpod} onChange={setRunpod} check={status?.checks.runpod} />
      <KeyField label="OpenRouter API key" hint="For AI models in chat and your code." href="https://openrouter.ai/settings/keys" placeholder="sk-or-v1-…" set={!!status?.openrouterKey} value={openrouter} onChange={setOpenrouter} check={status?.checks.openrouter} />
      {!editing && (
        <div className="field">
          <label>Starting budget (USD)</label>
          <input className="input mono" inputMode="decimal" value={budget} onChange={(e) => setBudget(e.target.value.replace(/[^\d.]/g, ""))} />
          <span className="hint">A safety cap, not a charge: GPUs stop and models pause when it runs out. You can add more anytime. 100 credits = $1.</span>
        </div>
      )}
      {err && <div className="callout err" style={{ whiteSpace: "pre-wrap" }}>{err}</div>}
      <button className="btn primary" disabled={busy || !haveAny} onClick={() => void start()}>
        {busy ? <LoaderCircle size={14} className="spin" /> : <Power size={14} />} {editing ? "Save keys" : "Start with my keys"}
      </button>
    </div>
  );
}

export function Wallet({ onOpenGpus, onOpenModels }: { onOpenGpus: () => void; onOpenModels: () => void }) {
  return <CloudGate>{(w, reload, status) => <WalletBody wallet={w} reload={reload} local={!!status.local} onOpenGpus={onOpenGpus} onOpenModels={onOpenModels} />}</CloudGate>;
}

function WalletBody({ wallet: w, reload, local, onOpenGpus, onOpenModels }: { wallet: WalletSummary; reload: () => Promise<void>; local: boolean; onOpenGpus: () => void; onOpenModels: () => void }) {
  const toast = useToast();
  const [ledger, setLedger] = useState<LedgerEntry[] | null>(null);
  const [editing, setEditing] = useState(false);
  useEffect(() => {
    api.cloudLedger(100).then(setLedger, () => setLedger([]));
  }, [w.balance]);

  const lasts = w.burnPerHour > 0 ? w.balance / w.burnPerHour : null;
  const month = w.spend.gpu.month + w.spend.models.month;

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h1 className="page-title">Wallet</h1>
          <div className="page-sub">
            {local ? "Your own keys, on this computer" : (
              <>
                {w.user.name} · <span className="mono">{w.user.email}</span>
              </>
            )}
          </div>
        </div>
        <div className="spacer" />
        {!local && (
          <button
            className="btn ghost sm"
            onClick={async () => {
              if (!confirm("Sign out of Converlt Cloud on this computer? Running pods keep running and billing.")) return;
              await api.cloudDisconnect();
              toast("info", "Signed out of Converlt Cloud");
            }}
          >
            <LogOut size={14} /> Sign out
          </button>
        )}
      </div>

      <div className="wallet-top">
        <div className="card balance-card">
          <div className="balance-label">
            <Coins size={14} /> Balance
          </div>
          <div className="balance-value tabular">
            {formatCredits(w.balance)} <span>credits</span>
          </div>
          <div className="balance-sub">
            ≈ {creditsUsd(w.balance, w.creditsPerUsd)} · {w.creditsPerUsd} credits = $1
          </div>
          {w.balance <= 0 && <div className="callout err" style={{ marginTop: 12 }}>Out of credits. Pods are stopped and model calls are paused until credits are added.</div>}
        </div>
        <div className="card burn-card">
          <div className="balance-label">
            <Flame size={14} /> Spending now
          </div>
          <div className="burn-value tabular">
            {formatCredits(w.burnPerHour)} <span>/ hr</span>
          </div>
          <div className="balance-sub">
            {w.activePods ? `${w.activePods} pod${w.activePods === 1 ? "" : "s"} running` : "No pods running"}
            {lasts !== null && ` · balance lasts ${formatHours(lasts)}`}
          </div>
          <div className="row" style={{ marginTop: 14 }}>
            <button className="btn sm" onClick={onOpenGpus}>
              <Server size={13} /> GPUs
            </button>
            <button className="btn sm" onClick={onOpenModels}>
              <Bot size={13} /> Models
            </button>
          </div>
        </div>
      </div>

      {local && <LocalGatewayCard wallet={w} reload={reload} />}

      <div className="card" style={{ marginBottom: 16 }}>
        <div className="card-head">
          <div className="card-title">Where your credits go this month</div>
          <div className="spacer" />
          <span className="faint tabular" style={{ fontSize: 12 }}>
            {formatCredits(month)} spent
          </span>
          <button className="btn ghost sm" onClick={() => setEditing(true)}>
            <Pencil size={13} /> Limits
          </button>
        </div>
        <div className="card-body">
          <div className="split-bar" title={month ? undefined : "Nothing spent yet this month"}>
            {w.spend.gpu.month > 0 && <div className="split-gpu" style={{ flexGrow: w.spend.gpu.month }} />}
            {w.spend.models.month > 0 && <div className="split-models" style={{ flexGrow: w.spend.models.month }} />}
          </div>
          <div className="alloc-grid">
            <Allocation icon={<Cpu size={15} />} color="gpu" label="GPUs & storage" spend={w.spend.gpu} cap={w.limits.gpuMonthly} />
            <Allocation icon={<Sparkles size={15} />} color="models" label="AI models" spend={w.spend.models} cap={w.limits.modelsMonthly} />
          </div>
        </div>
      </div>

      <div className="card" style={{ overflow: "hidden" }}>
        <div className="card-head">
          <div className="card-title">Activity</div>
        </div>
        {!ledger ? (
          <div className="empty">
            <LoaderCircle className="spin" />
          </div>
        ) : ledger.length === 0 ? (
          <div className="empty faint">No activity yet.</div>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>When</th>
                <th>What</th>
                <th style={{ textAlign: "right" }}>Credits</th>
              </tr>
            </thead>
            <tbody>
              {ledger.map((e) => (
                <tr key={e.id}>
                  <td className="faint" style={{ whiteSpace: "nowrap" }}>
                    {formatDate(e.ts / 1000)}
                  </td>
                  <td>
                    <span className="row" style={{ gap: 8 }}>
                      <LedgerIcon kind={e.kind} />
                      <span className="truncate">{e.description}</span>
                    </span>
                  </td>
                  <td className={`mono tabular ${e.amount > 0 ? "credit-in" : ""}`} style={{ textAlign: "right", whiteSpace: "nowrap" }}>
                    {e.amount > 0 ? "+" : ""}
                    {formatCredits(e.amount, Math.abs(e.amount) < 0.1 ? 4 : 2)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {editing && (
        <LimitsDialog
          limits={w.limits}
          onClose={() => setEditing(false)}
          onSave={async (l) => {
            try {
              await api.cloudSetLimits(l);
              await reload();
              setEditing(false);
              toast("success", "Limits saved");
            } catch (e) {
              toast("error", "Could not save limits", errorMessage(e));
            }
          }}
        />
      )}
    </div>
  );
}

function Allocation({ icon, color, label, spend, cap }: { icon: ReactNode; color: "gpu" | "models"; label: string; spend: { day: number; month: number }; cap: number | null }) {
  const pct = cap ? Math.min(100, (spend.month / cap) * 100) : null;
  return (
    <div className="alloc">
      <div className="row" style={{ gap: 8 }}>
        <span className={`alloc-dot ${color}`}>{icon}</span>
        <b>{label}</b>
      </div>
      <div className="alloc-value tabular">{formatCredits(spend.month)}</div>
      <div className="faint" style={{ fontSize: 12 }}>
        {formatCredits(spend.day)} today · {cap === null ? "no monthly limit" : `limit ${formatCredits(cap, 0)}`}
      </div>
      {pct !== null && (
        <div className="meter" style={{ marginTop: 8 }}>
          <div style={{ width: `${pct}%`, background: pct >= 90 ? "var(--err)" : pct >= 70 ? "var(--warn)" : undefined }} />
        </div>
      )}
    </div>
  );
}

function LedgerIcon({ kind }: { kind: LedgerEntry["kind"] }) {
  if (kind === "grant" || kind === "refund") return <ArrowDownLeft size={14} className="credit-in" />;
  if (kind === "model") return <Sparkles size={14} className="faint" />;
  if (kind === "storage") return <HardDrive size={14} className="faint" />;
  return <Cpu size={14} className="faint" />;
}

function LimitsDialog({ limits, onClose, onSave }: { limits: SpendLimits; onClose: () => void; onSave: (l: SpendLimits) => Promise<void> }) {
  const [gpu, setGpu] = useState(limits.gpuMonthly === null ? "" : String(limits.gpuMonthly));
  const [models, setModels] = useState(limits.modelsMonthly === null ? "" : String(limits.modelsMonthly));
  const parse = (s: string) => (s.trim() === "" ? null : Number(s));
  return (
    <Dialog
      title="Monthly limits"
      icon={<Coins size={16} />}
      onClose={onClose}
      footer={
        <>
          <button className="btn ghost" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" onClick={() => void onSave({ gpuMonthly: parse(gpu), modelsMonthly: parse(models) })}>
            Save limits
          </button>
        </>
      }
    >
      <p className="muted" style={{ marginTop: 0, lineHeight: 1.6 }}>
        Your balance is shared. Limits decide how much of it each kind of work may use per calendar month (UTC). When GPUs reach their limit, running pods stop; when models
        do, model calls are paused. Leave a field empty for no limit.
      </p>
      <div className="grid-2">
        <div className="field">
          <label>GPUs & storage (credits / month)</label>
          <input className="input mono" inputMode="decimal" placeholder="No limit" value={gpu} onChange={(e) => setGpu(e.target.value.replace(/[^\d.]/g, ""))} />
        </div>
        <div className="field">
          <label>AI models (credits / month)</label>
          <input className="input mono" inputMode="decimal" placeholder="No limit" value={models} onChange={(e) => setModels(e.target.value.replace(/[^\d.]/g, ""))} />
        </div>
      </div>
    </Dialog>
  );
}

function LocalGatewayCard({ wallet, reload }: { wallet: WalletSummary; reload: () => Promise<void> }) {
  const toast = useToast();
  const [status, setStatus] = useState<LocalGatewayStatus | null>(null);
  const [amount, setAmount] = useState("10");
  const [editing, setEditing] = useState(false);
  const refresh = () => api.localGateway().then(setStatus, () => {});
  useEffect(() => {
    void refresh();
  }, []);
  const add = async () => {
    try {
      await api.localGatewayAddCredits(Math.round(Number(amount) * 100));
      await reload();
      toast("success", `Added $${amount} to your budget`);
    } catch (e) {
      toast("error", "Could not add budget", errorMessage(e));
    }
  };
  return (
    <div className="card local-gw">
      <div className="card-head">
        <Server size={14} />
        <div className="card-title">Running on this computer with your keys</div>
        <div className="spacer" />
        <button className="btn ghost sm" onClick={() => setEditing(true)}>
          <KeyRound size={13} /> Keys
        </button>
        <button
          className="btn ghost sm"
          onClick={async () => {
            if (!confirm("Stop the local gateway and switch off your own keys? Your running pods are stopped first (their volumes are kept).")) return;
            try {
              await api.localGatewayStop();
            } catch (e) {
              toast("error", "Gateway still running", errorMessage(e));
            }
          }}
        >
          <Power size={13} /> Stop
        </button>
      </div>
      <div className="card-body local-gw-body">
        <div className="local-gw-keys">
          <span className={status?.runpodKey ? "ok" : "faint"}>{status?.runpodKey ? <CircleCheck size={13} /> : <CircleDashed size={13} />} RunPod GPUs</span>
          <span className={status?.openrouterKey ? "ok" : "faint"}>{status?.openrouterKey ? <CircleCheck size={13} /> : <CircleDashed size={13} />} OpenRouter models</span>
          <span className="faint">billed at cost · {creditsUsd(wallet.balance, wallet.creditsPerUsd)} left</span>
        </div>
        {(status?.checks.runpod || status?.checks.openrouter) && (
          <div className="local-gw-checks">
            {status?.checks.runpod && (
              <span>
                RunPod: <KeyCheck result={status.checks.runpod} />
              </span>
            )}
            {status?.checks.openrouter && (
              <span>
                OpenRouter: <KeyCheck result={status.checks.openrouter} />
              </span>
            )}
          </div>
        )}
        <div className="row" style={{ gap: 6 }}>
          <span className="faint" style={{ fontSize: 12 }}>Add budget $</span>
          <input className="input mono" style={{ width: 80, height: 30 }} inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value.replace(/[^\d.]/g, ""))} />
          <button className="btn primary sm" disabled={!(Number(amount) > 0)} onClick={() => void add()}>
            <Plus size={13} /> Add
          </button>
        </div>
      </div>
      {editing && (
        <Dialog title="Your provider keys" icon={<KeyRound size={16} />} onClose={() => setEditing(false)}>
          <OwnKeysForm
            editing
            onConnected={async () => {
              await refresh();
              await reload();
            }}
            onDone={() => {
              setEditing(false);
              toast("success", "Keys saved", "The local gateway restarted with them.");
            }}
          />
        </Dialog>
      )}
    </div>
  );
}
