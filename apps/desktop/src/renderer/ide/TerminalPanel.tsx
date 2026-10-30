import { useCallback, useEffect, useRef, useState } from "react";
import { Plus, SquareTerminal, Trash2, X } from "lucide-react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { ide } from "./monaco.ts";

type Session = { id: number; shell: string; term: Terminal; fit: FitAddon; el: HTMLDivElement; exited: boolean };

function themeFromCss(): Terminal["options"]["theme"] {
  const css = getComputedStyle(document.documentElement);
  const v = (name: string) => css.getPropertyValue(name).trim();
  const dark = window.matchMedia("(prefers-color-scheme: dark)").matches;
  return {
    background: v("--bg"),
    foreground: v("--text"),
    cursor: v("--accent-text"),
    selectionBackground: dark ? "#8b6cff55" : "#6d4aff33",
    black: dark ? "#1e2330" : "#2b303b",
    // Light backgrounds need darker ANSI colours to stay readable.
    red: dark ? v("--err") : "#c92a3a",
    green: dark ? v("--ok") : "#16834d",
    yellow: dark ? v("--warn") : "#9a6100",
    blue: dark ? v("--info") : "#1f6fc7",
    magenta: v("--accent"),
    cyan: v("--s2"),
    white: dark ? "#c9cfdb" : "#4c5567",
    brightBlack: v("--text-3"),
  };
}

/** Integrated terminal tabs. Sessions stay alive while the panel is hidden. */
export function TerminalPanel({ visible, onClose }: { visible: boolean; onClose: () => void }) {
  const [sessions, setSessions] = useState<Session[]>([]);
  const [active, setActive] = useState<number | null>(null);
  const host = useRef<HTMLDivElement>(null);
  const sessionsRef = useRef<Session[]>([]);
  sessionsRef.current = sessions;
  const creating = useRef(false);

  const create = useCallback(async () => {
    if (creating.current) return;
    creating.current = true;
    try {
      const el = document.createElement("div");
      el.className = "term-host";
      host.current!.appendChild(el);
      const term = new Terminal({
        fontFamily: "'JetBrains Mono', 'Cascadia Code', Consolas, monospace",
        fontSize: 13,
        lineHeight: 1.2,
        cursorBlink: true,
        allowProposedApi: false,
        scrollback: 10000,
        theme: themeFromCss(),
      });
      const fit = new FitAddon();
      term.loadAddon(fit);
      term.open(el);
      fit.fit();
      const { id, shell } = await ide.terminal.create(term.cols, term.rows);
      term.onData((d) => void ide.terminal.write(id, d));
      term.onResize(({ cols, rows }) => void ide.terminal.resize(id, cols, rows));
      // Ctrl+C copies when text is selected; Ctrl+V pastes (otherwise both go to the shell).
      term.attachCustomKeyEventHandler((e) => {
        if (e.type !== "keydown" || !e.ctrlKey) return true;
        if (e.key === "c" && term.hasSelection()) {
          void navigator.clipboard.writeText(term.getSelection());
          term.clearSelection();
          return false;
        }
        if (e.key === "v") {
          void navigator.clipboard.readText().then((t) => ide.terminal.write(id, t));
          return false;
        }
        return true;
      });
      const s: Session = { id, shell, term, fit, el, exited: false };
      setSessions((ss) => [...ss, s]);
      setActive(id);
    } finally {
      creating.current = false;
    }
  }, []);

  const kill = useCallback((id: number) => {
    const s = sessionsRef.current.find((x) => x.id === id);
    if (!s) return;
    void ide.terminal.kill(id);
    s.term.dispose();
    s.el.remove();
    const rest = sessionsRef.current.filter((x) => x.id !== id);
    setSessions(rest);
    setActive((a) => (a === id ? (rest.at(-1)?.id ?? null) : a));
  }, []);

  useEffect(() => {
    const offData = ide.terminal.onData((id, data) => sessionsRef.current.find((s) => s.id === id)?.term.write(data));
    const offExit = ide.terminal.onExit((id, code) => {
      const s = sessionsRef.current.find((x) => x.id === id);
      if (!s) return;
      s.exited = true;
      s.term.write(`\r\n\x1b[2m[process exited with code ${code}]\x1b[0m\r\n`);
      setSessions((ss) => [...ss]);
    });
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const onTheme = () => sessionsRef.current.forEach((s) => (s.term.options.theme = themeFromCss()));
    media.addEventListener("change", onTheme);
    return () => {
      offData();
      offExit();
      media.removeEventListener("change", onTheme);
      for (const s of sessionsRef.current) {
        void ide.terminal.kill(s.id);
        s.term.dispose();
      }
    };
  }, []);

  // First open starts a shell.
  useEffect(() => {
    if (visible && !sessionsRef.current.length) void create();
  }, [visible, create]);

  // Show the active session; refit whenever the panel resizes.
  useEffect(() => {
    for (const s of sessions) s.el.style.display = s.id === active ? "block" : "none";
    const s = sessions.find((x) => x.id === active);
    if (!s || !visible) return;
    const fitNow = () => {
      try {
        s.fit.fit();
      } catch {
        // not laid out yet
      }
    };
    requestAnimationFrame(fitNow);
    s.term.focus();
    const ro = new ResizeObserver(fitNow);
    ro.observe(host.current!);
    return () => ro.disconnect();
  }, [sessions, active, visible]);

  return (
    <div className="panel" style={{ display: visible ? "flex" : "none" }}>
      <div className="panel-head">
        <span className="panel-title">
          <SquareTerminal size={14} /> Terminal
        </span>
        <div className="panel-tabs">
          {sessions.map((s, i) => (
            <button key={s.id} className={`panel-tab ${s.id === active ? "active" : ""}`} onClick={() => setActive(s.id)}>
              {i + 1}: {s.shell}
              {s.exited && <span className="faint"> (exited)</span>}
            </button>
          ))}
        </div>
        <span className="spacer" />
        <button className="btn ghost sm icon" title="New terminal" onClick={() => void create()}>
          <Plus size={14} />
        </button>
        <button className="btn ghost sm icon" title="Kill terminal" disabled={active === null} onClick={() => active !== null && kill(active)}>
          <Trash2 size={13} />
        </button>
        <button className="btn ghost sm icon" title="Hide panel (Ctrl+`)" onClick={onClose}>
          <X size={14} />
        </button>
      </div>
      <div className="panel-body" ref={host} />
    </div>
  );
}
