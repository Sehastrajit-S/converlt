import { useEffect, useRef, useState } from "react";
import { FileWarning, LoaderCircle } from "lucide-react";
import { monaco, openModel, saveModel, setActiveEditor } from "./monaco.ts";

/** A single Monaco instance that swaps models as file tabs change, keeping each file's scroll and cursor. */
export interface Reveal {
  path: string;
  line: number;
  col: number;
  length: number;
  /** Changes on every request, so revealing the same spot twice still scrolls. */
  nonce: number;
}

export function CodeEditor({ path, reveal, onSaveError }: { path: string; reveal: Reveal | null; onSaveError: (path: string, err: unknown) => void }) {
  const host = useRef<HTMLDivElement>(null);
  const editor = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
  const viewStates = useRef(new Map<string, monaco.editor.ICodeEditorViewState | null>());
  const current = useRef<string | null>(null);
  const onSaveErrorRef = useRef(onSaveError);
  onSaveErrorRef.current = onSaveError;
  const [status, setStatus] = useState<"loading" | "ready" | { binary: number } | { error: string }>("loading");

  useEffect(() => {
    const ed = monaco.editor.create(host.current!, {
      model: null,
      automaticLayout: true,
      fontFamily: "'JetBrains Mono', 'Cascadia Code', Consolas, monospace",
      fontSize: 13.5,
      lineHeight: 1.6,
      fontLigatures: false,
      minimap: { enabled: true, renderCharacters: false, scale: 1 },
      smoothScrolling: true,
      cursorBlinking: "smooth",
      cursorSmoothCaretAnimation: "on",
      renderLineHighlight: "all",
      scrollBeyondLastLine: false,
      padding: { top: 10 },
      bracketPairColorization: { enabled: true },
      guides: { bracketPairs: "active", indentation: true },
      stickyScroll: { enabled: true },
    });
    ed.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => {
      const p = current.current;
      if (p) saveModel(p).catch((e) => onSaveErrorRef.current(p, e));
    });
    editor.current = ed;
    setActiveEditor(ed);
    return () => {
      setActiveEditor(null);
      ed.dispose();
      editor.current = null;
    };
  }, []);

  useEffect(() => {
    const ed = editor.current;
    if (!reveal || reveal.path !== path || status !== "ready" || !ed) return;
    const range = new monaco.Range(reveal.line, reveal.col, reveal.line, reveal.col + reveal.length);
    ed.setSelection(range);
    ed.revealRangeInCenter(range, monaco.editor.ScrollType.Smooth);
    ed.focus();
  }, [reveal, path, status]);

  useEffect(() => {
    let cancelled = false;
    const ed = editor.current!;
    if (current.current) viewStates.current.set(current.current, ed.saveViewState());
    current.current = path;
    setStatus("loading");
    openModel(path)
      .then((res) => {
        if (cancelled) return;
        if ("binary" in res) {
          ed.setModel(null);
          setStatus({ binary: res.size });
          return;
        }
        ed.setModel(res.model);
        const vs = viewStates.current.get(path);
        if (vs) ed.restoreViewState(vs);
        ed.focus();
        setStatus("ready");
      })
      .catch((e) => !cancelled && setStatus({ error: e instanceof Error ? e.message : String(e) }));
    return () => {
      cancelled = true;
    };
  }, [path]);

  return (
    <div className="code-editor">
      <div ref={host} className="code-editor-host" style={{ visibility: status === "ready" ? "visible" : "hidden" }} />
      {status === "loading" ? (
        <div className="editor-note">
          <LoaderCircle className="spin" size={18} />
        </div>
      ) : status !== "ready" ? (
        <div className="editor-note">
          <FileWarning size={22} className="faint" />
          <div className="muted">{"binary" in status ? `Binary or large file (${(status.binary / 1024 / 1024).toFixed(1)} MB), not shown.` : status.error}</div>
        </div>
      ) : null}
    </div>
  );
}
