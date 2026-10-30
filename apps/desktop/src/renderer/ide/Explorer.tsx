import { useCallback, useEffect, useState } from "react";
import { ChevronRight, File, FileCode2, FileJson, FileText, Folder, FolderOpen, Image } from "lucide-react";
import type { DirEntry } from "../../shared/ide.ts";
import { fs } from "./monaco.ts";

export function FileIcon({ name }: { name: string }) {
  const ext = name.slice(name.lastIndexOf(".") + 1).toLowerCase();
  if (["py", "ts", "tsx", "js", "jsx", "sh", "c", "cpp", "cu", "rs", "go"].includes(ext)) return <FileCode2 size={14} className="ficon code" />;
  if (["json", "yaml", "yml", "toml", "cfg", "ini"].includes(ext)) return <FileJson size={14} className="ficon conf" />;
  if (["md", "txt", "rst"].includes(ext)) return <FileText size={14} className="ficon text" />;
  if (["png", "jpg", "jpeg", "gif", "svg", "webp"].includes(ext)) return <Image size={14} className="ficon img" />;
  return <File size={14} className="ficon" />;
}

/** Lazily loaded file tree. `version` bumps force every open folder to re-read. */
export function Explorer({ version, activePath, onOpen }: { version: number; activePath: string | null; onOpen: (path: string) => void }) {
  const [open, setOpen] = useState<Set<string>>(() => new Set());
  const [children, setChildren] = useState<Map<string, DirEntry[]>>(() => new Map());

  const load = useCallback(async (dir: string) => {
    try {
      const entries = await fs.list(dir);
      setChildren((m) => new Map(m).set(dir, entries));
    } catch {
      setChildren((m) => new Map(m).set(dir, []));
    }
  }, []);

  useEffect(() => {
    void load("");
    // Re-reads open folders on refresh only; toggling a folder loads it on its own.
    for (const dir of open) void load(dir);
  }, [version, load]);

  const toggle = (dir: string) => {
    setOpen((s) => {
      const next = new Set(s);
      if (next.has(dir)) next.delete(dir);
      else {
        next.add(dir);
        if (!children.has(dir)) void load(dir);
      }
      return next;
    });
  };

  const render = (dir: string, depth: number): React.ReactNode =>
    (children.get(dir) ?? []).map((e) => (
      <div key={e.path}>
        <button
          className={`tree-row ${e.path === activePath ? "active" : ""}`}
          style={{ paddingLeft: 8 + depth * 12 }}
          onClick={() => (e.dir ? toggle(e.path) : onOpen(e.path))}
          title={e.path}
        >
          {e.dir ? (
            <>
              <ChevronRight size={13} className={`chev ${open.has(e.path) ? "open" : ""}`} />
              {open.has(e.path) ? <FolderOpen size={14} className="ficon dir" /> : <Folder size={14} className="ficon dir" />}
            </>
          ) : (
            <>
              <span className="chev-space" />
              <FileIcon name={e.name} />
            </>
          )}
          <span className="truncate">{e.name}</span>
        </button>
        {e.dir && open.has(e.path) && render(e.path, depth + 1)}
      </div>
    ));

  return <div className="tree">{render("", 0)}</div>;
}
