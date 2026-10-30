import { useEffect, useRef, useState } from "react";
import { LoaderCircle, Save, Undo2 } from "lucide-react";
import { fs, ide, isDirty, monaco, onDirtyChange, openModel, revertModel, saveModel } from "./monaco.ts";

export type DiffBase = "head" | "disk";

/**
 * Side-by-side diff. The right side is the file's live editor buffer, so it stays editable.
 * base "head": last commit vs working copy (source control). base "disk": saved file vs unsaved
 * edits (reviewing what the assistant changed).
 */
export function DiffEditor({ path, base, onError }: { path: string; base: DiffBase; onError: (msg: string) => void }) {
  const host = useRef<HTMLDivElement>(null);
  const [ready, setReady] = useState(false);
  const [dirty, setDirty] = useState(() => isDirty(path));
  const onErrorRef = useRef(onError);
  onErrorRef.current = onError;

  useEffect(() => onDirtyChange(() => setDirty(isDirty(path))), [path]);

  useEffect(() => {
    let disposed = false;
    const diff = monaco.editor.createDiffEditor(host.current!, {
      automaticLayout: true,
      fontFamily: "'JetBrains Mono', 'Cascadia Code', Consolas, monospace",
      fontSize: 13,
      renderSideBySide: true,
      originalEditable: false,
      scrollBeyondLastLine: false,
      minimap: { enabled: false },
    });
    let original: monaco.editor.ITextModel | null = null;
    (async () => {
      const opened = await openModel(path);
      if (disposed) return;
      if ("binary" in opened) throw new Error("Binary files can't be diffed");
      let text = "";
      if (base === "head") text = (await ide.git.headContent(path)) ?? "";
      else {
        const c = await fs.read(path).catch(() => null);
        text = c && !c.binary ? c.text : "";
      }
      if (disposed) return;
      original = monaco.editor.createModel(text, opened.model.getLanguageId());
      diff.setModel({ original, modified: opened.model });
      setReady(true);
    })().catch((e) => onErrorRef.current(e instanceof Error ? e.message : String(e)));
    return () => {
      disposed = true;
      diff.dispose();
      original?.dispose();
    };
  }, [path, base]);

  return (
    <div className="diff-pane">
      <div className="diff-toolbar">
        <span className="truncate">
          {path} <span className="faint">{base === "head" ? "· HEAD ↔ working tree" : "· saved ↔ unsaved changes"}</span>
        </span>
        <span className="spacer" />
        {dirty && (
          <>
            <button className="btn ghost sm" onClick={() => revertModel(path).catch((e) => onErrorRef.current(String(e)))} title="Discard the unsaved changes (undoable)">
              <Undo2 size={13} /> Undo changes
            </button>
            <button className="btn primary sm" onClick={() => saveModel(path).catch((e) => onErrorRef.current(String(e)))}>
              <Save size={13} /> Keep & save
            </button>
          </>
        )}
      </div>
      <div className="diff-host-wrap">
        <div ref={host} className="code-editor-host" />
        {!ready && (
          <div className="editor-note">
            <LoaderCircle className="spin" size={18} />
          </div>
        )}
      </div>
    </div>
  );
}
