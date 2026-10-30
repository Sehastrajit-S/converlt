// Registers the Converlt MCP server with the coding agents the user runs in the editor:
// Claude Code (~/.claude.json, user scope) and Codex (~/.codex/config.toml). Each edit is the
// smallest change that adds or updates the "converlt" entry, and the original is backed up first.
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AgentsStatus } from "./api.ts";

export interface McpLaunch {
  /** A Node-compatible runtime (the editor's own executable, run as Node). */
  command: string;
  script: string;
}

const CLAUDE = () => path.join(os.homedir(), ".claude.json");
const CODEX = () => path.join(os.homedir(), ".codex", "config.toml");

async function read(file: string): Promise<string | null> {
  try {
    return await fs.readFile(file, "utf8");
  } catch {
    return null;
  }
}

async function backup(file: string, text: string | null): Promise<void> {
  if (text !== null) await fs.writeFile(`${file}.converlt-backup`, text);
}

export async function agentsStatus(launch: McpLaunch): Promise<AgentsStatus> {
  const claude = await read(CLAUDE());
  const codex = await read(CODEX());
  let claudeOn = false;
  try {
    const cfg = claude ? (JSON.parse(claude) as { mcpServers?: Record<string, { args?: string[] }> }) : null;
    claudeOn = !!cfg?.mcpServers?.converlt?.args?.includes(launch.script);
  } catch {
    // unreadable config: report as not connected
  }
  return {
    claudeCode: claudeOn,
    codex: !!codex && /^\[mcp_servers\.converlt\]/m.test(codex) && codex.includes(launch.script.replace(/\\/g, "/")),
  };
}

/** TOML literal string: no escapes, so Windows paths stay intact. */
const lit = (s: string) => {
  const v = s.replace(/\\/g, "/");
  if (v.includes("'")) throw new Error(`Path can't contain a quote: ${s}`);
  return `'${v}'`;
};

export async function connectAgents(launch: McpLaunch, which: { claudeCode: boolean; codex: boolean }): Promise<AgentsStatus> {
  if (which.claudeCode) {
    const file = CLAUDE();
    const text = await read(file);
    let cfg: Record<string, unknown> = {};
    if (text?.trim()) {
      try {
        cfg = JSON.parse(text) as Record<string, unknown>;
      } catch {
        throw new Error(`${file} isn't valid JSON, so Converlt didn't touch it. Fix it or add the server with: claude mcp add --scope user converlt -e ELECTRON_RUN_AS_NODE=1 -- "${launch.command}" "${launch.script}"`);
      }
    }
    await backup(file, text);
    const servers = (cfg.mcpServers ?? {}) as Record<string, unknown>;
    servers.converlt = { type: "stdio", command: launch.command, args: [launch.script], env: { ELECTRON_RUN_AS_NODE: "1" } };
    cfg.mcpServers = servers;
    await fs.writeFile(file, JSON.stringify(cfg, null, 2) + "\n");
  }
  if (which.codex) {
    const file = CODEX();
    const text = (await read(file)) ?? "";
    await fs.mkdir(path.dirname(file), { recursive: true });
    await backup(file, text || null);
    const block = `[mcp_servers.converlt]\ncommand = ${lit(launch.command)}\nargs = [${lit(launch.script)}]\nenv = { ELECTRON_RUN_AS_NODE = "1" }\n`;
    // Replace an existing converlt table (up to the next table header), or append one.
    const re = /^\[mcp_servers\.converlt\]\n(?:(?!^\[)[^\n]*\n?)*/m;
    const next = re.test(text) ? text.replace(re, block) : `${text}${text && !text.endsWith("\n") ? "\n" : ""}${text ? "\n" : ""}${block}`;
    await fs.writeFile(file, next);
  }
  return agentsStatus(launch);
}
