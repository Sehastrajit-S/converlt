import { useEffect, useMemo, useState } from "react";
import { ArrowUpDown, Check, Code2, Copy, LoaderCircle, Search, Send, Sparkles } from "lucide-react";
import type { ModelReply } from "@converge/core/api";
import type { ModelInfo, WalletSummary } from "@converge/core/cloud";
import { api, errorMessage } from "../api.ts";
import { formatCredits } from "../cloud.ts";
import { Segmented } from "../components/ui.tsx";
import { CloudGate } from "./Wallet.tsx";

export function Models() {
  return <CloudGate>{(w) => <ModelsBody wallet={w} />}</CloudGate>;
}

type Sort = "popular" | "cheap" | "context";

const FEATURED = ["anthropic/", "openai/", "google/", "meta-llama/", "deepseek/", "mistralai/", "qwen/", "x-ai/"];

function providerOf(id: string): string {
  return id.split("/")[0] ?? id;
}

function ModelsBody({ wallet }: { wallet: WalletSummary }) {
  const [models, setModels] = useState<ModelInfo[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<Sort>("popular");
  const [provider, setProvider] = useState<string>("all");
  const [selected, setSelected] = useState<ModelInfo | null>(null);

  useEffect(() => {
    api.cloudModels().then(
      (m) => {
        setModels(m);
        setSelected(m.find((x) => x.id.startsWith("anthropic/")) ?? m[0] ?? null);
      },
      (e) => setError(errorMessage(e)),
    );
  }, []);

  const providers = useMemo(() => {
    const counts = new Map<string, number>();
    for (const m of models ?? []) counts.set(providerOf(m.id), (counts.get(providerOf(m.id)) ?? 0) + 1);
    return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10).map(([p]) => p);
  }, [models]);

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    const rank = (m: ModelInfo) => {
      const i = FEATURED.findIndex((f) => m.id.startsWith(f));
      return i === -1 ? FEATURED.length : i;
    };
    return (models ?? [])
      .filter((m) => (provider === "all" || providerOf(m.id) === provider) && (!q || m.id.toLowerCase().includes(q) || m.name.toLowerCase().includes(q)))
      .sort((a, b) =>
        sort === "cheap"
          ? a.inputPerMTok + a.outputPerMTok - (b.inputPerMTok + b.outputPerMTok)
          : sort === "context"
            ? b.contextLength - a.contextLength
            : rank(a) - rank(b),
      )
      .slice(0, 300);
  }, [models, query, sort, provider]);

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h1 className="page-title">Models</h1>
          <div className="page-sub">
            {models ? `${models.length} models` : "Models"} from every major lab through one OpenAI-compatible endpoint, paid from your credits. Use them in your code, evals and
            data pipelines.
          </div>
        </div>
        <div className="spacer" />
        <div className="balance-chip">
          <span className="faint">Balance</span> <b className="tabular">{formatCredits(wallet.balance)}</b>
        </div>
      </div>

      <div className="models-layout">
        <div className="models-list card">
          <div className="models-toolbar">
            <div className="search" style={{ width: "100%" }}>
              <Search size={14} />
              <input className="input" placeholder="Search models…" value={query} onChange={(e) => setQuery(e.target.value)} />
            </div>
            <div className="row wrap" style={{ gap: 6 }}>
              <Segmented<Sort>
                value={sort}
                onChange={setSort}
                options={[
                  { value: "popular", label: "Featured" },
                  { value: "cheap", label: "Cheapest" },
                  { value: "context", label: "Longest context" },
                ]}
              />
              <select className="select" style={{ width: "auto", height: 30 }} value={provider} onChange={(e) => setProvider(e.target.value)}>
                <option value="all">All providers</option>
                {providers.map((p) => (
                  <option key={p} value={p}>
                    {p}
                  </option>
                ))}
              </select>
            </div>
          </div>
          {error ? (
            <div className="callout err" style={{ margin: 12 }}>
              {error}
            </div>
          ) : !models ? (
            <div className="empty">
              <LoaderCircle className="spin" />
            </div>
          ) : (
            <div className="models-rows">
              <div className="model-row head">
                <span>Model</span>
                <span title="Credits per million input tokens">
                  <ArrowUpDown size={10} /> In / 1M
                </span>
                <span title="Credits per million output tokens">Out / 1M</span>
                <span>Context</span>
              </div>
              {shown.map((m) => (
                <button key={m.id} className={`model-row ${selected?.id === m.id ? "sel" : ""}`} onClick={() => setSelected(m)}>
                  <span className="model-id">
                    <b className="truncate">{m.name}</b>
                    <span className="mono faint truncate">{m.id}</span>
                  </span>
                  <span className="mono tabular">{m.inputPerMTok === 0 ? "free" : formatCredits(m.inputPerMTok)}</span>
                  <span className="mono tabular">{m.outputPerMTok === 0 ? "free" : formatCredits(m.outputPerMTok)}</span>
                  <span className="mono tabular faint">{m.contextLength >= 1e6 ? `${(m.contextLength / 1e6).toFixed(m.contextLength % 1e6 ? 1 : 0)}M` : `${Math.round(m.contextLength / 1000)}K`}</span>
                </button>
              ))}
            </div>
          )}
        </div>
        <div className="models-side">{selected && <ModelDetail key={selected.id} model={selected} wallet={wallet} />}</div>
      </div>
    </div>
  );
}

function CopyButton({ text }: { text: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      className="btn ghost sm icon"
      title="Copy"
      onClick={() => {
        void navigator.clipboard.writeText(text);
        setDone(true);
        setTimeout(() => setDone(false), 1200);
      }}
    >
      {done ? <Check size={13} /> : <Copy size={13} />}
    </button>
  );
}

function ModelDetail({ model, wallet }: { model: ModelInfo; wallet: WalletSummary }) {
  const [prompt, setPrompt] = useState("");
  const [reply, setReply] = useState<ModelReply | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const status = useGatewayUrl();
  const snippet = `from openai import OpenAI
import os

client = OpenAI(
    base_url="${status ?? "https://<your-gateway>"}/v1",
    api_key=os.environ["CONVERLT_TOKEN"],  # your Converlt token
)
reply = client.chat.completions.create(
    model="${model.id}",
    messages=[{"role": "user", "content": "Label this sample: ..."}],
)
print(reply.choices[0].message.content)`;

  const send = async () => {
    setBusy(true);
    setError(null);
    setReply(null);
    try {
      setReply(await api.modelComplete(model.id, prompt));
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  // Rough per-call estimate for a typical 1K-in / 500-out request.
  const typical = (model.inputPerMTok * 1000 + model.outputPerMTok * 500) / 1e6;

  return (
    <>
      <div className="card model-detail">
        <div className="row" style={{ gap: 10 }}>
          <div className="gpu-chip">
            <Sparkles size={16} />
          </div>
          <div style={{ minWidth: 0 }}>
            <div style={{ fontWeight: 650 }} className="truncate">
              {model.name}
            </div>
            <div className="row mono faint" style={{ fontSize: 11.5, gap: 4 }}>
              <span className="truncate">{model.id}</span>
              <CopyButton text={model.id} />
            </div>
          </div>
        </div>
        <div className="model-prices">
          <div>
            <span className="faint">Input</span>
            <b className="tabular">{formatCredits(model.inputPerMTok)}</b>
            <span className="faint">per 1M tokens</span>
          </div>
          <div>
            <span className="faint">Output</span>
            <b className="tabular">{formatCredits(model.outputPerMTok)}</b>
            <span className="faint">per 1M tokens</span>
          </div>
          <div>
            <span className="faint">Typical call</span>
            <b className="tabular">{formatCredits(typical, typical < 0.01 ? 4 : 2)}</b>
            <span className="faint">1K in · 500 out</span>
          </div>
        </div>
        {model.description && <p className="muted model-desc">{model.description}</p>}
      </div>

      <div className="card try-card">
        <div className="card-head">
          <div className="card-title">Try it</div>
          <div className="spacer" />
          <span className="faint" style={{ fontSize: 12 }}>
            Charged to your {formatCredits(wallet.balance)} credits
          </span>
        </div>
        <div className="card-body col" style={{ gap: 10 }}>
          <textarea
            className="textarea"
            rows={3}
            placeholder="Ask something, or paste a sample to label…"
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.ctrlKey || e.metaKey) && prompt.trim() && !busy) void send();
            }}
          />
          <div className="row">
            <span className="hint">Ctrl+Enter to send</span>
            <span className="spacer" />
            <button className="btn primary sm" disabled={!prompt.trim() || busy} onClick={() => void send()}>
              {busy ? <LoaderCircle size={13} className="spin" /> : <Send size={13} />} Send
            </button>
          </div>
          {error && <div className="callout err">{error}</div>}
          {reply && (
            <div className="try-reply">
              <div className="selectable">{reply.text || <span className="faint">(empty reply)</span>}</div>
              <div className="faint try-cost">
                {reply.tokens.input} in · {reply.tokens.output} out tokens
                {reply.credits !== null && ` · ${formatCredits(reply.credits, reply.credits < 0.01 ? 4 : 2)} credits`}
              </div>
            </div>
          )}
        </div>
      </div>

      <div className="card">
        <div className="card-head">
          <Code2 size={14} />
          <div className="card-title">Use it in your code</div>
          <div className="spacer" />
          <CopyButton text={snippet} />
        </div>
        <pre className="code-block selectable" style={{ margin: 0, borderRadius: 0, border: "none" }}>
          {snippet}
        </pre>
        <div className="card-body hint">Works with any OpenAI-compatible SDK or tool (LangChain, LiteLLM, DSPy, Codex…). Set CONVERLT_TOKEN to your Converlt token.</div>
      </div>
    </>
  );
}

function useGatewayUrl(): string | null {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    api.cloudStatus().then((s) => setUrl(s.url), () => {});
  }, []);
  return url;
}
