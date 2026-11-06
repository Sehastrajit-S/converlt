// Code → graph: runs converge_import.py on a machine with the project's Python files, so a
// PyTorch model the user wrote (or got from a library) opens in the Model Builder as a graph.
import { promises as fs } from "node:fs";
import path from "node:path";
import { pythonCmd, REMOTE_LIB } from "./agentClient.ts";
import { lastJsonLine, remotePath, type RemoteTransport } from "./transport.ts";
import type { ImportedGraph } from "@converge/run-protocol";

const IMPORT_SCRIPT = `${REMOTE_LIB}/agent/converge_import.py`;
const SKIP_DIRS = new Set([".git", ".converge", "node_modules", "__pycache__", ".venv", "venv", "env", ".env", ".tox", ".mypy_cache", "site-packages", "checkpoints", "wandb", "mlruns"]);
const MAX_FILE = 512 * 1024;
const MAX_TOTAL = 6 * 1024 * 1024;

export interface ImportRequest {
  /** Project-relative path with forward slashes, e.g. "models/net.py". */
  file: string;
  className?: string | null;
  inputShape?: number[] | null;
  dtype?: "float" | "long" | null;
  timesteps?: number | null;
}

export interface ImportReply {
  ok: boolean;
  error?: string;
  /** nn.Module classes defined in the file. */
  classes?: string[];
  /** From the request, or the file's INPUT_SHAPE. */
  inputShape?: number[] | null;
  inputDtype?: "long" | "float" | null;
  /** What's missing before it can be traced. */
  need?: "class" | "shape";
  graph?: ImportedGraph | null;
  torchParams?: number;
  custom?: string[];
  notes?: string[];
}

/** The project's Python files (bounded), keyed by forward-slash relative path. */
export async function projectPythonFiles(root: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  let total = 0;
  const walk = async (dir: string, depth: number): Promise<void> => {
    if (depth > 8) return;
    for (const e of await fs.readdir(dir, { withFileTypes: true }).catch(() => [])) {
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name) && !e.name.startsWith(".")) await walk(path.join(dir, e.name), depth + 1);
      } else if (e.name.endsWith(".py")) {
        const full = path.join(dir, e.name);
        const st = await fs.stat(full).catch(() => null);
        if (!st || st.size > MAX_FILE || total + st.size > MAX_TOTAL) continue;
        out[path.relative(root, full).replace(/\\/g, "/")] = await fs.readFile(full, "utf8");
        total += st.size;
      }
    }
  };
  await walk(root, 0);
  return out;
}

/** Python files that define a PyTorch module, for the import dialog. */
export async function modelFiles(root: string): Promise<string[]> {
  const files = await projectPythonFiles(root);
  return Object.entries(files)
    .filter(([, src]) => /class\s+\w+\s*\([^)]*(nn\.Module|Module)\b/.test(src))
    .map(([f]) => f)
    .sort();
}

export async function importModel(t: RemoteTransport, python: string, files: Record<string, string>, req: ImportRequest, explain: (s: string) => string): Promise<ImportReply> {
  if (!files[req.file]) throw new Error(`${req.file} isn't in the project (or is too large to send).`);
  const payload = JSON.stringify({ files, ...req });
  const r = await t.exec(`cd /tmp && ${pythonCmd(python)} ${remotePath(IMPORT_SCRIPT)}`, { input: payload, timeoutMs: 5 * 60_000 });
  const json = lastJsonLine<ImportReply>(r.stdout);
  if (!json) throw new Error(explain(r.stderr) || `The importer returned nothing (exit ${r.code}). ${r.stderr.trim().split("\n").slice(-4).join(" ")}`);
  return json;
}
