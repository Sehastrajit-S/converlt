import { execFile, spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { GitFingerprint } from "@converge/run-protocol";

const MAX_PATCH_BYTES = 5 * 1024 * 1024;
/** Untracked files bigger than this aren't put in a run's patch (data and weights don't belong there). */
const MAX_UNTRACKED_FILE_BYTES = 1024 * 1024;

function git(cwd: string, args: string[]): Promise<string | null> {
  return new Promise((resolve) => {
    execFile("git", args, { cwd, maxBuffer: 32 * 1024 * 1024, windowsHide: true }, (err, stdout) => resolve(err ? null : stdout));
  });
}

export async function isGitRepo(cwd: string): Promise<boolean> {
  return (await git(cwd, ["rev-parse", "--is-inside-work-tree"]))?.trim() === "true";
}

export async function currentBranch(cwd: string): Promise<string | null> {
  return (await git(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]))?.trim() || null;
}

export async function currentCommit(cwd: string): Promise<string | null> {
  return (await git(cwd, ["rev-parse", "HEAD"]))?.trim() || null;
}

/** Captures commit, branch, and the uncommitted diff. Returns null outside a git repo. */
export async function fingerprint(cwd: string): Promise<{ fp: GitFingerprint; patch: string | null } | null> {
  if (!(await isGitRepo(cwd))) return null;
  const [commit, branch, status, untrackedRaw] = await Promise.all([
    currentCommit(cwd),
    currentBranch(cwd),
    git(cwd, ["status", "--porcelain"]),
    git(cwd, ["ls-files", "--others", "--exclude-standard"]),
  ]);
  const dirty = !!status?.trim();
  let patch: string | null = null;
  let diffStat = "";
  const untracked = (untrackedRaw ?? "").split("\n").filter(Boolean).slice(0, 200);
  if (dirty && commit) {
    patch = (await git(cwd, ["diff", "--binary", "HEAD"])) ?? "";
    diffStat = (await git(cwd, ["diff", "HEAD", "--shortstat"]))?.trim() ?? "";
    // New files too, so the patch alone rebuilds the code the run used (for reproducing it elsewhere).
    for (const f of untracked) {
      if (Buffer.byteLength(patch) > MAX_PATCH_BYTES) break;
      const st = await fs.stat(path.join(cwd, f)).catch(() => null);
      if (!st?.isFile() || st.size > MAX_UNTRACKED_FILE_BYTES) continue;
      patch += (await run(cwd, ["diff", "--no-index", "--binary", "--", "/dev/null", f])).stdout;
    }
    if (Buffer.byteLength(patch) > MAX_PATCH_BYTES) patch = patch.slice(0, MAX_PATCH_BYTES) + "\n# [converge: patch truncated]\n";
  }
  return { fp: { commit, branch, dirty, diffStat, untracked }, patch: patch || null };
}

/** Files changed between two commits, or null if either commit isn't in this repository. */
export async function changedFiles(cwd: string, from: string, to: string): Promise<string[] | null> {
  if (!/^[0-9a-f]{7,40}$/i.test(from) || !/^[0-9a-f]{7,40}$/i.test(to)) return null;
  const out = await git(cwd, ["diff", "--name-only", from, to]);
  return out === null ? null : out.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
}

/** The diff of some files between two commits (for showing the hunks behind a likely cause). */
export async function diffFiles(cwd: string, from: string, to: string, files: string[]): Promise<string> {
  if (!/^[0-9a-f]{7,40}$/i.test(from) || !/^[0-9a-f]{7,40}$/i.test(to) || !files.length) return "";
  return (await git(cwd, ["diff", from, to, "--", ...files])) ?? "";
}

export async function diffCommits(cwd: string, from: string, to: string): Promise<string> {
  if (!/^[0-9a-f]{7,40}$/i.test(from) || !/^[0-9a-f]{7,40}$/i.test(to)) throw new Error("invalid commit");
  return (await git(cwd, ["diff", from, to])) ?? "";
}

/** Runs git and returns its exit code and output, also when it exits non-zero. */
function run(cwd: string, args: string[], input?: string): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const p = spawn("git", args, { cwd, windowsHide: true });
    let stdout = "";
    let stderr = "";
    p.stdout.on("data", (d) => (stdout += d));
    p.stderr.on("data", (d) => (stderr += d));
    p.on("error", (e) => resolve({ code: -1, stdout, stderr: String(e) }));
    p.on("close", (code) => resolve({ code: code ?? -1, stdout, stderr }));
    p.stdin.end(input ?? "");
  });
}

/** Whether the repository has this commit. */
export async function hasCommit(cwd: string, commit: string): Promise<boolean> {
  if (!/^[0-9a-f]{7,40}$/i.test(commit)) return false;
  return (await run(cwd, ["cat-file", "-e", `${commit}^{commit}`])).code === 0;
}

/** The repository's "origin" remote URL, if any. */
export async function remoteUrl(cwd: string): Promise<string | null> {
  return (await git(cwd, ["remote", "get-url", "origin"]))?.trim() || null;
}

/** The git user name, for saying who shared a run. */
export async function userName(cwd: string): Promise<string> {
  return (await git(cwd, ["config", "user.name"]))?.trim() || os.userInfo().username;
}

/**
 * Makes `dir` a checkout of `commit` with `patch` applied: a git worktree of the project, so the
 * user's own files are untouched. Fetches from the remotes when the commit isn't here yet.
 */
export async function checkoutAt(cwd: string, dir: string, commit: string, patch: string | null): Promise<void> {
  if (!/^[0-9a-f]{7,40}$/i.test(commit)) throw new Error("invalid commit");
  if (!(await hasCommit(cwd, commit))) {
    await run(cwd, ["fetch", "--all", "--quiet"]);
    if (!(await hasCommit(cwd, commit)))
      throw new Error(`Commit ${commit.slice(0, 8)} isn't in your repository, even after fetching. Ask whoever ran it to push it, then try again.`);
  }
  await removeCheckout(cwd, dir);
  await fs.mkdir(path.dirname(dir), { recursive: true });
  const add = await run(cwd, ["worktree", "add", "--detach", "--force", dir, commit]);
  if (add.code !== 0) throw new Error(`Couldn't check out ${commit.slice(0, 8)}: ${add.stderr.trim()}`);
  if (patch) {
    if (patch.includes("# [converge: patch truncated]")) throw new Error("The run's uncommitted changes were too big to save in full, so they can't be applied.");
    const apply = await run(dir, ["apply", "--whitespace=nowarn", "--binary", "-"], patch);
    if (apply.code !== 0) throw new Error(`The run's uncommitted changes didn't apply: ${apply.stderr.trim()}`);
  }
}

/** Removes a checkout made by checkoutAt. */
export async function removeCheckout(cwd: string, dir: string): Promise<void> {
  await run(cwd, ["worktree", "remove", "--force", dir]);
  await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  await run(cwd, ["worktree", "prune"]);
}
