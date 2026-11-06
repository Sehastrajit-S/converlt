import { promises as fs } from "node:fs";
import path from "node:path";
import { EMPTY_NOTES, parseEventLines, type LocalRunState, type RunEvent, type RunManifest, type RunNotes } from "@converge/run-protocol";

/**
 * Local-first run history in <project>/.converge/runs/<runId>/:
 *   manifest.json  immutable launch record
 *   events.jsonl   cached copy of the agent's event log (append-only, deduped by seq)
 *   local.json     launch bookkeeping before the agent owns the run
 *   notes.json     experiment intent
 *   code.patch     uncommitted diff at launch
 *   data.json      datasets of a shared run (from its .converlt-run file)
 *   reproduction.json  for a reproduction: whether it got the original's result
 */
export class RunStore {
  readonly root: string;
  private readonly runsDir: string;

  constructor(projectPath: string) {
    this.root = path.join(projectPath, ".converge");
    this.runsDir = path.join(this.root, "runs");
  }

  async init(): Promise<void> {
    await fs.mkdir(this.runsDir, { recursive: true });
    const gi = path.join(this.root, ".gitignore");
    try {
      await fs.writeFile(gi, "# Converlt run history (local)\n*\n", { flag: "wx" });
    } catch {
      // exists
    }
  }

  runDir(runId: string): string {
    if (!/^[A-Za-z0-9_.-]{1,80}$/.test(runId)) throw new Error(`invalid run id ${runId}`);
    return path.join(this.runsDir, runId);
  }

  async listRunIds(): Promise<string[]> {
    try {
      const entries = await fs.readdir(this.runsDir, { withFileTypes: true });
      return entries.filter((e) => e.isDirectory()).map((e) => e.name);
    } catch {
      return [];
    }
  }

  async nextNumber(): Promise<number> {
    let max = 0;
    for (const id of await this.listRunIds()) {
      const m = await this.readManifest(id);
      if (m && m.number > max) max = m.number;
    }
    return max + 1;
  }

  async createRun(manifest: RunManifest, patch: string | null): Promise<void> {
    const dir = this.runDir(manifest.runId);
    await fs.mkdir(dir, { recursive: true });
    if (patch) {
      await fs.writeFile(path.join(dir, "code.patch"), patch, "utf8");
      if (manifest.git) manifest.git.patchFile = "code.patch";
    }
    await fs.writeFile(path.join(dir, "manifest.json"), JSON.stringify(manifest, null, 2), { flag: "wx" });
  }

  async readManifest(runId: string): Promise<RunManifest | null> {
    return readJson<RunManifest>(path.join(this.runDir(runId), "manifest.json"));
  }

  async readEvents(runId: string): Promise<RunEvent[]> {
    try {
      return parseEventLines(await fs.readFile(path.join(this.runDir(runId), "events.jsonl"), "utf8"));
    } catch {
      return [];
    }
  }

  async appendEvents(runId: string, events: RunEvent[]): Promise<void> {
    if (!events.length) return;
    await fs.appendFile(path.join(this.runDir(runId), "events.jsonl"), events.map((e) => JSON.stringify(e)).join("\n") + "\n", "utf8");
  }

  async readLocal(runId: string): Promise<LocalRunState | null> {
    return readJson<LocalRunState>(path.join(this.runDir(runId), "local.json"));
  }

  async writeLocal(runId: string, state: LocalRunState): Promise<void> {
    await writeJsonAtomic(path.join(this.runDir(runId), "local.json"), state);
  }

  async readNotes(runId: string): Promise<RunNotes> {
    return { ...EMPTY_NOTES, ...((await readJson<Partial<RunNotes>>(path.join(this.runDir(runId), "notes.json"))) ?? {}) };
  }

  async writeNotes(runId: string, notes: RunNotes): Promise<void> {
    await writeJsonAtomic(path.join(this.runDir(runId), "notes.json"), notes);
  }

  async readText(runId: string, file: string): Promise<string | null> {
    try {
      return await fs.readFile(path.join(this.runDir(runId), file), "utf8");
    } catch {
      return null;
    }
  }

  async readJson<T>(runId: string, file: string): Promise<T | null> {
    return readJson<T>(path.join(this.runDir(runId), file));
  }

  async writeJson(runId: string, file: string, data: unknown): Promise<void> {
    await writeJsonAtomic(path.join(this.runDir(runId), file), data);
  }

  /** Writes a run that came from elsewhere (a shared run file). */
  async importRun(manifest: RunManifest, events: string, notes: RunNotes, patch: string | null, data: unknown): Promise<void> {
    const dir = this.runDir(manifest.runId);
    await fs.mkdir(dir, { recursive: true });
    if (patch) await fs.writeFile(path.join(dir, "code.patch"), patch, "utf8");
    await fs.writeFile(path.join(dir, "events.jsonl"), events, "utf8");
    await writeJsonAtomic(path.join(dir, "notes.json"), notes);
    await writeJsonAtomic(path.join(dir, "data.json"), data);
    await fs.writeFile(path.join(dir, "manifest.json"), JSON.stringify(manifest, null, 2));
  }

  patchPath(runId: string): string {
    return path.join(this.runDir(runId), "code.patch");
  }

  async hasPatch(runId: string): Promise<boolean> {
    try {
      await fs.access(this.patchPath(runId));
      return true;
    } catch {
      return false;
    }
  }
}

async function readJson<T>(file: string): Promise<T | null> {
  try {
    return JSON.parse(await fs.readFile(file, "utf8")) as T;
  } catch {
    return null;
  }
}

async function writeJsonAtomic(file: string, data: unknown): Promise<void> {
  const tmp = `${file}.${process.pid}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(data, null, 2), "utf8");
  await fs.rename(tmp, file);
}
