// Dev loop: Vite (renderer HMR) + esbuild watch (main/preload) + Electron, restarted on main changes.
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import electronPath from "electron";
import { buildMain } from "./build-main.mjs";

const app = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
process.chdir(app);

const server = await createServer({ configFile: path.join(app, "vite.config.mts") });
await server.listen();
const url = server.resolvedUrls.local[0];

let child = null;
let restarting = false;
let timer = null;

// VS Code terminals export ELECTRON_RUN_AS_NODE, which would start Electron as plain Node.
const { ELECTRON_RUN_AS_NODE: _ignored, ...baseEnv } = process.env;

function launch() {
  child = spawn(electronPath, ["."], { cwd: app, stdio: "inherit", env: { ...baseEnv, CONVERGE_DEV_URL: url } });
  child.on("exit", () => {
    if (restarting) return;
    void server.close();
    process.exit(0);
  });
}

await buildMain({
  onRebuild() {
    clearTimeout(timer);
    timer = setTimeout(() => {
      if (!child) return launch();
      restarting = true;
      child.once("exit", () => {
        restarting = false;
        launch();
      });
      child.kill();
    }, 150);
  },
});
