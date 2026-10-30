// The Converlt assistant: the editor's default chat participant. It runs a tool loop on the model
// picked in the chat input (Converlt Cloud models by default). Reading tools are registered
// language-model tools, so the chat shows each call; edits go through the chat's native
// review (Keep / Undo per file); terminal commands go through the editor's own run_in_terminal
// tool with its confirmation.
import path from "node:path";
import * as vscode from "vscode";
import { AGENT_TOOLS, runAgentTool } from "@converge/core";
import type { Host } from "../host.ts";

const MAX_TURNS = 30;
const MAX_FILE_CHARS = 60_000;

const SYSTEM = `You are Converlt, the assistant built into the Converlt IDE for ML engineers. The user writes training code (usually PyTorch) and runs it on GPUs: their own machines over SSH or WSL, or on-demand cloud pods billed from Converlt credits. Converlt records every run (command, config, metrics, logs, GPU telemetry, diagnostics such as NaN loss, CUDA OOM and crashes).

Work like a careful senior ML engineer:
- Look before you answer: read the relevant files, and for questions about a run, look at the run (converlt_getRun) before explaining it.
- Make the smallest correct change, in the file's existing style. Use converlt_editFile with an exact, unique oldString copied from the current file; read the file first. Edits are shown to the user for review; they are not saved until the user keeps them.
- Use run_in_terminal only for quick, safe commands (inspecting the environment, running tests). Never start long training jobs in the terminal: tell the user to launch them with Run on GPU so Converlt records the run.
- Datasets and models the user downloaded through Converlt live on the GPU machines (converlt_listDownloads gives the exact paths); use those paths in training code instead of downloading again.
- Never spend the user's credits (launching pods) on your own. converlt_launchRun starts training only after the user approves it.
- Be concise. Refer to code as path:line.`;

interface PathInput {
  path: string;
}

function workspaceRoot(): vscode.Uri | null {
  return vscode.workspace.workspaceFolders?.[0]?.uri ?? null;
}

/** Resolves a model-supplied path inside the workspace; refuses anything outside it. */
function resolvePath(p: string): vscode.Uri {
  const root = workspaceRoot();
  if (!root) throw new Error("No folder is open.");
  const clean = p.replace(/\\/g, "/").replace(/^\.\//, "");
  const abs = path.resolve(root.fsPath, clean);
  const rel = path.relative(root.fsPath, abs);
  if (rel.startsWith("..") || path.isAbsolute(rel)) throw new Error(`${p} is outside the open folder`);
  return vscode.Uri.file(abs);
}

const relPath = (uri: vscode.Uri) => {
  const root = workspaceRoot();
  return root ? path.relative(root.fsPath, uri.fsPath).split(path.sep).join("/") : uri.fsPath;
};

const EXCLUDE = "{**/node_modules/**,**/.git/**,**/.converge/**,**/__pycache__/**,**/.venv/**,**/venv/**,**/wandb/**,**/*.pt,**/*.ckpt,**/*.safetensors}";

const text = (s: string) => new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(s)]);

/** Tools any agent in the editor can use: project files here, Converlt state from core. */
export function registerTools(host: Host, defaultMachineId: () => string | null): vscode.Disposable[] {
  const tool = <T>(name: string, invoke: (input: T, token: vscode.CancellationToken) => Promise<string>, message: (input: T) => string) =>
    vscode.lm.registerTool<T>(name, {
      prepareInvocation: (o) => ({ invocationMessage: message(o.input) }),
      invoke: async (o, token) => text(await invoke(o.input, token)),
    });

  // Runs, machines, downloads, wallet and launching: shared with Claude Code / Codex (MCP).
  const shared = AGENT_TOOLS.map((def) =>
    vscode.lm.registerTool<Record<string, unknown>>(def.name, {
      prepareInvocation: (o) =>
        def.needsApproval
          ? {
              invocationMessage: def.name === "converlt_launchRun" ? `Launching ${String(o.input.command ?? "")}` : `Stopping ${String(o.input.run ?? "")}`,
              confirmationMessages: {
                title: def.name === "converlt_launchRun" ? "Launch a training run?" : "Stop this run?",
                message: new vscode.MarkdownString(def.name === "converlt_launchRun" ? `\`${String(o.input.command ?? "")}\`${o.input.machine ? ` on **${String(o.input.machine)}**` : " on your default machine"}` : `Stop **${String(o.input.run ?? "")}**?`),
              },
            }
          : { invocationMessage: def.description.split(":")[0]!.split(".")[0]! },
      // VS Code already asked for confirmation above.
      invoke: async (o) => text(await runAgentTool(def.name, o.input, { service: host.service, approve: async () => true, client: "Converlt", defaultMachineId: defaultMachineId() })),
    }),
  );

  return [
    ...shared,
    tool<{ filter?: string }>(
      "converlt_listFiles",
      async ({ filter }) => {
        const files = await vscode.workspace.findFiles("**/*", EXCLUDE, 5000);
        const rels = files.map(relPath).filter((f) => !filter || f.toLowerCase().includes(filter.toLowerCase())).sort();
        return rels.length ? rels.join("\n") : "No files match.";
      },
      ({ filter }) => (filter ? `Listing files matching "${filter}"` : "Listing project files"),
    ),
    tool<PathInput & { startLine?: number; endLine?: number }>(
      "converlt_readFile",
      async ({ path: p, startLine, endLine }) => {
        const doc = await vscode.workspace.openTextDocument(resolvePath(p));
        const lines = doc.getText().split(/\r?\n/);
        const start = Math.max(1, startLine ?? 1);
        const end = Math.min(lines.length, endLine ?? start + 1500);
        const body = lines.slice(start - 1, end).map((l, i) => `${String(start + i).padStart(5)}  ${l}`).join("\n");
        return `${p} (${lines.length} lines)\n${body.slice(0, MAX_FILE_CHARS)}${end < lines.length ? `\n… lines ${end + 1}-${lines.length} not shown` : ""}`;
      },
      ({ path: p }) => `Reading ${p}`,
    ),
    tool<{ query: string; isRegex?: boolean }>(
      "converlt_searchText",
      async ({ query, isRegex }, token) => {
        const re = new RegExp(isRegex ? query : query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
        const out: string[] = [];
        for (const uri of await vscode.workspace.findFiles("**/*.{py,ipynb,yaml,yml,json,toml,cfg,txt,md,sh,ts,js}", EXCLUDE, 3000)) {
          if (token.isCancellationRequested || out.length >= 300) break;
          let content: string;
          try {
            const bytes = await vscode.workspace.fs.readFile(uri);
            if (bytes.byteLength > 1_000_000) continue;
            content = new TextDecoder().decode(bytes);
          } catch {
            continue;
          }
          content.split(/\r?\n/).forEach((l, i) => {
            if (out.length < 300 && re.test(l)) out.push(`${relPath(uri)}:${i + 1}: ${l.trim().slice(0, 240)}`);
          });
        }
        return out.length ? out.join("\n") : "No matches.";
      },
      ({ query }) => `Searching for "${query}"`,
    ),
  ];
}

/** Tools the assistant handles itself, because they write into the chat response stream. */
const INTERNAL_TOOLS: vscode.LanguageModelChatTool[] = [
  {
    name: "converlt_editFile",
    description: "Replace one exact, unique occurrence of oldString with newString in a file. Read the file first. The user reviews the change before it is kept.",
    inputSchema: { type: "object", properties: { path: { type: "string" }, oldString: { type: "string" }, newString: { type: "string" } }, required: ["path", "oldString", "newString"] },
  },
  {
    name: "converlt_createFile",
    description: "Create a new file with the given content. Fails if it exists; use converlt_editFile for existing files.",
    inputSchema: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } }, required: ["path", "content"] },
  },
];

type Stream = vscode.ChatResponseStream;

async function applyEdit(stream: Stream, uri: vscode.Uri, range: vscode.Range, newText: string): Promise<void> {
  try {
    stream.textEdit(uri, vscode.TextEdit.replace(range, newText));
    return;
  } catch {
    // Outside Converlt the chat editing API isn't enabled: make a normal, undoable editor edit.
  }
  const edit = new vscode.WorkspaceEdit();
  edit.replace(uri, range, newText);
  await vscode.workspace.applyEdit(edit);
}

async function runInternal(name: string, input: Record<string, unknown>, stream: Stream, touched: Set<string>): Promise<string> {
  if (name === "converlt_editFile") {
    const uri = resolvePath(String(input.path));
    const doc = await vscode.workspace.openTextDocument(uri);
    const content = doc.getText();
    const oldString = String(input.oldString);
    const newString = String(input.newString);
    // Models write \n; match against the document with its own line endings.
    const eol = doc.eol === vscode.EndOfLine.CRLF ? "\r\n" : "\n";
    const needle = oldString.replace(/\r?\n/g, eol);
    const at = content.indexOf(needle);
    if (!needle || at === -1) throw new Error(`oldString was not found in ${input.path}. Read the file again.`);
    if (content.indexOf(needle, at + 1) !== -1) throw new Error(`oldString occurs more than once in ${input.path}; include more context.`);
    const range = new vscode.Range(doc.positionAt(at), doc.positionAt(at + needle.length));
    stream.progress(`Editing ${input.path}`);
    await applyEdit(stream, uri, range, newString.replace(/\r?\n/g, eol));
    touched.add(uri.toString());
    return `Edited ${input.path} at line ${range.start.line + 1}. Waiting for the user's review.`;
  }
  if (name === "converlt_createFile") {
    const uri = resolvePath(String(input.path));
    try {
      await vscode.workspace.fs.stat(uri);
      throw new Error(`${input.path} already exists; use converlt_editFile.`);
    } catch (e) {
      if (!(e instanceof vscode.FileSystemError)) throw e;
    }
    await vscode.workspace.fs.writeFile(uri, new Uint8Array());
    stream.progress(`Creating ${input.path}`);
    await applyEdit(stream, uri, new vscode.Range(0, 0, 0, 0), String(input.content));
    touched.add(uri.toString());
    return `Created ${input.path}. Waiting for the user's review.`;
  }
  throw new Error(`Unknown tool ${name}`);
}

async function referencesText(request: vscode.ChatRequest): Promise<string> {
  const parts: string[] = [];
  for (const ref of request.references) {
    const v = ref.value;
    try {
      if (v instanceof vscode.Uri) {
        const doc = await vscode.workspace.openTextDocument(v);
        parts.push(`<file path="${relPath(v)}">\n${doc.getText().slice(0, MAX_FILE_CHARS)}\n</file>`);
      } else if (v instanceof vscode.Location) {
        const doc = await vscode.workspace.openTextDocument(v.uri);
        parts.push(`<selection path="${relPath(v.uri)}" lines="${v.range.start.line + 1}-${v.range.end.line + 1}">\n${doc.getText(v.range)}\n</selection>`);
      } else if (typeof v === "string") {
        parts.push(v);
      }
    } catch {
      // unreadable reference: skip it
    }
  }
  const editor = vscode.window.activeTextEditor;
  if (editor && !request.references.length) parts.push(`The user is looking at ${relPath(editor.document.uri)}${editor.selection.isEmpty ? "" : ` (selected lines ${editor.selection.start.line + 1}-${editor.selection.end.line + 1})`}.`);
  return parts.join("\n\n");
}

function historyMessages(context: vscode.ChatContext): vscode.LanguageModelChatMessage[] {
  const out: vscode.LanguageModelChatMessage[] = [];
  for (const turn of context.history) {
    if (turn instanceof vscode.ChatRequestTurn) out.push(vscode.LanguageModelChatMessage.User(turn.prompt));
    else if (turn instanceof vscode.ChatResponseTurn) {
      const md = turn.response
        .map((p) => (p instanceof vscode.ChatResponseMarkdownPart ? p.value.value : ""))
        .join("")
        .trim();
      if (md) out.push(vscode.LanguageModelChatMessage.Assistant(md));
    }
  }
  return out;
}

export function registerAssistant(ctx: vscode.ExtensionContext, host: Host, defaultMachineId: () => string | null = () => null): void {
  const handler: vscode.ChatRequestHandler = async (request, context, stream, token) => {
    const model = request.model;
    const tools: vscode.LanguageModelChatTool[] = [
      ...vscode.lm.tools.filter((t) => t.name.startsWith("converlt_") || t.name === "run_in_terminal").map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })),
      ...INTERNAL_TOOLS,
    ];
    const refs = await referencesText(request);
    const messages: vscode.LanguageModelChatMessage[] = [
      vscode.LanguageModelChatMessage.User(`<instructions>\n${SYSTEM}\n</instructions>\nProject: ${workspaceRoot() ? path.basename(workspaceRoot()!.fsPath) : "no folder open"}.`),
      ...historyMessages(context),
      vscode.LanguageModelChatMessage.User(refs ? `${refs}\n\n${request.prompt}` : request.prompt),
    ];
    const touched = new Set<string>();

    for (let turn = 0; turn < MAX_TURNS && !token.isCancellationRequested; turn++) {
      const response = await model.sendRequest(messages, { tools, justification: "Converlt assistant" }, token);
      const calls: vscode.LanguageModelToolCallPart[] = [];
      let said = "";
      for await (const part of response.stream) {
        if (part instanceof vscode.LanguageModelTextPart) {
          said += part.value;
          stream.markdown(part.value);
        } else if (part instanceof vscode.LanguageModelToolCallPart) calls.push(part);
      }
      if (!calls.length) break;
      messages.push(vscode.LanguageModelChatMessage.Assistant([...(said ? [new vscode.LanguageModelTextPart(said)] : []), ...calls]));
      const results: vscode.LanguageModelToolResultPart[] = [];
      for (const call of calls) {
        let content: (vscode.LanguageModelTextPart | unknown)[];
        try {
          if (INTERNAL_TOOLS.some((t) => t.name === call.name)) {
            content = [new vscode.LanguageModelTextPart(await runInternal(call.name, call.input as Record<string, unknown>, stream, touched))];
          } else {
            const r = await vscode.lm.invokeTool(call.name, { input: call.input, toolInvocationToken: request.toolInvocationToken }, token);
            content = r.content;
          }
        } catch (e) {
          content = [new vscode.LanguageModelTextPart(`Error: ${e instanceof Error ? e.message : String(e)}`)];
        }
        results.push(new vscode.LanguageModelToolResultPart(call.callId, content));
      }
      messages.push(vscode.LanguageModelChatMessage.User(results));
    }
    for (const uri of touched) {
      try {
        stream.textEdit(vscode.Uri.parse(uri), true);
      } catch {
        // chat editing API unavailable; edits were applied directly
      }
    }
    return {};
  };

  const participant = vscode.chat.createChatParticipant("converlt.assistant", handler);
  participant.iconPath = vscode.Uri.joinPath(ctx.extensionUri, "media", "converge.svg");
  ctx.subscriptions.push(participant, ...registerTools(host, defaultMachineId));
}
