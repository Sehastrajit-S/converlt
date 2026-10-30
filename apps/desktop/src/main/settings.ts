import { promises as fs } from "node:fs";
import path from "node:path";
import type { Machine } from "@converge/run-protocol";
import { DEFAULT_SETTINGS, type ProbeResult, type Settings } from "@converge/core";

interface Persisted {
  settings: Settings;
  machines: Machine[];
  probes: Record<string, ProbeResult>;
  recentProjects: string[];
  lastProject: string | null;
}

/** App-level state in userData/converge.json. No secrets are stored: SSH keys stay in the user's ssh setup. */
export class AppStore {
  private readonly file: string;
  data: Persisted;
  private writing: Promise<void> = Promise.resolve();

  constructor(userDataDir: string) {
    this.file = path.join(userDataDir, "converge.json");
    this.data = { settings: DEFAULT_SETTINGS, machines: [], probes: {}, recentProjects: [], lastProject: null };
  }

  async load(): Promise<void> {
    try {
      const raw = JSON.parse(await fs.readFile(this.file, "utf8")) as Partial<Persisted>;
      this.data = {
        ...this.data,
        ...raw,
        settings: {
          ...DEFAULT_SETTINGS,
          ...(raw.settings ?? {}),
          defaultOptions: { ...DEFAULT_SETTINGS.defaultOptions, ...(raw.settings?.defaultOptions ?? {}) },
        },
      };
    } catch {
      // first launch
    }
  }

  save(): Promise<void> {
    const snapshot = JSON.stringify(this.data, null, 2);
    this.writing = this.writing.then(async () => {
      await fs.mkdir(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.tmp`;
      await fs.writeFile(tmp, snapshot, "utf8");
      await fs.rename(tmp, this.file);
    });
    return this.writing;
  }

  touchProject(p: string): void {
    this.data.recentProjects = [p, ...this.data.recentProjects.filter((x) => x !== p)].slice(0, 8);
    this.data.lastProject = p;
  }
}
