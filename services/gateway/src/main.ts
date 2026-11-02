// Starts the gateway and its metering loop.
//   RUNPOD_API_KEY=... OPENROUTER_API_KEY=... CONVERLT_ADMIN_TOKEN=... node src/main.ts
import { loadConfig } from "./config.ts";
import { openStore } from "./db.ts";
import { OpenRouter } from "./openrouter.ts";
import { Runpod } from "./runpod.ts";
import { createGateway } from "./server.ts";

const cfg = loadConfig();
const store = await openStore(cfg);
const runpod = new Runpod(cfg.runpodApiKey, cfg.runpodRestUrl, cfg.runpodGraphqlUrl);
const openrouter = new OpenRouter(cfg.openrouterApiKey, cfg.openrouterUrl, cfg.publicUrl);
const { server, billing } = createGateway({ cfg, store, runpod, openrouter });

let metering = false;
const meter = setInterval(() => {
  if (metering) return;
  metering = true;
  billing
    .meter()
    .catch((e) => console.error("meter:", e))
    .finally(() => (metering = false));
}, cfg.meterIntervalMs);

server.listen(cfg.port, () => {
  console.log(`Converlt Gateway on ${cfg.publicUrl} (data: ${cfg.databaseUrl ? "Postgres" : cfg.dataDir})`);
  if (!cfg.runpodApiKey) console.warn("  RUNPOD_API_KEY is not set: on-demand GPUs are disabled.");
  if (!cfg.openrouterApiKey) console.warn("  OPENROUTER_API_KEY is not set: chat completions are disabled (the model list still works).");
  if (!cfg.adminToken) console.warn("  CONVERLT_ADMIN_TOKEN is not set: /admin is disabled. Use `node src/admin.ts` to manage users.");
});

const shutdown = () => {
  clearInterval(meter);
  server.close(() => process.exit(0));
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
