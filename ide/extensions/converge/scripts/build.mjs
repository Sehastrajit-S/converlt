// Bundles the extension host (Node, CommonJS) and the webview UI (browser, IIFE),
// and stages the remote agent + SDK that get uploaded to GPU machines.
//   node scripts/build.mjs [--watch]
import { build, context } from "esbuild";
import { existsSync } from "node:fs";
import { cp, mkdir, readdir, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ext = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repo = path.resolve(ext, "../../..");
const dist = path.join(ext, "dist");
const watch = process.argv.includes("--watch");

// The gateway lives in the Converlt-server repo, checked out next to this one.
const server = path.resolve(process.env.CONVERLT_SERVER_DIR ?? path.join(repo, "../Converlt-server"));
const gatewayMain = path.join(server, "src/main.ts");
if (!existsSync(gatewayMain)) {
  console.error(`Converlt-server not found at ${server}. Clone it next to this repo and run pnpm install there, or set CONVERLT_SERVER_DIR.`);
  process.exit(1);
}

await rm(dist, { recursive: true, force: true });
await mkdir(path.join(dist, "remote/agent"), { recursive: true });
await mkdir(path.join(dist, "remote/sdk/converge"), { recursive: true });
await cp(path.join(repo, "services/remote-agent/converge_agent.py"), path.join(dist, "remote/agent/converge_agent.py"));
await cp(path.join(repo, "services/remote-agent/converge_data.py"), path.join(dist, "remote/agent/converge_data.py"));
await cp(path.join(repo, "services/remote-agent/converge_import.py"), path.join(dist, "remote/agent/converge_import.py"));
// The SDK package plus sitecustomize.py, which installs the zero-setup hooks for Converlt runs.
const sdkSrc = path.join(repo, "python/converge-runtime/converge");
for (const f of (await readdir(sdkSrc)).filter((f) => f.endsWith(".py"))) await cp(path.join(sdkSrc, f), path.join(dist, "remote/sdk/converge", f));
await cp(path.join(repo, "python/converge-runtime/sitecustomize.py"), path.join(dist, "remote/sdk/sitecustomize.py"));

const common = { bundle: true, sourcemap: true, logLevel: "info", minify: !watch };
const targets = [
  {
    ...common,
    // The Converlt MCP server: Claude Code / Codex start it to reach Converlt's tools.
    entryPoints: { "mcp/server": path.join(repo, "packages/core/src/mcpServer.ts") },
    outdir: dist,
    outExtension: { ".js": ".mjs" },
    platform: "node",
    format: "esm",
    target: "node22",
  },
  {
    ...common,
    // The Converlt Gateway, run on this computer in "use my own keys" mode.
    entryPoints: { "gateway/main": gatewayMain },
    outdir: dist,
    outExtension: { ".js": ".mjs" },
    platform: "node",
    format: "esm",
    target: "node22",
  },
  {
    ...common,
    entryPoints: { extension: path.join(ext, "src/extension.ts") },
    outdir: dist,
    platform: "node",
    format: "cjs",
    target: "node20",
    external: ["vscode"],
  },
  {
    ...common,
    entryPoints: { webview: path.join(ext, "src/webview/main.tsx") },
    outdir: dist,
    platform: "browser",
    format: "iife",
    target: "chrome120",
    jsx: "automatic",
    loader: { ".css": "css" },
    define: { "process.env.NODE_ENV": JSON.stringify(watch ? "development" : "production") },
  },
];

if (watch) {
  for (const t of targets) await (await context(t)).watch();
} else {
  await Promise.all(targets.map((t) => build(t)));
}
