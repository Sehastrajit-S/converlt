// Builds the gateway for Vercel with the Build Output API: one Node function serving every route
// (streaming on), and a cron that runs the meter every minute.
//   node vercel/build.mjs   (Vercel runs it as the project's build command)
import { build } from "esbuild";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const out = path.join(root, ".vercel/output");
const fn = path.join(out, "functions/api.func");

await rm(out, { recursive: true, force: true });
await mkdir(fn, { recursive: true });
await build({
  entryPoints: [path.join(root, "vercel/handler.ts")],
  outfile: path.join(fn, "index.mjs"),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  // Only the local gateway uses SQLite; Vercel always has DATABASE_URL.
  external: ["node:sqlite"],
  logLevel: "info",
});
await writeFile(
  path.join(fn, ".vc-config.json"),
  JSON.stringify({ runtime: "nodejs22.x", handler: "index.mjs", launcherType: "Nodejs", shouldAddHelpers: false, supportsResponseStreaming: true, maxDuration: 300 }, null, 2),
);
await writeFile(
  path.join(out, "config.json"),
  JSON.stringify(
    {
      version: 3,
      routes: [{ src: "/(.*)", dest: "/api" }],
      crons: [{ path: "/cron/meter", schedule: "* * * * *" }],
    },
    null,
    2,
  ),
);
console.log(`Vercel output in ${path.relative(process.cwd(), out) || "."}`);
