import { execFile, spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

/** Excluded by default: large artifacts, datasets, environments, and credentials. */
export const DEFAULT_EXCLUDES = [
  "**/.git/**",
  "**/node_modules/**",
  "**/__pycache__/**",
  "**/.venv/**",
  "**/venv/**",
  "**/.converge/**",
  "**/wandb/**",
  "**/mlruns/**",
  "**/lightning_logs/**",
  "**/.ipynb_checkpoints/**",
  "**/checkpoints/**",
  "**/*.pt",
  "**/*.pth",
  "**/*.ckpt",
  "**/*.safetensors",
  "**/*.bin",
  "**/*.onnx",
  "**/*.h5",
  "**/*.npy",
  "**/*.npz",
  "**/*.parquet",
  "**/*.arrow",
  "**/*.tar",
  "**/*.tar.gz",
  "**/*.tgz",
  "**/*.zip",
  "**/.env",
  "**/.env.*",
  "**/*.pem",
  "**/*.key",
  "**/id_rsa*",
  "**/id_ed25519*",
  "**/.netrc",
  "**/credentials*.json",
];

export function globToRegExp(glob: string): RegExp {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!;
    if (c === "*") {
      if (glob[i + 1] === "*") {
        if (glob[i + 2] === "/") {
          re += "(?:.*/)?";
          i += 2;
        } else {
          re += ".*";
          i += 1;
        }
      } else re += "[^/]*";
    } else if (c === "?") re += "[^/]";
    else re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${re}$`, "i");
}

export interface SyncRules {
  patterns: RegExp[];
  maxBytes: number;
}

export function makeRules(extraExcludes: string[], maxFileSizeMB: number): SyncRules {
  return { patterns: [...DEFAULT_EXCLUDES, ...extraExcludes].map(globToRegExp), maxBytes: maxFileSizeMB * 1024 * 1024 };
}

/** Returns why a file is excluded, or null if it should be synced. */
export function exclusionReason(rel: string, size: number, rules: SyncRules): string | null {
  const p = rel.replace(/\\/g, "/");
  if (rules.patterns.some((re) => re.test(p))) return "excluded pattern";
  if (size > rules.maxBytes) return `larger than ${Math.round(rules.maxBytes / 1024 / 1024)} MB`;
  return null;
}

export interface SyncPlan {
  root: string;
  files: string[];
  bytes: number;
  skipped: { path: string; reason: string }[];
  usedGit: boolean;
}

const MAX_FILES = 50_000;

function gitList(root: string): Promise<string[] | null> {
  return new Promise((resolve) => {
    execFile(
      "git",
      ["ls-files", "-z", "--cached", "--others", "--exclude-standard"],
      { cwd: root, maxBuffer: 64 * 1024 * 1024, windowsHide: true },
      (err, stdout) => resolve(err ? null : stdout.split("\0").filter(Boolean)),
    );
  });
}

async function walk(root: string, rules: SyncRules): Promise<string[]> {
  const out: string[] = [];
  async function visit(dir: string): Promise<void> {
    if (out.length > MAX_FILES) return;
    const entries = await fs.readdir(path.join(root, dir), { withFileTypes: true });
    for (const e of entries) {
      const rel = dir ? `${dir}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (rules.patterns.some((re) => re.test(`${rel}/`))) continue;
        await visit(rel);
      } else if (e.isFile()) out.push(rel);
    }
  }
  await visit("");
  return out;
}

export async function planSync(root: string, rules: SyncRules): Promise<SyncPlan> {
  const gitFiles = await gitList(root);
  const candidates = gitFiles ?? (await walk(root, rules));
  const files: string[] = [];
  const skipped: SyncPlan["skipped"] = [];
  let bytes = 0;
  for (const rel of candidates) {
    let size: number;
    try {
      const st = await fs.stat(path.join(root, rel));
      if (!st.isFile()) continue;
      size = st.size;
    } catch {
      continue; // deleted but still in the index
    }
    const reason = exclusionReason(rel, size, rules);
    if (reason) skipped.push({ path: rel, reason });
    else {
      files.push(rel);
      bytes += size;
    }
    if (files.length > MAX_FILES) throw new Error(`More than ${MAX_FILES} files to sync. Add exclude patterns in Settings.`);
  }
  return { root, files, bytes, skipped, usedGit: gitFiles !== null };
}

/** Starts `tar -cf -` over the plan's files; returns the archive stream. */
export async function createTarStream(plan: SyncPlan): Promise<{ stream: NodeJS.ReadableStream; done: Promise<void> }> {
  const listFile = path.join(os.tmpdir(), `converge-sync-${process.pid}-${Date.now()}.txt`);
  await fs.writeFile(listFile, plan.files.join("\n") + "\n", "utf8");
  // cwd instead of -C: GNU tar treats "C:\..." as a remote host spec.
  const tar = spawn("tar", ["-cf", "-", "-T", listFile], { cwd: plan.root, windowsHide: true });
  let stderr = "";
  tar.stderr.on("data", (d) => (stderr += d.toString()));
  const done = new Promise<void>((resolve, reject) => {
    tar.on("error", reject);
    tar.on("close", (code) => {
      fs.rm(listFile, { force: true }).catch(() => {});
      code === 0 ? resolve() : reject(new Error(`tar failed (${code}): ${stderr.trim()}`));
    });
  });
  return { stream: tar.stdout, done };
}
