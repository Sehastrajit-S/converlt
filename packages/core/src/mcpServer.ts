// The Converlt MCP server (stdio). Claude Code, Codex or any MCP client starts it; it forwards
// tool calls to the Converlt window that has the client's project open (see bridge.ts).
//   ELECTRON_RUN_AS_NODE=1 Converlt.exe dist/mcp/server.mjs
import { promises as fs } from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline";
import { AGENT_TOOLS } from "./agentTools.ts";
import { BRIDGE_DIR, type BridgeFile } from "./bridge.ts";

type Rpc = { jsonrpc: "2.0"; id?: number | string | null; method?: string; params?: Record<string, unknown> };

function write(msg: unknown): void {
  process.stdout.write(JSON.stringify(msg) + "\n");
}
const reply = (id: Rpc["id"], result: unknown): void => write({ jsonrpc: "2.0", id, result });
const fail = (id: Rpc["id"], code: number, message: string): void => write({ jsonrpc: "2.0", id, error: { code, message } });

let clientName = "An AI agent";

async function bridges(): Promise<{ url: string; token: string; project: string | null }[]> {
  let names: string[] = [];
  try {
    names = await fs.readdir(BRIDGE_DIR);
  } catch {
    return [];
  }
  const out: { url: string; token: string; project: string | null }[] = [];
  for (const n of names.filter((x) => x.endsWith(".json"))) {
    try {
      const b = JSON.parse(await fs.readFile(path.join(BRIDGE_DIR, n), "utf8")) as BridgeFile;
      const url = `http://127.0.0.1:${b.port}`;
      const r = await fetch(`${url}/info`, { headers: { Authorization: `Bearer ${b.token}` }, signal: AbortSignal.timeout(1500) });
      if (!r.ok) continue;
      const info = (await r.json()) as { project: string | null };
      out.push({ url, token: b.token, project: info.project });
    } catch {
      // stale file from a closed window
      await fs.rm(path.join(BRIDGE_DIR, n), { force: true }).catch(() => {});
    }
  }
  return out;
}

const norm = (p: string) => path.resolve(p).toLowerCase();

/** The window whose project contains the agent's working directory, else any Converlt window. */
async function pickBridge() {
  const all = await bridges();
  const cwd = norm(process.cwd());
  return all.find((b) => b.project && (cwd === norm(b.project) || cwd.startsWith(norm(b.project) + path.sep))) ?? all.find((b) => b.project) ?? all[0] ?? null;
}

async function call(name: string, args: Record<string, unknown>): Promise<{ text: string; isError?: boolean }> {
  const b = await pickBridge();
  if (!b) return { text: "Converlt isn't running. Open your project in the Converlt IDE, then try again.", isError: true };
  const r = await fetch(`${b.url}/call`, {
    method: "POST",
    headers: { Authorization: `Bearer ${b.token}`, "Content-Type": "application/json" },
    // Long enough for the user to answer an approval prompt.
    body: JSON.stringify({ name, arguments: args, client: clientName }),
    signal: AbortSignal.timeout(15 * 60_000),
  });
  return (await r.json()) as { text: string; isError?: boolean };
}

async function handle(msg: Rpc): Promise<void> {
  const { id, method, params } = msg;
  if (method === "initialize") {
    const info = (params?.clientInfo ?? {}) as { name?: string };
    if (info.name) clientName = /claude/i.test(info.name) ? "Claude Code" : /codex/i.test(info.name) ? "Codex" : info.name;
    return reply(id, {
      protocolVersion: typeof params?.protocolVersion === "string" ? params.protocolVersion : "2025-06-18",
      capabilities: { tools: {} },
      serverInfo: { name: "converlt", version: "0.1.0" },
      instructions:
        "Converlt is the user's ML workspace: training runs with metrics and failure diagnostics, GPU machines (SSH, WSL, cloud pods), and datasets/models downloaded onto them. Use these tools to inspect runs before explaining failures, to find dataset paths, and (with the user's approval) to launch runs on a GPU.",
    });
  }
  if (method === "ping") return reply(id, {});
  if (method === "tools/list") return reply(id, { tools: AGENT_TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) });
  if (method === "tools/call") {
    const name = String(params?.name ?? "");
    if (!AGENT_TOOLS.some((t) => t.name === name)) return fail(id, -32602, `Unknown tool ${name}`);
    try {
      const r = await call(name, (params?.arguments ?? {}) as Record<string, unknown>);
      return reply(id, { content: [{ type: "text", text: r.text }], isError: !!r.isError });
    } catch (e) {
      return reply(id, { content: [{ type: "text", text: `Converlt: ${e instanceof Error ? e.message : String(e)}` }], isError: true });
    }
  }
  if (id !== undefined && id !== null) fail(id, -32601, `Method not found: ${method}`);
  // notifications (initialized, cancelled…) need no answer
}

createInterface({ input: process.stdin }).on("line", (line) => {
  if (!line.trim()) return;
  let msg: Rpc;
  try {
    msg = JSON.parse(line) as Rpc;
  } catch {
    return fail(null, -32700, "Parse error");
  }
  void handle(msg);
});
