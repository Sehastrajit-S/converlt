// Builds and launches the app (production build, no dev server).
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import electronPath from "electron";

const app = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
await import("./build.mjs");
// VS Code terminals export ELECTRON_RUN_AS_NODE, which would start Electron as plain Node.
const { ELECTRON_RUN_AS_NODE: _ignored, ...env } = process.env;
const child = spawn(electronPath, ["."], { cwd: app, stdio: "inherit", env });
child.on("exit", (code) => process.exit(code ?? 0));
