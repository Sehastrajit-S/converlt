import { useCallback, useEffect, useState } from "react";
import { Check, GitBranch, Minus, Plus, RefreshCw, Undo2 } from "lucide-react";
import type { GitChange, GitStatus } from "../../shared/ide.ts";
import { FileIcon } from "./Explorer.tsx";
import { ide, onSaved } from "./monaco.ts";

const LETTER: Record<GitChange["kind"], string> = { modified: "M", added: "A", deleted: "D", renamed: "R", untracked: "U", conflict: "!" };

/** Source control: stage, unstage, discard, commit; clicking a change opens its diff. */
export function GitView({
  onOpenDiff,
  onError,
  onStatus,
}: {
  onOpenDiff: (path: string) => void;
  onError: (title: string, msg: string) => void;
  onStatus: (s: GitStatus) => void;
}) {
  const [status, setStatus] = useState<GitStatus | null>(null);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const s = await ide.git.status();
      setStatus(s);
      onStatus(s);
    } catch (e) {
      onError("Git status failed", e instanceof Error ? e.message : String(e));
    }
  }, [onError, onStatus]);

  useEffect(() => {
    void refresh();
    const onFocus = () => void refresh();
    window.addEventListener("focus", onFocus);
    const off = onSaved(() => void refresh());
    const timer = setInterval(() => void refresh(), 5000);
    return () => {
      window.removeEventListener("focus", onFocus);
      off();
      clearInterval(timer);
    };
  }, [refresh]);

  const run = async (title: string, fn: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await fn();
    } catch (e) {
      onError(title, e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
      void refresh();
    }
  };

  if (!status) return null;
  if (!status.repo) return <div className="side-empty muted">This folder isn't a git repository.</div>;

  const staged = status.changes.filter((c) => c.staged);
  const unstaged = status.changes.filter((c) => !c.staged);
  const commit = () =>
    run("Commit failed", async () => {
      await ide.git.commit(message);
      setMessage("");
    });

  const row = (c: GitChange) => {
    const slash = c.path.lastIndexOf("/");
    return (
      <div key={`${c.staged}:${c.path}`} className="tree-row git-row" title={c.path}>
        <button className="git-open" onClick={() => c.kind !== "deleted" && onOpenDiff(c.path)} disabled={c.kind === "deleted"}>
          <FileIcon name={c.path} />
          <span className={c.kind === "deleted" ? "strike" : ""}>{c.path.slice(slash + 1)}</span>
          <span className="faint truncate" style={{ fontSize: 12 }}>{slash > 0 ? c.path.slice(0, slash) : ""}</span>
        </button>
        <span className="git-actions">
          {c.staged ? (
            <button title="Unstage" onClick={() => run("Unstage failed", () => ide.git.unstage([c.path]))}>
              <Minus size={14} />
            </button>
          ) : (
            <>
              {c.kind !== "untracked" && (
                <button
                  title="Discard changes"
                  onClick={() => window.confirm(`Discard your changes to ${c.path}? This can't be undone.`) && run("Discard failed", () => ide.git.discard([c.path]))}
                >
                  <Undo2 size={14} />
                </button>
              )}
              <button title="Stage" onClick={() => run("Stage failed", () => ide.git.stage([c.path]))}>
                <Plus size={14} />
              </button>
            </>
          )}
        </span>
        <span className={`git-letter ${c.kind}`}>{LETTER[c.kind]}</span>
      </div>
    );
  };

  return (
    <div className="git-view">
      <div className="git-branch faint">
        <GitBranch size={13} /> {status.branch ?? "detached"}
        {(status.ahead > 0 || status.behind > 0) && (
          <span className="mono" style={{ fontSize: 11 }}>
            ↑{status.ahead} ↓{status.behind}
          </span>
        )}
        <span className="spacer" />
        <button className="btn ghost sm icon" title="Refresh" onClick={() => void refresh()}>
          <RefreshCw size={13} />
        </button>
      </div>
      <div className="git-commit">
        <textarea
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          placeholder={`Message (Ctrl+Enter to commit on ${status.branch ?? "HEAD"})`}
          rows={2}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.ctrlKey || e.metaKey) && staged.length && message.trim()) {
              e.preventDefault();
              void commit();
            }
          }}
        />
        <button className="btn primary sm" disabled={busy || !staged.length || !message.trim()} onClick={() => void commit()}>
          <Check size={13} /> Commit{staged.length ? ` ${staged.length} file${staged.length === 1 ? "" : "s"}` : ""}
        </button>
      </div>
      <div className="side-body">
        {staged.length > 0 && (
          <>
            <div className="git-section">
              Staged changes <span className="search-count">{staged.length}</span>
              <button title="Unstage all" onClick={() => run("Unstage failed", () => ide.git.unstage(staged.map((c) => c.path)))}>
                <Minus size={14} />
              </button>
            </div>
            {staged.map(row)}
          </>
        )}
        <div className="git-section">
          Changes <span className="search-count">{unstaged.length}</span>
          {unstaged.length > 0 && (
            <button title="Stage all" onClick={() => run("Stage failed", () => ide.git.stage(unstaged.filter((c) => c.kind !== "conflict").map((c) => c.path)))}>
              <Plus size={14} />
            </button>
          )}
        </div>
        {unstaged.map(row)}
        {!status.changes.length && <div className="side-empty muted">No changes. The working tree matches HEAD.</div>}
      </div>
    </div>
  );
}
