import { useEffect, useMemo, useRef, useState } from "react";
import { Search } from "lucide-react";
import { FileIcon } from "./Explorer.tsx";
import { fs } from "./monaco.ts";

/** Fuzzy subsequence score: lower is better, -1 means no match. Rewards matches in the file name. */
function score(query: string, path: string): number {
  const q = query.toLowerCase();
  const p = path.toLowerCase();
  const base = p.lastIndexOf("/") + 1;
  let i = 0;
  let gaps = 0;
  let last = -1;
  for (let j = 0; j < p.length && i < q.length; j++) {
    if (p[j] === q[i]) {
      if (last >= 0) gaps += j - last - 1;
      last = j;
      i++;
    }
  }
  if (i < q.length) return -1;
  const inName = p.slice(base).includes(q) ? 0 : 1000;
  return inName + gaps + path.length * 0.01;
}

export function QuickOpen({ onPick, onClose }: { onPick: (path: string) => void; onClose: () => void }) {
  const [files, setFiles] = useState<string[]>([]);
  const [query, setQuery] = useState("");
  const [sel, setSel] = useState(0);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    input.current?.focus();
    fs.files().then(setFiles, () => setFiles([]));
  }, []);

  const results = useMemo(() => {
    if (!query) return files.slice(0, 60);
    return files
      .map((f) => [f, score(query, f)] as const)
      .filter(([, s]) => s >= 0)
      .sort((a, b) => a[1] - b[1])
      .slice(0, 60)
      .map(([f]) => f);
  }, [files, query]);

  useEffect(() => setSel(0), [query]);

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") onClose();
    else if (e.key === "ArrowDown") {
      e.preventDefault();
      setSel((s) => Math.min(s + 1, results.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setSel((s) => Math.max(s - 1, 0));
    } else if (e.key === "Enter" && results[sel]) onPick(results[sel]);
  };

  return (
    <>
      <div className="quick-scrim" onClick={onClose} />
      <div className="quick-open" onKeyDown={onKey}>
        <div className="quick-input">
          <Search size={14} className="faint" />
          <input ref={input} value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search files by name" spellCheck={false} />
        </div>
        <div className="quick-list">
          {results.map((f, i) => {
            const slash = f.lastIndexOf("/");
            return (
              <button key={f} className={`quick-item ${i === sel ? "sel" : ""}`} onMouseEnter={() => setSel(i)} onClick={() => onPick(f)}>
                <FileIcon name={f} />
                <span>{f.slice(slash + 1)}</span>
                <span className="faint truncate" style={{ fontSize: 11.5 }}>{slash > 0 ? f.slice(0, slash) : ""}</span>
              </button>
            );
          })}
          {!results.length && <div className="faint" style={{ padding: "10px 12px" }}>No matching files</div>}
        </div>
      </div>
    </>
  );
}
