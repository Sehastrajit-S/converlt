// AI assistant for the built-in IDE. The model call and the API key stay in the main process;
// tools run in the renderer, which owns the editor buffers, so edits land as unsaved changes the
// user reviews before saving. One conversation at a time, append-only history.
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import { safeStorage } from "electron";
import { AGENT_MODELS, type AgentConfig, type AgentContext, type AgentEvent, type AgentToolRequest, type AgentToolResult } from "../shared/ide.ts";

const DEFAULT_MODEL = "claude-opus-5-5";
const MAX_TOOL_TURNS = 40;
const TOOL_TIMEOUT_MS = 120_000;
/** Models with server-side refusal fallback (Haiku has none). */
const FALLBACK_MODELS = new Set(["claude-opus-5-5", "claude-sonnet-5-5", "claude-fable-5-1"]);

const SYSTEM = `You are the AI assistant built into Converlt, an ML development IDE. The user writes PyTorch training code here and launches runs on remote GPUs; Converlt records every run (command, config, metrics, logs, GPU telemetry) and diagnoses failures such as NaN losses, CUDA OOM, and crashes.

You work inside the user's open project through tools:
- list_files, read_file, search_files to explore code. read_file returns the editor's current buffer, including unsaved changes.
- edit_file and create_file to change code. Edits are applied to the editor as unsaved changes; the user reviews them and saves, or undoes them. Make the smallest edit that does the job, keep the file's style, and read a file before editing it.
- list_runs and get_run to look at training runs: status, config, metrics, diagnostics and recent logs. When the user asks about a failure, look at the run before answering.

You cannot run commands or launch training yourself. When a run is needed, give the exact command for the user to launch with Run on GPU.

Be direct and concise. Refer to code as path:line. Use fenced code blocks only for code the user should read, not for edits you already applied.`;

const TOOLS: Anthropic.Beta.BetaTool[] = [
  {
    name: "list_files",
    description: "List every file in the project (relative paths). Optionally filter by a case-insensitive substring of the path.",
    input_schema: { type: "object", properties: { filter: { type: "string", description: "Substring to filter paths by" } }, required: [] },
  },
  {
    name: "read_file",
    description: "Read a project file with line numbers. Returns the editor buffer if the file is open (including unsaved changes). Use start_line/end_line for large files.",
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Project-relative path" },
        start_line: { type: "integer", description: "First line, 1-based" },
        end_line: { type: "integer", description: "Last line, inclusive" },
      },
      required: ["path"],
    },
  },
  {
    name: "search_files",
    description: "Search the text of every project file. Returns matching lines as path:line: text.",
    input_schema: {
      type: "object",
      properties: {
        query: { type: "string" },
        regex: { type: "boolean", description: "Treat query as a JavaScript regular expression" },
        case_sensitive: { type: "boolean" },
      },
      required: ["query"],
    },
  },
  {
    name: "edit_file",
    description:
      "Replace one exact occurrence of old_string with new_string in a file. old_string must match the current file text exactly (including whitespace) and be unique; include surrounding lines to make it unique. The change is applied to the editor as an unsaved edit.",
    input_schema: {
      type: "object",
      properties: { path: { type: "string" }, old_string: { type: "string" }, new_string: { type: "string" } },
      required: ["path", "old_string", "new_string"],
    },
  },
  {
    name: "create_file",
    description: "Create a new file with the given content and open it in the editor. Fails if the file already exists; use edit_file for existing files.",
    input_schema: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } }, required: ["path", "content"] },
  },
  {
    name: "list_runs",
    description: "List the project's training runs, newest first: name, id, status, command, primary metric, diagnostics.",
    input_schema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "get_run",
    description: "Details of one training run: command, config, git commit, machine, metric summary, diagnostics (NaN, OOM, crash analysis) and the last log lines.",
    input_schema: { type: "object", properties: { run: { type: "string", description: "Run name (e.g. run-003) or run id" } }, required: ["run"] },
  },
].map((t) => ({ ...t, eager_input_streaming: true }) as Anthropic.Beta.BetaTool);

const REQUIRED: Record<string, Record<string, "string" | "boolean" | "number">> = {
  list_files: {},
  read_file: { path: "string" },
  search_files: { query: "string" },
  edit_file: { path: "string", old_string: "string", new_string: "string" },
  create_file: { path: "string", content: "string" },
  list_runs: {},
  get_run: { run: "string" },
};

/** Eager input streaming skips server-side validation, so check each input before running it. */
function validate(name: string, input: unknown): string | null {
  const req = REQUIRED[name];
  if (!req) return `Unknown tool ${name}`;
  if (!input || typeof input !== "object") return "Tool input must be an object";
  for (const [k, t] of Object.entries(req)) {
    if (typeof (input as Record<string, unknown>)[k] !== t) return `Missing or invalid "${k}" (expected ${t})`;
  }
  return null;
}

class Stopped extends Error {}

export interface AgentHooks {
  event(e: AgentEvent): void;
  tool(req: AgentToolRequest): void;
}

export class Agent {
  private file: string;
  private stored: { key: string | null; model: string } = { key: null, model: DEFAULT_MODEL };
  private messages: Anthropic.Beta.BetaMessageParam[] = [];
  private running = false;
  private abort: AbortController | null = null;
  private pending = new Map<string, { resolve: (r: AgentToolResult) => void; timer: NodeJS.Timeout }>();
  private nextCall = 1;

  constructor(
    userData: string,
    private hooks: AgentHooks,
  ) {
    this.file = path.join(userData, "agent.json");
  }

  async load(): Promise<void> {
    try {
      const raw = JSON.parse(await readFile(this.file, "utf8"));
      if (AGENT_MODELS.some((m) => m.id === raw.model)) this.stored.model = raw.model;
      this.stored.key = raw.key ?? null;
    } catch {
      // first run
    }
  }

  config(): AgentConfig {
    return { hasKey: !!this.stored.key, model: this.stored.model };
  }

  async setConfig(patch: { apiKey?: string | null; model?: string }): Promise<AgentConfig> {
    if (patch.model && AGENT_MODELS.some((m) => m.id === patch.model)) this.stored.model = patch.model;
    if (patch.apiKey !== undefined) {
      const key = patch.apiKey?.trim();
      if (!key) this.stored.key = null;
      else {
        if (!safeStorage.isEncryptionAvailable()) throw new Error("The OS keychain is unavailable, so the key can't be stored safely. Set ANTHROPIC_API_KEY instead.");
        this.stored.key = safeStorage.encryptString(key).toString("base64");
      }
    }
    await writeFile(this.file, JSON.stringify(this.stored, null, 2));
    return this.config();
  }

  private client(): Anthropic {
    // No stored key: the SDK falls back to ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN / an `ant auth login` profile.
    if (!this.stored.key) return new Anthropic();
    return new Anthropic({ apiKey: safeStorage.decryptString(Buffer.from(this.stored.key, "base64")) });
  }

  reset(): void {
    this.stop();
    this.messages = [];
  }

  stop(): void {
    this.abort?.abort();
    for (const [id, p] of this.pending) {
      clearTimeout(p.timer);
      p.resolve({ content: "Stopped by the user.", isError: true });
      this.pending.delete(id);
    }
  }

  toolResult(callId: string, result: AgentToolResult): void {
    const p = this.pending.get(callId);
    if (!p) return;
    clearTimeout(p.timer);
    this.pending.delete(callId);
    p.resolve(result);
  }

  private runTool(name: string, input: Record<string, unknown>): Promise<AgentToolResult> {
    const callId = String(this.nextCall++);
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(callId);
        resolve({ content: "The tool timed out.", isError: true });
      }, TOOL_TIMEOUT_MS);
      this.pending.set(callId, { resolve, timer });
      this.hooks.tool({ callId, name, input });
    });
  }

  async send(text: string, ctx: AgentContext): Promise<void> {
    if (this.running) throw new Error("The assistant is still working on the last message");
    this.running = true;
    const emit = (e: AgentEvent) => this.hooks.event(e);
    let client: Anthropic;
    try {
      client = this.client();
    } catch (e) {
      this.running = false;
      emit({ type: "error", message: e instanceof Error ? e.message : String(e), auth: true });
      return;
    }

    const content: Anthropic.Beta.BetaContentBlockParam[] = [];
    const contextText = describeContext(ctx);
    if (contextText) content.push({ type: "text", text: contextText });
    content.push({ type: "text", text });
    this.messages.push({ role: "user", content });

    const model = this.stored.model;
    const usage = { input: 0, output: 0, cacheRead: 0 };
    let stopReason: string | null = null;
    let jsonRetries = 0;
    try {
      for (let turn = 0; turn < MAX_TOOL_TURNS; turn++) {
        this.abort = new AbortController();
        emit({ type: "turn_start", turn });
        const stream = client.beta.messages.stream(
          {
            model,
            max_tokens: 64000,
            system: SYSTEM,
            tools: TOOLS,
            messages: this.messages,
            thinking: { type: "adaptive", display: "summarized" },
            output_config: { effort: "high" },
            cache_control: { type: "ephemeral" },
            ...(FALLBACK_MODELS.has(model) ? { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" as const } : {}),
          },
          { signal: this.abort.signal },
        );
        for await (const ev of stream) {
          if (ev.type === "content_block_delta") {
            if (ev.delta.type === "text_delta") emit({ type: "text", delta: ev.delta.text });
            else if (ev.delta.type === "thinking_delta") emit({ type: "thinking", delta: ev.delta.thinking });
          } else if (ev.type === "content_block_start" && ev.content_block.type === "fallback") {
            emit({ type: "fallback", from: ev.content_block.from.model, to: ev.content_block.to.model });
          }
        }

        let message: Anthropic.Beta.BetaMessage;
        try {
          message = await stream.finalMessage();
          jsonRetries = 0;
        } catch (err) {
          // With eager input streaming, a tool input that isn't valid JSON rejects here.
          // Only that is retried (the failed turn was never appended); API errors propagate.
          if (err instanceof Anthropic.APIError || this.abort.signal.aborted || jsonRetries++ >= 2) throw err;
          continue;
        }
        usage.input += message.usage.input_tokens;
        usage.output += message.usage.output_tokens;
        usage.cacheRead += message.usage.cache_read_input_tokens ?? 0;
        stopReason = message.stop_reason;

        if (message.stop_reason === "refusal") {
          // Never append or run tools from a declined turn.
          emit({ type: "error", message: `The model declined this request${message.stop_details?.explanation ? `: ${message.stop_details.explanation}` : "."}` });
          return;
        }
        // Append the full content (thinking, fallback blocks included) unchanged.
        this.messages.push({ role: "assistant", content: message.content });
        if (message.stop_reason === "pause_turn") continue;

        const calls = message.content.filter((b): b is Anthropic.Beta.BetaToolUseBlock => b.type === "tool_use");
        if (!calls.length) break;
        if (message.stop_reason === "max_tokens") {
          // A truncated tool input can still look valid: answer every call with an error instead of running it.
          this.messages.push({
            role: "user",
            content: calls.map((c) => ({ type: "tool_result" as const, tool_use_id: c.id, is_error: true, content: "Your output hit max_tokens and this tool input was cut off. Retry with a smaller edit." })),
          });
          continue;
        }

        const results = await Promise.all(
          calls.map(async (c): Promise<Anthropic.Beta.BetaToolResultBlockParam> => {
            const problem = validate(c.name, c.input);
            emit({ type: "tool_start", id: c.id, name: c.name, input: c.input });
            const r = problem ? { content: `INVALID_INPUT: ${problem}`, isError: true } : await this.runTool(c.name, c.input as Record<string, unknown>);
            emit({ type: "tool_end", id: c.id, ok: !r.isError, summary: r.content.slice(0, 300) });
            return { type: "tool_result", tool_use_id: c.id, content: r.content, ...(r.isError ? { is_error: true } : {}) };
          }),
        );
        // All results in one user message, so the history always pairs every tool_use with its result.
        this.messages.push({ role: "user", content: results });
        if (this.abort.signal.aborted) throw new Stopped();
      }
      emit({ type: "done", stopReason, usage });
    } catch (err) {
      if (err instanceof Stopped || this.abort?.signal.aborted) emit({ type: "done", stopReason: "stopped", usage });
      else if (err instanceof Anthropic.AuthenticationError || err instanceof Anthropic.PermissionDeniedError)
        emit({ type: "error", message: "The API key was rejected. Add a valid Anthropic API key in the assistant's settings.", auth: true });
      else if (err instanceof Anthropic.RateLimitError) emit({ type: "error", message: "Rate limited by the API. Wait a moment and try again." });
      else if (err instanceof Anthropic.APIError) emit({ type: "error", message: `API error ${err.status ?? ""}: ${err.message}` });
      else if (err instanceof Error && /credentials|apiKey|authToken/i.test(err.message))
        emit({ type: "error", message: "No Anthropic API key found. Add one in the assistant's settings, or set ANTHROPIC_API_KEY.", auth: true });
      else emit({ type: "error", message: err instanceof Error ? err.message : String(err) });
    } finally {
      this.running = false;
      this.abort = null;
    }
  }
}

function describeContext(ctx: AgentContext): string | null {
  const parts: string[] = [];
  if (ctx.activeFile) parts.push(`The user is viewing ${ctx.activeFile}.`);
  if (ctx.selection?.text.trim()) {
    parts.push(`Selected text (${ctx.activeFile}:${ctx.selection.startLine}-${ctx.selection.endLine}):\n\`\`\`\n${ctx.selection.text}\n\`\`\``);
  }
  return parts.length ? `<editor_context>\n${parts.join("\n")}\n</editor_context>` : null;
}
