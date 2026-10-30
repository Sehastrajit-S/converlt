// Agent bridge: each editor window serves Converlt's agent tools on 127.0.0.1, behind a random
// token, so the Converlt MCP server (started by Claude Code or Codex) can reach the window that
// has the agent's project open. Discovery files live in ~/.converlt/bridges (only the user can
// read them on a normal install).
import { randomBytes, timingSafeEqual } from "node:crypto";
import { promises as fs, rmSync } from "node:fs";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { AGENT_TOOLS, runAgentTool, type ApproveFn } from "./agentTools.ts";
import type { ConvergeService } from "./service.ts";

export const BRIDGE_DIR = path.join(os.homedir(), ".converlt", "bridges");

export interface BridgeFile {
  port: number;
  token: string;
  pid: number;
}

export interface BridgeOptions {
  service: ConvergeService;
  approve: ApproveFn;
  defaultMachineId: () => string | null;
}

async function body(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > 1_000_000) throw new Error("too large");
    chunks.push(c as Buffer);
  }
  return chunks.length ? (JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>) : {};
}

/** Starts the bridge; returns a disposer that stops it and removes its discovery file. */
export async function startBridge(opts: BridgeOptions): Promise<() => void> {
  const token = randomBytes(24).toString("base64url");
  const expected = Buffer.from(`Bearer ${token}`);
  const server = createServer((req, res) => {
    const send = (status: number, v: unknown) => {
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(v));
    };
    const auth = Buffer.from(req.headers.authorization ?? "");
    if (auth.length !== expected.length || !timingSafeEqual(auth, expected)) return send(401, { error: "unauthorized" });
    // Browsers can't reach this (no CORS, token required), but refuse anything that isn't a plain local call.
    if (req.headers.origin) return send(403, { error: "forbidden" });
    void (async () => {
      if (req.method === "GET" && req.url === "/info") return send(200, { project: opts.service.project?.path ?? null, pid: process.pid });
      if (req.method === "GET" && req.url === "/tools") return send(200, AGENT_TOOLS);
      if (req.method === "POST" && req.url === "/call") {
        const b = await body(req);
        const client = typeof b.client === "string" && b.client ? b.client.slice(0, 40) : "An AI agent";
        try {
          const text = await runAgentTool(String(b.name), (b.arguments ?? {}) as Record<string, unknown>, { service: opts.service, approve: opts.approve, client, defaultMachineId: opts.defaultMachineId() });
          return send(200, { text });
        } catch (e) {
          return send(200, { text: e instanceof Error ? e.message : String(e), isError: true });
        }
      }
      send(404, { error: "not found" });
    })().catch((e) => send(500, { error: String(e) }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  await fs.mkdir(BRIDGE_DIR, { recursive: true });
  const file = path.join(BRIDGE_DIR, `${process.pid}-${port}.json`);
  await fs.writeFile(file, JSON.stringify({ port, token, pid: process.pid } satisfies BridgeFile), { mode: 0o600 });
  return () => {
    server.close();
    rmSync(file, { force: true });
  };
}
