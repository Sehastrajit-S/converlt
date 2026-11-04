import { execFile } from "node:child_process";
import type { GitFingerprint } from "@converge/run-protocol";

const MAX_PATCH_BYTES = 5 * 1024 * 1024;

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
  if (dirty && commit) {
    patch = await git(cwd, ["diff", "HEAD"]);
    diffStat = (await git(cwd, ["diff", "HEAD", "--shortstat"]))?.trim() ?? "";
    if (patch && Buffer.byteLength(patch) > MAX_PATCH_BYTES) patch = patch.slice(0, MAX_PATCH_BYTES) + "\n# [converge: patch truncated]\n";
  }
  const untracked = (untrackedRaw ?? "").split("\n").filter(Boolean).slice(0, 200);
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
