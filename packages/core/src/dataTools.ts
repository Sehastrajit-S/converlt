// Data tools on a machine: browse its folders, profile a dataset, and dry-run a preprocessing
// script on a sample. converge_data.py is installed with the agent; profiling and previews run
// with the machine's training Python, so pandas from that environment is used when present.
import type { DataProfile } from "@converge/run-protocol";
import type { BrowseResult, PreprocessPreview } from "./api.ts";
import { pythonCmd, REMOTE_LIB } from "./agentClient.ts";
import { lastJsonLine, remotePath, shq, type RemoteTransport } from "./transport.ts";

const DATA_SCRIPT = `${REMOTE_LIB}/agent/converge_data.py`;

export class DataTools {
  private readonly t: RemoteTransport;
  private readonly python: string;
  private readonly explain: (stderr: string) => string;

  constructor(t: RemoteTransport, python: string, explain: (stderr: string) => string) {
    this.t = t;
    this.python = python;
    this.explain = explain;
  }

  private async run<T>(args: string, timeoutMs: number): Promise<T> {
    const r = await this.t.exec(`${pythonCmd(this.python)} ${remotePath(DATA_SCRIPT)} ${args}`, { timeoutMs });
    const json = lastJsonLine<T & { ok?: boolean; error?: string }>(r.stdout);
    if (!json) throw new Error(this.explain(r.stderr) || `The data tool returned nothing (exit ${r.code}). ${r.stderr.trim().slice(-300)}`);
    if (json.ok === false) throw new Error(json.error ?? "The data tool failed");
    return json;
  }

  browse(dir: string | null): Promise<BrowseResult> {
    return this.run<BrowseResult>(`browse ${dir ? shq(dir) : ""}`, 30_000);
  }

  profile(path: string, target?: string | null): Promise<DataProfile> {
    return this.run<DataProfile>(`profile ${shq(path)}${target ? ` --target ${shq(target)}` : ""}`, 10 * 60_000);
  }

  /** Runs a generated preprocessing script with --preview on the machine; nothing is written there. */
  async preview(script: string, rows: number): Promise<PreprocessPreview> {
    const r = await this.t.exec(`cd /tmp && ${pythonCmd(this.python)} - --preview ${Math.max(10, Math.round(rows))}`, { input: script, timeoutMs: 5 * 60_000 });
    const json = lastJsonLine<PreprocessPreview>(r.stdout);
    if (r.code !== 0 || !json) {
      const err = r.stderr.trim();
      if (/No module named 'pandas'|No module named 'numpy'/.test(err)) throw new Error("Preprocessing needs pandas in the machine's training environment: pip install pandas pyarrow");
      throw new Error(err.split("\n").slice(-6).join("\n") || `The preview failed (exit ${r.code}).`);
    }
    return json;
  }
}
