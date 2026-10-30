// Contract for the built-in IDE (main <-> preload <-> renderer): files, search, terminal, git, agent.
// Desktop-only, so it lives beside ConvergeApi instead of inside it.

export const IDE = {
  invoke: "converge:ide",
  termData: "converge:term-data",
  termExit: "converge:term-exit",
  agentEvent: "converge:agent-event",
  agentTool: "converge:agent-tool",
} as const;

// ------------------------------------------------------------ files + search

export interface DirEntry {
  name: string;
  /** Project-relative, forward slashes. */
  path: string;
  dir: boolean;
}

export type FileContent = { binary: false; text: string } | { binary: true; size: number };

export interface SearchOptions {
  regex?: boolean;
  caseSensitive?: boolean;
  wholeWord?: boolean;
}

export interface SearchMatch {
  line: number;
  /** 1-based column of the match start. */
  col: number;
  length: number;
  text: string;
}

export interface SearchResult {
  files: { path: string; matches: SearchMatch[] }[];
  total: number;
  truncated: boolean;
}

// ------------------------------------------------------------ git

export type GitChangeKind = "modified" | "added" | "deleted" | "renamed" | "untracked" | "conflict";

export interface GitChange {
  path: string;
  kind: GitChangeKind;
  /** Index (staged) side vs working-tree side. */
  staged: boolean;
}

export interface GitStatus {
  repo: boolean;
  branch: string | null;
  ahead: number;
  behind: number;
  changes: GitChange[];
}

// ------------------------------------------------------------ agent

export const AGENT_MODELS = [
  { id: "claude-opus-5-5", label: "Claude Opus 5.5" },
  { id: "claude-sonnet-5-5", label: "Claude Sonnet 5.5" },
  { id: "claude-haiku-5-5", label: "Claude Haiku 5.5" },
  { id: "claude-fable-5-1", label: "Claude Fable 5.1" },
] as const;

export interface AgentConfig {
  /** A key is stored (encrypted with the OS keychain). The key itself never reaches the renderer. */
  hasKey: boolean;
  model: string;
}

export interface AgentContext {
  activeFile: string | null;
  selection: { text: string; startLine: number; endLine: number } | null;
}

export type AgentEvent =
  | { type: "turn_start"; turn: number }
  | { type: "text"; delta: string }
  | { type: "thinking"; delta: string }
  | { type: "tool_start"; id: string; name: string; input: unknown }
  | { type: "tool_end"; id: string; ok: boolean; summary: string }
  | { type: "fallback"; from: string; to: string }
  | { type: "done"; stopReason: string | null; usage: { input: number; output: number; cacheRead: number } }
  | { type: "error"; message: string; auth?: boolean };

/** A tool call the agent asks the renderer to run (it owns the editor buffers). */
export interface AgentToolRequest {
  callId: string;
  name: string;
  input: Record<string, unknown>;
}

export interface AgentToolResult {
  content: string;
  isError?: boolean;
}

// ------------------------------------------------------------ bridge

export interface IdeApi {
  fs: {
    list(rel: string): Promise<DirEntry[]>;
    files(): Promise<string[]>;
    read(rel: string): Promise<FileContent>;
    write(rel: string, text: string): Promise<void>;
    search(query: string, opts: SearchOptions): Promise<SearchResult>;
  };
  terminal: {
    create(cols: number, rows: number): Promise<{ id: number; shell: string }>;
    write(id: number, data: string): Promise<void>;
    resize(id: number, cols: number, rows: number): Promise<void>;
    kill(id: number): Promise<void>;
    onData(cb: (id: number, data: string) => void): () => void;
    onExit(cb: (id: number, code: number) => void): () => void;
  };
  git: {
    status(): Promise<GitStatus>;
    /** File content at HEAD, or null when the file is new. */
    headContent(rel: string): Promise<string | null>;
    stage(paths: string[]): Promise<void>;
    unstage(paths: string[]): Promise<void>;
    discard(paths: string[]): Promise<void>;
    commit(message: string): Promise<string>;
  };
  agent: {
    getConfig(): Promise<AgentConfig>;
    setConfig(patch: { apiKey?: string | null; model?: string }): Promise<AgentConfig>;
    send(text: string, context: AgentContext): Promise<void>;
    stop(): Promise<void>;
    reset(): Promise<void>;
    toolResult(callId: string, result: AgentToolResult): Promise<void>;
    onEvent(cb: (e: AgentEvent) => void): () => void;
    onToolRequest(cb: (req: AgentToolRequest) => void): () => void;
  };
}

/** Methods callable over the single IDE invoke channel, as "<group>.<method>". */
export const IDE_METHODS = [
  "fs.list",
  "fs.files",
  "fs.read",
  "fs.write",
  "fs.search",
  "terminal.create",
  "terminal.write",
  "terminal.resize",
  "terminal.kill",
  "git.status",
  "git.headContent",
  "git.stage",
  "git.unstage",
  "git.discard",
  "git.commit",
  "agent.getConfig",
  "agent.setConfig",
  "agent.send",
  "agent.stop",
  "agent.reset",
  "agent.toolResult",
] as const;
export type IdeMethod = (typeof IDE_METHODS)[number];
