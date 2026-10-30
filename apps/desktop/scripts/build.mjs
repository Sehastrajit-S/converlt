import path from "node:path";
import { fileURLToPath } from "node:url";
import { build as viteBuild } from "vite";
import { buildMain } from "./build-main.mjs";

const app = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
process.chdir(app);
await viteBuild({ configFile: path.join(app, "vite.config.mts"), logLevel: "warn" });
await buildMain();
