// Source control for the built-in IDE. Plain `git` on PATH, always run in the project root.
import { execFile } from "node:child_process";
import type { GitChangeKind, GitStatus } from "../shared/ide.ts";

function git(cwd: string, args: string[], input?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile("git", args, { cwd, maxBuffer: 64 * 1024 * 1024, windowsHide: true }, (err, stdout, stderr) => {
      if (err) reject(new Error((stderr || err.message).trim()));
      else resolve(stdout);
    });
    if (input !== undefined) child.stdin?.end(input);
  });
}

/** Paths come from the renderer: keep them relative and out of git's option parser. */
function checkPaths(paths: string[]): string[] {
  for (const p of paths) if (!p || p.startsWith("-") || p.split(/[\\/]/).includes("..") || /^[a-zA-Z]:|^[\\/]/.test(p)) throw new Error(`Invalid path: ${p}`);
  return paths;
}

const KIND: Record<string, GitChangeKind> = { M: "modified", T: "modified", A: "added", D: "deleted", R: "renamed", C: "added", U: "conflict" };

export async function status(cwd: string): Promise<GitStatus> {
  let out: string;
  try {
    out = await git(cwd, ["status", "--porcelain=v1", "-z", "--branch", "--untracked-files=all"]);
  } catch {
    return { repo: false, branch: null, ahead: 0, behind: 0, changes: [] };
  }
  const entries = out.split("\0");
  const res: GitStatus = { repo: true, branch: null, ahead: 0, behind: 0, changes: [] };
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    if (!e) continue;
    if (e.startsWith("## ")) {
      const head = e.slice(3);
      res.branch = head.replace(/^No commits yet on /, "").split("...")[0].trim() || null;
      res.ahead = Number(/ahead (\d+)/.exec(head)?.[1] ?? 0);
      res.behind = Number(/behind (\d+)/.exec(head)?.[1] ?? 0);
      continue;
    }
    const x = e[0];
    const y = e[1];
    const path = e.slice(3);
    // Renames and copies are followed by the original path as its own entry.
    if (x === "R" || x === "C") i++;
    if (x === "?") {
      res.changes.push({ path, kind: "untracked", staged: false });
      continue;
    }
    if (x === "U" || y === "U" || (x === "A" && y === "A") || (x === "D" && y === "D")) {
      res.changes.push({ path, kind: "conflict", staged: false });
      continue;
    }
    if (x !== " ") res.changes.push({ path, kind: KIND[x] ?? "modified", staged: true });
    if (y !== " ") res.changes.push({ path, kind: KIND[y] ?? "modified", staged: false });
  }
  return res;
}

export async function headContent(cwd: string, rel: string): Promise<string | null> {
  checkPaths([rel]);
  try {
    return await git(cwd, ["show", `HEAD:${rel}`]);
  } catch {
    return null;
  }
}

export async function stage(cwd: string, paths: string[]): Promise<void> {
  if (paths.length) await git(cwd, ["add", "--", ...checkPaths(paths)]);
}

export async function unstage(cwd: string, paths: string[]): Promise<void> {
  if (!paths.length) return;
  try {
    await git(cwd, ["restore", "--staged", "--", ...checkPaths(paths)]);
  } catch {
    // No HEAD yet (first commit): restore has nothing to restore from.
    await git(cwd, ["rm", "--cached", "--quiet", "--", ...paths]);
  }
}

/** Reverts working-tree changes to tracked files. Untracked files are left alone. */
export async function discard(cwd: string, paths: string[]): Promise<void> {
  if (paths.length) await git(cwd, ["restore", "--worktree", "--", ...checkPaths(paths)]);
}

export async function commit(cwd: string, message: string): Promise<string> {
  if (!message.trim()) throw new Error("Enter a commit message");
  await git(cwd, ["commit", "-F", "-"], message);
  return (await git(cwd, ["rev-parse", "--short", "HEAD"])).trim();
}
