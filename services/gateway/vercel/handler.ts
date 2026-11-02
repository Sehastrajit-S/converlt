// The Vercel function: every route of the gateway, one instance per warm container. The store
// and provider clients are created on the first request and reused while the instance lives.
import type { IncomingMessage, ServerResponse } from "node:http";
import { loadConfig } from "../src/config.ts";
import { openStore } from "../src/db.ts";
import { OpenRouter } from "../src/openrouter.ts";
import { Runpod } from "../src/runpod.ts";
import { createGateway, type Gateway } from "../src/server.ts";

let gateway: Promise<Gateway> | null = null;

function open(): Promise<Gateway> {
  const cfg = loadConfig();
  if (!cfg.databaseUrl) throw new Error("DATABASE_URL is not set: add a Postgres database (e.g. Neon) to the Vercel project.");
  return openStore(cfg).then((store) =>
    createGateway({
      cfg,
      store,
      runpod: new Runpod(cfg.runpodApiKey, cfg.runpodRestUrl, cfg.runpodGraphqlUrl),
      openrouter: new OpenRouter(cfg.openrouterApiKey, cfg.openrouterUrl, cfg.publicUrl),
    }),
  );
}

export default async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  try {
    (await (gateway ??= open())).handle(req, res);
  } catch (e) {
    gateway = null;
    console.error(e);
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: { message: "Gateway is not configured" } }));
  }
}
