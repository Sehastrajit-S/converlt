import { useEffect, useRef, useState } from "react";
import { CaseSensitive, ChevronRight, LoaderCircle, Regex, WholeWord } from "lucide-react";
import type { SearchMatch, SearchResult } from "../../shared/ide.ts";
import { FileIcon } from "./Explorer.tsx";
import { fs } from "./monaco.ts";

/** Project-wide text search; results open the file at the match. */
export function SearchView({ onOpen, focusNonce }: { onOpen: (path: string, m: SearchMatch) => void; focusNonce: number }) {
  const [query, setQuery] = useState("");
  const [regex, setRegex] = useState(false);
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [wholeWord, setWholeWord] = useState(false);
  const [result, setResult] = useState<SearchResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  const input = useRef<HTMLInputElement>(null);
  const seq = useRef(0);

  useEffect(() => {
    input.current?.focus();
    input.current?.select();
  }, [focusNonce]);

  // Debounced; a newer query wins over a slower older one.
  useEffect(() => {
    if (!query) {
      setResult(null);
      setError(null);
      return;
    }
    if (regex) {
      try {
        new RegExp(query);
      } catch (e) {
        setError(e instanceof Error ? e.message : "Invalid regular expression");
        return;
      }
    }
    const n = ++seq.current;
    const t = setTimeout(() => {
      setBusy(true);
      fs.search(query, { regex, caseSensitive, wholeWord })
        .then((r) => n === seq.current && (setResult(r), setError(null)))
        .catch((e) => n === seq.current && setError(e instanceof Error ? e.message : String(e)))
        .finally(() => n === seq.current && setBusy(false));
    }, 250);
    return () => clearTimeout(t);
  }, [query, regex, caseSensitive, wholeWord]);

  const toggle = (on: boolean, set: (v: boolean) => void, icon: React.ReactNode, title: string) => (
    <button className={`search-opt ${on ? "on" : ""}`} title={title} aria-pressed={on} onClick={() => set(!on)}>
      {icon}
    </button>
  );

  return (
    <div className="search-view">
      <div className="search-box">
        <input ref={input} value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search" spellCheck={false} />
        {toggle(caseSensitive, setCaseSensitive, <CaseSensitive size={15} />, "Match case")}
        {toggle(wholeWord, setWholeWord, <WholeWord size={15} />, "Match whole word")}
        {toggle(regex, setRegex, <Regex size={14} />, "Use regular expression")}
      </div>
      <div className="search-summary faint">
        {busy ? (
          <LoaderCircle size={12} className="spin" />
        ) : error ? (
          <span style={{ color: "var(--err)" }}>{error}</span>
        ) : result ? (
          `${result.total}${result.truncated ? "+" : ""} result${result.total === 1 ? "" : "s"} in ${result.files.length} file${result.files.length === 1 ? "" : "s"}`
        ) : null}
      </div>
      <div className="side-body">
        {result?.files.map((f) => {
          const open = !collapsed.has(f.path);
          const slash = f.path.lastIndexOf("/");
          return (
            <div key={f.path}>
              <button
                className="tree-row"
                style={{ paddingLeft: 6 }}
                onClick={() =>
                  setCollapsed((s) => {
                    const next = new Set(s);
                    if (next.has(f.path)) next.delete(f.path);
                    else next.add(f.path);
                    return next;
                  })
                }
              >
                <ChevronRight size={13} className={`chev ${open ? "open" : ""}`} />
                <FileIcon name={f.path} />
                <span>{f.path.slice(slash + 1)}</span>
                <span className="faint truncate" style={{ fontSize: 12 }}>{slash > 0 ? f.path.slice(0, slash) : ""}</span>
                <span className="search-count">{f.matches.length}</span>
              </button>
              {open &&
                f.matches.map((m) => (
                  <button key={`${m.line}:${m.col}`} className="tree-row search-hit" onClick={() => onOpen(f.path, m)} title={`${f.path}:${m.line}`}>
                    <Hit m={m} />
                  </button>
                ))}
            </div>
          );
        })}
      </div>
    </div>
  );
}

/** The matching line, trimmed so the match stays visible, with the match highlighted. */
function Hit({ m }: { m: SearchMatch }) {
  const start = m.col - 1;
  const from = Math.max(0, start - 24);
  const lead = m.text.slice(from, start).trimStart();
  return (
    <span className="truncate">
      {from > 0 && "…"}
      {lead}
      <mark>{m.text.slice(start, start + m.length)}</mark>
      {m.text.slice(start + m.length, start + m.length + 160)}
    </span>
  );
}
