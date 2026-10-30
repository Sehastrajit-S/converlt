// File access for the built-in editor. Every path is relative to the open project and is
// rejected if it resolves outside it, so the renderer can never read or write elsewhere.
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type { DirEntry, FileContent, SearchOptions, SearchResult } from "../shared/ide.ts";

const HIDDEN = new Set([".git", "node_modules", "__pycache__", ".converge", ".venv", "venv", ".mypy_cache", ".pytest_cache", ".ipynb_checkpoints", ".DS_Store"]);
const MAX_TEXT = 5 * 1024 * 1024;
const MAX_LIST = 20000;

function resolve(root: string, rel: string): string {
  const abs = path.resolve(root, rel || ".");
  const back = path.relative(root, abs);
  if (back.startsWith("..") || path.isAbsolute(back)) throw new Error(`Path is outside the project: ${rel}`);
  return abs;
}

const toRel = (root: string, abs: string) => path.relative(root, abs).split(path.sep).join("/");

export async function listDir(root: string, rel: string): Promise<DirEntry[]> {
  const dir = resolve(root, rel);
  const entries = await readdir(dir, { withFileTypes: true });
  return entries
    .filter((e) => !HIDDEN.has(e.name))
    .map((e) => ({ name: e.name, path: toRel(root, path.join(dir, e.name)), dir: e.isDirectory() }))
    .sort((a, b) => Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" }));
}

/** Every file in the project (for quick open), skipping the same folders as the explorer. */
export async function listFiles(root: string): Promise<string[]> {
  const out: string[] = [];
  const queue = [root];
  while (queue.length && out.length < MAX_LIST) {
    const dir = queue.shift()!;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (HIDDEN.has(e.name)) continue;
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) queue.push(abs);
      else out.push(toRel(root, abs));
    }
  }
  return out.sort();
}

export async function readText(root: string, rel: string): Promise<FileContent> {
  const abs = resolve(root, rel);
  const { size } = await stat(abs);
  if (size > MAX_TEXT) return { binary: true, size };
  const buf = await readFile(abs);
  if (buf.subarray(0, 8000).includes(0)) return { binary: true, size };
  return { binary: false, text: buf.toString("utf8") };
}

export async function writeText(root: string, rel: string, text: string): Promise<void> {
  const abs = resolve(root, rel);
  await mkdir(path.dirname(abs), { recursive: true });
  await writeFile(abs, text, "utf8");
}

const MAX_MATCHES = 2000;
const MAX_SEARCH_FILE = 1024 * 1024;

/** Text search over every project file the explorer shows. Binary and >1 MB files are skipped. */
export async function search(root: string, query: string, opts: SearchOptions): Promise<SearchResult> {
  if (!query) return { files: [], total: 0, truncated: false };
  const source = opts.regex ? query : query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(opts.wholeWord ? `\\b(?:${source})\\b` : source, opts.caseSensitive ? "g" : "gi");
  const out: SearchResult = { files: [], total: 0, truncated: false };
  for (const rel of await listFiles(root)) {
    if (out.total >= MAX_MATCHES) {
      out.truncated = true;
      break;
    }
    const abs = path.join(root, rel);
    let buf: Buffer;
    try {
      if ((await stat(abs)).size > MAX_SEARCH_FILE) continue;
      buf = await readFile(abs);
    } catch {
      continue;
    }
    if (buf.subarray(0, 8000).includes(0)) continue;
    const matches: SearchResult["files"][number]["matches"] = [];
    const lines = buf.toString("utf8").split(/\r?\n/);
    for (let i = 0; i < lines.length && out.total < MAX_MATCHES; i++) {
      re.lastIndex = 0;
      const m = re.exec(lines[i]);
      if (!m) continue;
      matches.push({ line: i + 1, col: m.index + 1, length: Math.max(m[0].length, 1), text: lines[i].slice(0, 400) });
      out.total++;
    }
    if (matches.length) out.files.push({ path: rel, matches });
  }
  return out;
}
