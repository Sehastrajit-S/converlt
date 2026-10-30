import { Fragment, useEffect, useRef, useState } from "react";
import { ArrowUp, Brain, Check, ChevronRight, Copy, FileCode2, FilePen, FilePlus2, FlaskConical, KeyRound, LoaderCircle, Plus, Search, Settings2, Sparkles, Square, TriangleAlert, X } from "lucide-react";
import { AGENT_MODELS, type AgentConfig, type AgentEvent } from "../../shared/ide.ts";
import { currentSelection, ide } from "./monaco.ts";

type Part =
  | { kind: "text"; text: string }
  | { kind: "thinking"; text: string }
  | { kind: "tool"; id: string; name: string; input: Record<string, unknown>; status: "running" | "ok" | "error"; summary: string }
  | { kind: "note"; text: string; error?: boolean };
type Message = { role: "user"; text: string; context: string | null } | { role: "assistant"; parts: Part[] };

const TOOL_ICON: Record<string, React.ReactNode> = {
  read_file: <FileCode2 size={13} />,
  list_files: <FileCode2 size={13} />,
  search_files: <Search size={13} />,
  edit_file: <FilePen size={13} />,
  create_file: <FilePlus2 size={13} />,
  list_runs: <FlaskConical size={13} />,
  get_run: <FlaskConical size={13} />,
};

function toolLabel(name: string, input: Record<string, unknown>): string {
  const p = typeof input.path === "string" ? input.path : "";
  switch (name) {
    case "read_file":
      return `Read ${p}${input.start_line ? `:${input.start_line}-${input.end_line ?? ""}` : ""}`;
    case "list_files":
      return input.filter ? `Listed files matching "${input.filter}"` : "Listed project files";
    case "search_files":
      return `Searched for "${input.query ?? ""}"`;
    case "edit_file":
      return `Edited ${p}`;
    case "create_file":
      return `Created ${p}`;
    case "list_runs":
      return "Listed runs";
    case "get_run":
      return `Looked at ${input.run ?? "run"}`;
    default:
      return name;
  }
}

/** Minimal Markdown: fenced code, headings, lists, inline `code` and **bold**. Built as React nodes, never HTML. */
function Markdown({ text }: { text: string }) {
  const blocks = text.split(/^```/m);
  return (
    <>
      {blocks.map((b, i) => {
        if (i % 2 === 1) {
          const nl = b.indexOf("\n");
          const lang = nl === -1 ? "" : b.slice(0, nl).trim();
          const code = (nl === -1 ? b : b.slice(nl + 1)).replace(/\n$/, "");
          return <CodeBlock key={i} lang={lang} code={code} />;
        }
        return (
          <Fragment key={i}>
            {b.split(/\n{2,}/).map((para, j) => {
              const t = para.trim();
              if (!t) return null;
              const h = /^(#{1,4})\s+(.*)$/.exec(t);
              if (h) return <div key={j} className="md-h">{inline(h[2])}</div>;
              const lines = t.split("\n");
              if (lines.every((l) => /^\s*([-*]|\d+\.)\s+/.test(l)))
                return (
                  <ul key={j} className="md-list">
                    {lines.map((l, k) => (
                      <li key={k}>{inline(l.replace(/^\s*([-*]|\d+\.)\s+/, ""))}</li>
                    ))}
                  </ul>
                );
              return (
                <p key={j}>
                  {lines.map((l, k) => (
                    <Fragment key={k}>
                      {k > 0 && <br />}
                      {inline(l)}
                    </Fragment>
                  ))}
                </p>
              );
            })}
          </Fragment>
        );
      })}
    </>
  );
}

function inline(s: string): React.ReactNode[] {
  return s.split(/(`[^`]+`|\*\*[^*]+\*\*)/g).map((seg, i) =>
    seg.startsWith("`") && seg.endsWith("`") && seg.length > 1 ? (
      <code key={i}>{seg.slice(1, -1)}</code>
    ) : seg.startsWith("**") && seg.endsWith("**") && seg.length > 3 ? (
      <strong key={i}>{seg.slice(2, -2)}</strong>
    ) : (
      <Fragment key={i}>{seg}</Fragment>
    ),
  );
}

function CodeBlock({ lang, code }: { lang: string; code: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="md-code">
      <div className="md-code-head">
        <span>{lang || "code"}</span>
        <button
          onClick={() => {
            void navigator.clipboard.writeText(code);
            setCopied(true);
            setTimeout(() => setCopied(false), 1200);
          }}
        >
          {copied ? <Check size={12} /> : <Copy size={12} />}
        </button>
      </div>
      <pre className="selectable">{code}</pre>
    </div>
  );
}

export function AgentPanel({
  visible,
  activeFile,
  projectOpen,
  focusNonce,
  onClose,
  onReview,
}: {
  visible: boolean;
  activeFile: string | null;
  projectOpen: boolean;
  focusNonce: number;
  onClose: () => void;
  onReview: (path: string) => void;
}) {
  const [config, setConfig] = useState<AgentConfig | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [withFile, setWithFile] = useState(true);
  const [settings, setSettings] = useState(false);
  const [keyDraft, setKeyDraft] = useState("");
  const [keyError, setKeyError] = useState<string | null>(null);
  const [usage, setUsage] = useState<{ input: number; output: number; cacheRead: number } | null>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const stick = useRef(true);

  useEffect(() => {
    ide.agent.getConfig().then(setConfig, () => {});
  }, []);

  useEffect(() => {
    if (visible) input.current?.focus();
  }, [visible, focusNonce]);

  // Append each streamed event to the last assistant message.
  useEffect(
    () =>
      ide.agent.onEvent((e: AgentEvent) => {
        if (e.type === "done") {
          setBusy(false);
          setUsage(e.usage);
          if (e.stopReason === "stopped") push({ kind: "note", text: "Stopped." });
          return;
        }
        if (e.type === "error") {
          setBusy(false);
          push({ kind: "note", text: e.message, error: true });
          if (e.auth) setSettings(true);
          return;
        }
        if (e.type === "turn_start") return;
        setMessages((ms) => {
          const last = ms.at(-1);
          if (!last || last.role !== "assistant") return ms;
          const parts = [...last.parts];
          const tail = parts.at(-1);
          if (e.type === "text") {
            if (tail?.kind === "text") parts[parts.length - 1] = { ...tail, text: tail.text + e.delta };
            else parts.push({ kind: "text", text: e.delta });
          } else if (e.type === "thinking") {
            if (tail?.kind === "thinking") parts[parts.length - 1] = { ...tail, text: tail.text + e.delta };
            else parts.push({ kind: "thinking", text: e.delta });
          } else if (e.type === "tool_start") {
            parts.push({ kind: "tool", id: e.id, name: e.name, input: (e.input ?? {}) as Record<string, unknown>, status: "running", summary: "" });
          } else if (e.type === "tool_end") {
            const i = parts.findIndex((p) => p.kind === "tool" && p.id === e.id);
            if (i !== -1) parts[i] = { ...(parts[i] as Extract<Part, { kind: "tool" }>), status: e.ok ? "ok" : "error", summary: e.summary };
          } else if (e.type === "fallback") {
            parts.push({ kind: "note", text: `${e.from} declined; ${e.to} continued.` });
          }
          return [...ms.slice(0, -1), { role: "assistant", parts }];
        });
      }),
    [],
  );

  const push = (p: Part) =>
    setMessages((ms) => {
      const last = ms.at(-1);
      if (last?.role === "assistant") return [...ms.slice(0, -1), { role: "assistant", parts: [...last.parts, p] }];
      return [...ms, { role: "assistant", parts: [p] }];
    });

  useEffect(() => {
    const el = scroller.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [messages]);

  const send = () => {
    const text = draft.trim();
    if (!text || busy || !projectOpen) return;
    const selection = withFile ? currentSelection() : null;
    const file = withFile ? activeFile : null;
    const context = selection ? `${file}:${selection.startLine}-${selection.endLine}` : file;
    setMessages((ms) => [...ms, { role: "user", text, context }, { role: "assistant", parts: [] }]);
    setDraft("");
    setBusy(true);
    stick.current = true;
    ide.agent.send(text, { activeFile: file, selection }).catch((err) => {
      setBusy(false);
      push({ kind: "note", text: err instanceof Error ? err.message : String(err), error: true });
    });
  };

  const newChat = () => {
    void ide.agent.reset();
    setMessages([]);
    setBusy(false);
    setUsage(null);
  };

  const saveKey = async (clear = false) => {
    try {
      setConfig(await ide.agent.setConfig({ apiKey: clear ? null : keyDraft }));
      setKeyDraft("");
      setKeyError(null);
      if (!clear) setSettings(false);
    } catch (e) {
      setKeyError(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <aside className="agent" style={{ display: visible ? "flex" : "none" }}>
      <div className="agent-head">
        <Sparkles size={14} className="ficon accent" />
        <span style={{ fontWeight: 650 }}>Assistant</span>
        <span className="spacer" />
        <button className="btn ghost sm icon" title="New chat" onClick={newChat}>
          <Plus size={15} />
        </button>
        <button className={`btn ghost sm icon ${settings ? "on" : ""}`} title="Assistant settings" onClick={() => setSettings(!settings)}>
          <Settings2 size={14} />
        </button>
        <button className="btn ghost sm icon" title="Close (Ctrl+L)" onClick={onClose}>
          <X size={14} />
        </button>
      </div>

      {settings && config && (
        <div className="agent-settings">
          <div className="agent-settings-title">
            <KeyRound size={13} /> Anthropic API key
          </div>
          <div className="faint" style={{ fontSize: 12, lineHeight: 1.5 }}>
            {config.hasKey
              ? "A key is stored, encrypted with your OS keychain. It never leaves this computer except to call the Anthropic API."
              : "No key stored. Converlt also uses ANTHROPIC_API_KEY or an `ant auth login` profile if one is set."}
          </div>
          <div className="row">
            <input className="agent-key" type="password" placeholder="sk-ant-…" value={keyDraft} onChange={(e) => setKeyDraft(e.target.value)} onKeyDown={(e) => e.key === "Enter" && keyDraft && void saveKey()} />
            <button className="btn primary sm" disabled={!keyDraft} onClick={() => void saveKey()}>
              Save
            </button>
          </div>
          {config.hasKey && (
            <button className="btn ghost sm" style={{ alignSelf: "flex-start" }} onClick={() => void saveKey(true)}>
              Remove stored key
            </button>
          )}
          {keyError && <div style={{ color: "var(--err)", fontSize: 12 }}>{keyError}</div>}
        </div>
      )}

      <div
        className="agent-scroll"
        ref={scroller}
        onScroll={(e) => {
          const el = e.currentTarget;
          stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
        }}
      >
        {messages.length === 0 ? (
          <div className="agent-empty">
            <Sparkles size={26} className="ficon accent" />
            <div style={{ fontWeight: 650, fontSize: 14 }}>Ask about your code and runs</div>
            <div className="faint" style={{ fontSize: 12.5, lineHeight: 1.6, maxWidth: 260 }}>
              The assistant reads your project and run history, and edits files as unsaved changes you review.
            </div>
            <div className="agent-suggestions">
              {["Why did my last failed run fail?", "Add gradient clipping to the training loop", "Explain what this file does"].map((s) => (
                <button key={s} onClick={() => setDraft(s)} disabled={!projectOpen}>
                  {s}
                </button>
              ))}
            </div>
          </div>
        ) : (
          messages.map((m, i) =>
            m.role === "user" ? (
              <div key={i} className="msg-user selectable">
                {m.context && <div className="msg-ctx">@{m.context}</div>}
                {m.text}
              </div>
            ) : (
              <div key={i} className="msg-assistant">
                {m.parts.map((p, j) =>
                  p.kind === "text" ? (
                    <div key={j} className="md selectable">
                      <Markdown text={p.text} />
                    </div>
                  ) : p.kind === "thinking" ? (
                    <Thinking key={j} text={p.text} />
                  ) : p.kind === "tool" ? (
                    <div key={j} className={`msg-tool ${p.status}`} title={p.summary}>
                      {p.status === "running" ? <LoaderCircle size={13} className="spin" /> : p.status === "error" ? <TriangleAlert size={13} /> : TOOL_ICON[p.name]}
                      <span className="truncate">{toolLabel(p.name, p.input)}</span>
                      {p.name === "edit_file" && p.status === "ok" && typeof p.input.path === "string" && (
                        <button className="msg-tool-action" onClick={() => onReview(String(p.input.path))}>
                          Review
                        </button>
                      )}
                    </div>
                  ) : (
                    <div key={j} className={`msg-note ${p.error ? "error" : ""}`}>
                      {p.error && <TriangleAlert size={13} />} {p.text}
                    </div>
                  ),
                )}
                {busy && i === messages.length - 1 && !m.parts.some((p) => p.kind === "text" || p.kind === "tool") && (
                  <div className="msg-note">
                    <LoaderCircle size={13} className="spin" /> Thinking…
                  </div>
                )}
              </div>
            ),
          )
        )}
      </div>

      <div className="composer">
        {projectOpen && activeFile && (
          <button className={`ctx-chip ${withFile ? "on" : ""}`} onClick={() => setWithFile(!withFile)} title={withFile ? "The current file and selection are sent as context" : "Not sending the current file as context"}>
            <FileCode2 size={12} /> {activeFile.split("/").pop()}
            {withFile ? <X size={11} /> : <Plus size={11} />}
          </button>
        )}
        <textarea
          ref={input}
          value={draft}
          disabled={!projectOpen}
          placeholder={projectOpen ? "Ask, or describe a change… (Enter to send)" : "Open a project to use the assistant"}
          rows={3}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              send();
            }
          }}
        />
        <div className="composer-foot">
          <select
            className="model-select"
            value={config?.model ?? AGENT_MODELS[0].id}
            onChange={(e) => ide.agent.setConfig({ model: e.target.value }).then(setConfig, () => {})}
            title="Model"
          >
            {AGENT_MODELS.map((m) => (
              <option key={m.id} value={m.id}>
                {m.label}
              </option>
            ))}
          </select>
          {usage && (
            <span className="faint mono" style={{ fontSize: 10.5 }} title="Tokens in the last reply: input / output (cache reads)">
              {fmtTokens(usage.input + usage.cacheRead)} in · {fmtTokens(usage.output)} out
            </span>
          )}
          <span className="spacer" />
          {busy ? (
            <button className="send-btn stop" title="Stop" onClick={() => void ide.agent.stop()}>
              <Square size={11} fill="currentColor" />
            </button>
          ) : (
            <button className="send-btn" title="Send (Enter)" disabled={!draft.trim() || !projectOpen} onClick={send}>
              <ArrowUp size={15} />
            </button>
          )}
        </div>
      </div>
    </aside>
  );
}

function Thinking({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  if (!text.trim()) return null;
  return (
    <div className="msg-thinking">
      <button onClick={() => setOpen(!open)}>
        <Brain size={13} /> Thought <ChevronRight size={12} className={`chev ${open ? "open" : ""}`} />
      </button>
      {open && <div className="msg-thinking-body selectable">{text}</div>}
    </div>
  );
}

const fmtTokens = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k` : String(n));
