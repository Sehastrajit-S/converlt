// Runs the assistant's tool calls. Reads see the editor's buffers; edits go into them as
// unsaved changes, so nothing reaches disk until the user saves (create_file excepted).
import type { ConvergeApi } from "@converge/core/api";
import type { AgentToolRequest, AgentToolResult } from "../../shared/ide.ts";
import { fs, getOpenModel, monaco, openModel } from "./monaco.ts";

export interface ToolHost {
  api: ConvergeApi;
  /** The assistant touched this file: open it in a tab. */
  opened(path: string, edited: boolean): void;
}

const MAX_READ_LINES = 2000;
const MAX_OUTPUT = 60_000;

const clip = (s: string) => (s.length > MAX_OUTPUT ? `${s.slice(0, MAX_OUTPUT)}\n… (output truncated)` : s);
const normPath = (p: string) => p.replace(/\\/g, "/").replace(/^\.\//, "").replace(/^\/+/, "");

async function currentText(path: string): Promise<string> {
  const open = getOpenModel(path);
  if (open) return open.getValue(monaco.editor.EndOfLinePreference.LF);
  const c = await fs.read(path);
  if (c.binary) throw new Error(`${path} is a binary or very large file (${c.size} bytes)`);
  return c.text.replace(/\r\n/g, "\n");
}

/** Line/column (1-based) of an offset into LF-normalized text. */
function positionAt(text: string, offset: number): { lineNumber: number; column: number } {
  let line = 1;
  let lineStart = 0;
  for (let i = text.indexOf("\n"); i !== -1 && i < offset; i = text.indexOf("\n", i + 1)) {
    line++;
    lineStart = i + 1;
  }
  return { lineNumber: line, column: offset - lineStart + 1 };
}

async function run(req: AgentToolRequest, host: ToolHost): Promise<string> {
  const input = req.input;
  switch (req.name) {
    case "list_files": {
      const filter = typeof input.filter === "string" ? input.filter.toLowerCase() : "";
      const files = (await fs.files()).filter((f) => !filter || f.toLowerCase().includes(filter));
      return files.length ? files.slice(0, 3000).join("\n") + (files.length > 3000 ? `\n… ${files.length - 3000} more` : "") : "No files match.";
    }
    case "read_file": {
      const path = normPath(String(input.path));
      const lines = (await currentText(path)).split("\n");
      const start = Math.max(1, Number(input.start_line) || 1);
      const end = Math.min(lines.length, Number(input.end_line) || start + MAX_READ_LINES - 1);
      const body = lines
        .slice(start - 1, end)
        .map((l, i) => `${String(start + i).padStart(5)}  ${l}`)
        .join("\n");
      const more = end < lines.length ? `\n… lines ${end + 1}-${lines.length} not shown; pass start_line to read more.` : "";
      return `${path} (${lines.length} lines)\n${body}${more}`;
    }
    case "search_files": {
      const r = await fs.search(String(input.query), { regex: !!input.regex, caseSensitive: !!input.case_sensitive });
      if (!r.total) return "No matches.";
      const out: string[] = [];
      for (const f of r.files) for (const m of f.matches) out.push(`${f.path}:${m.line}: ${m.text.trim()}`);
      return `${r.total}${r.truncated ? "+" : ""} matches\n${out.slice(0, 300).join("\n")}${out.length > 300 ? `\n… ${out.length - 300} more` : ""}`;
    }
    case "edit_file": {
      const path = normPath(String(input.path));
      const oldStr = String(input.old_string).replace(/\r\n/g, "\n");
      const newStr = String(input.new_string).replace(/\r\n/g, "\n");
      if (!oldStr) throw new Error("old_string is empty; use create_file for new files");
      const opened = await openModel(path);
      if ("binary" in opened) throw new Error(`${path} is a binary file`);
      const model = opened.model;
      const text = model.getValue(monaco.editor.EndOfLinePreference.LF);
      const at = text.indexOf(oldStr);
      if (at === -1) throw new Error(`old_string was not found in ${path}. Read the file again; it may have changed.`);
      if (text.indexOf(oldStr, at + 1) !== -1) throw new Error(`old_string occurs more than once in ${path}. Include more surrounding lines.`);
      const from = positionAt(text, at);
      const to = positionAt(text, at + oldStr.length);
      // An undoable edit in the buffer; Monaco converts \n to the file's own line endings.
      model.pushEditOperations([], [{ range: new monaco.Range(from.lineNumber, from.column, to.lineNumber, to.column), text: newStr }], () => null);
      host.opened(path, true);
      const added = newStr.split("\n").length;
      return `Edited ${path} at lines ${from.lineNumber}-${from.lineNumber + added - 1}. The change is unsaved in the editor for the user to review.`;
    }
    case "create_file": {
      const path = normPath(String(input.path));
      const exists = await fs.read(path).then(
        () => true,
        () => false,
      );
      if (exists || getOpenModel(path)) throw new Error(`${path} already exists; use edit_file`);
      await fs.write(path, String(input.content));
      host.opened(path, false);
      return `Created ${path} and opened it.`;
    }
    case "list_runs": {
      const runs = await host.api.listRuns();
      if (!runs.length) return "No runs yet.";
      return runs
        .map((r) => {
          const metric = r.primaryMetric ? ` ${r.primaryMetric.key}=${r.primaryMetric.last ?? "NaN"}` : "";
          const diag = r.diagnosticKinds.length ? ` diagnostics=${r.diagnosticKinds.join(",")}` : "";
          return `${r.name} (${r.runId}) ${r.status}${metric}${diag} machine=${r.machineName} :: ${r.command}`;
        })
        .join("\n");
    }
    case "get_run": {
      const key = String(input.run);
      const runs = await host.api.listRuns();
      const item = runs.find((r) => r.name === key || r.runId === key);
      if (!item) throw new Error(`No run named ${key}. Use list_runs to see run names.`);
      const v = await host.api.getRun(item.runId);
      if (!v) throw new Error(`Run ${key} could not be loaded`);
      const s = v.summary;
      const metrics = Object.fromEntries(
        Object.entries(s.metrics).map(([k, pts]) => {
          const finite = pts.filter((p) => p.value !== null).map((p) => p.value as number);
          return [k, { points: pts.length, last: pts.at(-1)?.value ?? null, lastStep: pts.at(-1)?.step ?? null, min: finite.length ? Math.min(...finite) : null, max: finite.length ? Math.max(...finite) : null }];
        }),
      );
      return clip(
        JSON.stringify(
          {
            name: v.manifest.name,
            status: v.status,
            connection: v.connection,
            command: v.manifest.command,
            config: v.effectiveConfig,
            git: v.manifest.git ? { commit: v.manifest.git.commit, dirty: v.manifest.git.dirty } : null,
            machine: v.manifest.machine.name,
            exitCode: s.exitCode,
            reason: s.reason,
            durationSec: v.durationSec,
            latestStep: s.latestStep,
            peakGpuMemMiB: s.peakGpuMemMiB,
            metrics,
            diagnostics: s.diagnostics.map((d) => ({ kind: d.kind, severity: d.severity, message: d.message, step: d.step, data: d.data })),
            env: s.env,
            lastLogLines: s.logs.slice(-80).map((l) => (l.stream === "stderr" ? `[stderr] ${l.line}` : l.line)),
            notes: v.notes,
          },
          null,
          1,
        ),
      );
    }
    default:
      throw new Error(`Unknown tool ${req.name}`);
  }
}

export async function runAgentTool(req: AgentToolRequest, host: ToolHost): Promise<AgentToolResult> {
  try {
    return { content: await run(req, host) };
  } catch (e) {
    return { content: e instanceof Error ? e.message : String(e), isError: true };
  }
}
