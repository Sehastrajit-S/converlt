// Bundles the Electron main + preload processes and copies the remote agent/SDK
// that get uploaded to GPU machines.
import { build, context } from "esbuild";
import { cp, mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const app = path.resolve(here, "..");
const repo = path.resolve(app, "../..");
const dist = path.join(app, "dist");

export async function copyRemote() {
  const remote = path.join(dist, "remote");
  await rm(remote, { recursive: true, force: true });
  await mkdir(path.join(remote, "agent"), { recursive: true });
  await mkdir(path.join(remote, "sdk", "converge"), { recursive: true });
  await cp(path.join(repo, "services/remote-agent/converge_agent.py"), path.join(remote, "agent/converge_agent.py"));
  await cp(path.join(repo, "python/converge-runtime/converge/__init__.py"), path.join(remote, "sdk/converge/__init__.py"));
}

const options = {
  entryPoints: {
    main: path.join(app, "src/main/main.ts"),
    preload: path.join(app, "src/preload/preload.ts"),
  },
  outdir: dist,
  outExtension: { ".js": ".cjs" },
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node22",
  // node-pty is a native addon: it loads its .node binary from its own package at runtime.
  external: ["electron", "node-pty"],
  sourcemap: true,
  logLevel: "info",
};

/** One-off build, or with `onRebuild` a watch build that calls it after each successful rebuild. */
export async function buildMain({ onRebuild } = {}) {
  await mkdir(dist, { recursive: true });
  await copyRemote();
  // The Converlt Gateway, run on this computer in "use my own keys" mode.
  await build({ entryPoints: { "mcp/server": path.join(repo, "packages/core/src/mcpServer.ts") }, outdir: dist, outExtension: { ".js": ".mjs" }, bundle: true, platform: "node", format: "esm", target: "node22", logLevel: "warning" });
  await build({ entryPoints: { "gateway/main": path.join(repo, "services/gateway/src/main.ts") }, outdir: dist, outExtension: { ".js": ".mjs" }, bundle: true, platform: "node", format: "esm", target: "node22", logLevel: "warning" });
  if (!onRebuild) return build(options);
  const plugin = {
    name: "on-rebuild",
    setup(b) {
      b.onEnd((result) => {
        if (!result.errors.length) onRebuild();
      });
    },
  };
  const ctx = await context({ ...options, plugins: [plugin] });
  await ctx.watch();
  return ctx;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  await buildMain();
}
