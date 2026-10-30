// Monaco (the editor core of VS Code) wired to the project's files. One model per open file;
// a model is dirty while its version differs from the one last read from or written to disk.
import * as monaco from "monaco-editor";
import EditorWorker from "monaco-editor/esm/vs/editor/editor.worker?worker";
import JsonWorker from "monaco-editor/esm/vs/language/json/json.worker?worker";
import CssWorker from "monaco-editor/esm/vs/language/css/css.worker?worker";
import HtmlWorker from "monaco-editor/esm/vs/language/html/html.worker?worker";
import TsWorker from "monaco-editor/esm/vs/language/typescript/ts.worker?worker";
import type { IdeApi } from "../../shared/ide.ts";

export { monaco };

export const ide = (window as unknown as { convergeIde: IdeApi }).convergeIde;
export const fs = ide.fs;

self.MonacoEnvironment = {
  getWorker(_id, label) {
    if (label === "json") return new JsonWorker();
    if (label === "css" || label === "scss" || label === "less") return new CssWorker();
    if (label === "html" || label === "handlebars" || label === "razor") return new HtmlWorker();
    if (label === "typescript" || label === "javascript") return new TsWorker();
    return new EditorWorker();
  },
};

// Same palette as the Converlt IDE theme (ide/extensions/converge-defaults).
monaco.editor.defineTheme("converge-dark", {
  base: "vs-dark",
  inherit: true,
  rules: [
    { token: "comment", foreground: "6c7589", fontStyle: "italic" },
    { token: "keyword", foreground: "b9a6ff" },
    { token: "string", foreground: "7fd8a8" },
    { token: "number", foreground: "f2a93b" },
    { token: "type", foreground: "4aa8ff" },
  ],
  colors: {
    "editor.background": "#0b0d12",
    "editor.foreground": "#e7eaf0",
    "editor.lineHighlightBackground": "#ffffff08",
    "editor.lineHighlightBorder": "#00000000",
    "editor.selectionBackground": "#8b6cff40",
    "editor.inactiveSelectionBackground": "#8b6cff26",
    "editorCursor.foreground": "#b9a6ff",
    "editorLineNumber.foreground": "#3d4456",
    "editorLineNumber.activeForeground": "#a4acbd",
    "editorIndentGuide.background1": "#1a1f2a",
    "editorIndentGuide.activeBackground1": "#2f3646",
    "editorWidget.background": "#12151c",
    "editorWidget.border": "#222836",
    "minimap.background": "#0b0d12",
    "scrollbarSlider.background": "#ffffff14",
    "scrollbarSlider.hoverBackground": "#ffffff22",
  },
});
monaco.editor.defineTheme("converge-light", {
  base: "vs",
  inherit: true,
  rules: [
    { token: "comment", foreground: "8790a2", fontStyle: "italic" },
    { token: "keyword", foreground: "5b36f2" },
  ],
  colors: {
    "editor.background": "#ffffff",
    "editor.lineHighlightBackground": "#00000006",
    "editor.lineHighlightBorder": "#00000000",
    "editor.selectionBackground": "#6d4aff2e",
    "editorCursor.foreground": "#5b36f2",
    "editorLineNumber.foreground": "#b7bdc9",
    "editorLineNumber.activeForeground": "#4c5567",
  },
});

const dark = window.matchMedia("(prefers-color-scheme: dark)");
const applyTheme = () => monaco.editor.setTheme(dark.matches ? "converge-dark" : "converge-light");
applyTheme();
dark.addEventListener("change", applyTheme);

type Entry = { model: monaco.editor.ITextModel; saved: number; dirty: boolean };
const models = new Map<string, Entry>();
const listeners = new Set<() => void>();
const notify = () => listeners.forEach((l) => l());

function refresh(e: Entry): void {
  const dirty = e.model.getAlternativeVersionId() !== e.saved;
  if (dirty === e.dirty) return;
  e.dirty = dirty;
  notify();
}

/** Subscribe to dirty-state changes; returns the unsubscribe. */
export function onDirtyChange(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

export const isDirty = (path: string): boolean => !!models.get(path)?.dirty;

export type OpenResult = { model: monaco.editor.ITextModel } | { binary: true; size: number };

export async function openModel(path: string): Promise<OpenResult> {
  const existing = models.get(path);
  if (existing) return { model: existing.model };
  const content = await fs.read(path);
  if (content.binary) return content;
  // A concurrent open may have won the race.
  const raced = models.get(path);
  if (raced) return { model: raced.model };
  const model = monaco.editor.createModel(content.text, undefined, monaco.Uri.file("/" + path));
  const entry: Entry = { model, saved: model.getAlternativeVersionId(), dirty: false };
  models.set(path, entry);
  model.onDidChangeContent(() => refresh(entry));
  return { model };
}

export const getOpenModel = (path: string): monaco.editor.ITextModel | null => models.get(path)?.model ?? null;

const savedListeners = new Set<(path: string) => void>();
/** Fires after a file is written to disk (git status and search results may have changed). */
export function onSaved(cb: (path: string) => void): () => void {
  savedListeners.add(cb);
  return () => savedListeners.delete(cb);
}

export async function saveModel(path: string): Promise<void> {
  const e = models.get(path);
  if (!e) return;
  const version = e.model.getAlternativeVersionId();
  await fs.write(path, e.model.getValue());
  e.saved = version;
  refresh(e);
  savedListeners.forEach((l) => l(path));
}

/** Replaces the buffer with the file on disk as one undoable edit. */
export async function revertModel(path: string): Promise<void> {
  const e = models.get(path);
  if (!e) return;
  const content = await fs.read(path);
  if (content.binary) return;
  e.model.pushEditOperations([], [{ range: e.model.getFullModelRange(), text: content.text }], () => null);
  e.saved = e.model.getAlternativeVersionId();
  refresh(e);
}

/** The focused code editor, for the assistant's selection context. */
let activeEditor: monaco.editor.ICodeEditor | null = null;
export const setActiveEditor = (ed: monaco.editor.ICodeEditor | null) => (activeEditor = ed);
export function currentSelection(): { text: string; startLine: number; endLine: number } | null {
  const model = activeEditor?.getModel();
  const sel = activeEditor?.getSelection();
  if (!model || !sel || sel.isEmpty()) return null;
  return { text: model.getValueInRange(sel), startLine: sel.startLineNumber, endLine: sel.endLineNumber };
}

export const anyDirty = (): boolean => [...models.values()].some((e) => e.dirty);

export async function saveAll(): Promise<void> {
  await Promise.all([...models.entries()].filter(([, e]) => e.dirty).map(([p]) => saveModel(p)));
}

export function closeModel(path: string): void {
  models.get(path)?.model.dispose();
  models.delete(path);
  notify();
}

export function closeAllModels(): void {
  for (const e of models.values()) e.model.dispose();
  models.clear();
  notify();
}
