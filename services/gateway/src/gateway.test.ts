// End-to-end tests of the gateway against fake RunPod and OpenRouter servers that follow the
// documented API shapes. No real provider is called and no money is spent. The suite runs on
// both storage backends: SQLite, and Postgres (PGlite, an in-process Postgres).
import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, describe, it } from "node:test";
import { loadConfig } from "./config.ts";
import { PGlite } from "@electric-sql/pglite";
import { postgresDriver, sqliteDriver, Store, type SqlDriver } from "./db.ts";
import { OpenRouter } from "./openrouter.ts";
import { Runpod } from "./runpod.ts";
import { createGateway } from "./server.ts";

type Handler = (req: IncomingMessage, body: string) => { status?: number; json?: unknown; sse?: string[] };

function fake(handler: Handler): Promise<{ server: Server; url: string }> {
  return new Promise((resolve) => {
    const server = createServer(async (req, res) => {
      let body = "";
      for await (const c of req) body += c;
      const r = handler(req, body);
      if (r.sse) {
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        for (const line of r.sse) res.write(line);
        res.end();
        return;
      }
      res.writeHead(r.status ?? 200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(r.json ?? {}));
    });
    server.listen(0, "127.0.0.1", () => resolve({ server, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}` }));
  });
}

const ADMIN = "admin-secret";
const calls: string[] = [];
const pods = new Map<string, { desiredStatus: string; publicIp: string | null; portMappings: Record<string, number> }>();
let podSeq = 0;
let servers: Server[] = [];
let cfg: ReturnType<typeof loadConfig>;

async function pglite(): Promise<SqlDriver> {
  const db = new PGlite();
  return postgresDriver({
    query: async (text, params) => (await db.query<Record<string, unknown>>(text, params)).rows,
    transaction: async (statements) => {
      await db.transaction(async (tx) => {
        for (const s of statements) await tx.query(s.sql, s.params);
      });
    },
  });
}

before(async () => {
  const runpod = await fake((req, body) => {
    calls.push(`${req.method} ${req.url}`);
    if (req.url?.startsWith("/graphql")) {
      assert.match(req.url, /api_key=rp-key/);
      return {
        json: {
          data: {
            gpuTypes: [
              { id: "NVIDIA RTX 4090", displayName: "RTX 4090", memoryInGb: 24, secureCloud: true, communityCloud: true, secure: { uninterruptablePrice: 0.69, stockStatus: "High" }, community: { uninterruptablePrice: 0.34, stockStatus: "Medium" } },
              { id: "NVIDIA H100 80GB HBM3", displayName: "H100 SXM", memoryInGb: 80, secureCloud: true, communityCloud: false, secure: { uninterruptablePrice: 2.69, stockStatus: "Low" }, community: null },
            ],
          },
        },
      };
    }
    assert.equal(req.headers.authorization, "Bearer rp-key");
    if (req.method === "POST" && req.url === "/v1/pods") {
      const b = JSON.parse(body);
      assert.deepEqual(b.ports, ["22/tcp"]);
      assert.match(b.env.PUBLIC_KEY, /^ssh-ed25519 /);
      const id = `rp-${++podSeq}`;
      pods.set(id, { desiredStatus: "RUNNING", publicIp: null, portMappings: {} });
      return { status: 201, json: { id, name: b.name, desiredStatus: "RUNNING", publicIp: null, portMappings: {}, costPerHr: 0.69 * b.gpuCount } };
    }
    const m = /^\/v1\/pods\/([\w-]+)(\/stop|\/start)?$/.exec(req.url ?? "");
    const pod = m ? pods.get(m[1]!) : undefined;
    if (!m || !pod) return { status: 404, json: { error: "not found" } };
    if (req.method === "GET") return { json: { id: m[1], ...pod } };
    if (m[2] === "/stop") pod.desiredStatus = "EXITED";
    if (m[2] === "/start") pod.desiredStatus = "RUNNING";
    if (req.method === "DELETE") pods.delete(m[1]!);
    return { json: {} };
  });
  const openrouter = await fake((req, body) => {
    if (req.url === "/api/v1/models")
      return { json: { data: [{ id: "anthropic/claude-opus-5.5", name: "Claude Opus 5.5", context_length: 1000000, pricing: { prompt: "0.000004", completion: "0.00002" }, architecture: { modality: "text->text" } }] } };
    if (req.url === "/api/v1/chat/completions") {
      assert.equal(req.headers.authorization, "Bearer or-key");
      const b = JSON.parse(body);
      const usage = { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150, cost: 0.002 };
      if (b.stream)
        return {
          sse: [
            `data: ${JSON.stringify({ id: "gen-2", model: b.model, choices: [{ delta: { content: "Hel" } }] })}\n\n`,
            ": OPENROUTER PROCESSING\n\n",
            `data: ${JSON.stringify({ id: "gen-2", model: b.model, choices: [{ delta: { content: "lo" } }] })}\n\n`,
            `data: ${JSON.stringify({ id: "gen-2", model: b.model, choices: [], usage })}\n\n`,
            "data: [DONE]\n\n",
          ],
        };
      return { json: { id: "gen-1", model: b.model, choices: [{ message: { role: "assistant", content: "Hello" } }], usage } };
    }
    return { status: 404 };
  });
  cfg = {
    ...loadConfig({}),
    adminToken: ADMIN,
    runpodApiKey: "rp-key",
    openrouterApiKey: "or-key",
    runpodRestUrl: `${runpod.url}/v1`,
    runpodGraphqlUrl: `${runpod.url}/graphql`,
    openrouterUrl: `${openrouter.url}/api/v1`,
    cronSecret: "cron-secret",
  };
  servers = [runpod.server, openrouter.server];
});

after(() => {
  for (const s of servers) s.close();
});

const KEY = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIGtestkeytestkeytestkeytestkeytestkeytest converlt";

const BACKENDS: [string, () => Promise<SqlDriver>][] = [
  ["SQLite", () => sqliteDriver(":memory:")],
  ["Postgres", pglite],
];

for (const [backend, driver] of BACKENDS) {
  describe(`gateway on ${backend}`, () => {
    let base = "";
    let store: Store;
    let billing: ReturnType<typeof createGateway>["billing"];

    before(async () => {
      store = await Store.open(await driver());
      const gw = createGateway({ cfg, store, runpod: new Runpod(cfg.runpodApiKey, cfg.runpodRestUrl, cfg.runpodGraphqlUrl), openrouter: new OpenRouter(cfg.openrouterApiKey, cfg.openrouterUrl, "test") });
      billing = gw.billing;
      await new Promise<void>((r) => gw.server.listen(0, "127.0.0.1", r));
      base = `http://127.0.0.1:${(gw.server.address() as AddressInfo).port}`;
      servers.push(gw.server);
    });

    async function call(method: string, path: string, token: string, body?: unknown) {
      const res = await fetch(base + path, { method, headers: { Authorization: `Bearer ${token}`, ...(body ? { "Content-Type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined });
      const text = await res.text();
      let json: any = null;
      try {
        json = JSON.parse(text);
      } catch {
        json = text;
      }
      return { status: res.status, json, text };
    }

    async function newUser(email: string, credits: number): Promise<string> {
      const r = await call("POST", "/admin/users", ADMIN, { email, credits });
      assert.equal(r.status, 201, r.text);
      return r.json.token;
    }


    it("rejects requests without a valid token, and admin routes without the admin token", async () => {
      assert.equal((await call("GET", "/v1/me", "")).status, 401);
      assert.equal((await call("GET", "/v1/me", "cvt_nope")).status, 401);
      assert.equal((await call("GET", "/admin/users", "wrong")).status, 401);
    });

    it("creates a user with welcome credits and reports the wallet", async () => {
      const token = await newUser("ada@example.com", 1000);
      const me = await call("GET", "/v1/me", token);
      assert.equal(me.status, 200);
      assert.equal(me.json.balance, 1000);
      assert.equal(me.json.creditsPerUsd, 100);
      assert.deepEqual(me.json.limits, { gpuMonthly: null, modelsMonthly: null });
    });

    it("prices GPU offers in credits with the margin, cheapest first", async () => {
      const token = await newUser("offers@example.com", 10);
      const r = await call("GET", "/v1/gpu/offers", token);
      assert.equal(r.status, 200);
      assert.deepEqual(
        r.json.map((o: any) => [o.name, o.cloud, o.pricePerHour]),
        [
          ["RTX 4090", "COMMUNITY", 37.4],
          ["RTX 4090", "SECURE", 75.9],
          ["H100 SXM", "SECURE", 295.9],
        ],
      );
    });

    it("refuses a launch the balance can't cover for the minimum hours", async () => {
      const token = await newUser("poor@example.com", 20);
      const r = await call("POST", "/v1/gpu/pods", token, { gpuTypeId: "NVIDIA RTX 4090", cloud: "SECURE", gpuCount: 1, name: "x", publicKey: KEY });
      assert.equal(r.status, 402);
      assert.match(r.json.error.message, /Not enough credits/);
    });

    it("launches a pod, picks up its SSH endpoint, meters it, and stops it when credits run out", async () => {
      const token = await newUser("grace@example.com", 200);
      const r = await call("POST", "/v1/gpu/pods", token, { gpuTypeId: "NVIDIA RTX 4090", cloud: "SECURE", gpuCount: 1, name: "train-1", volumeGb: 50, containerDiskGb: 40, publicKey: KEY });
      assert.equal(r.status, 201, r.text);
      assert.equal(r.json.status, "starting");
      assert.equal(r.json.ssh, null);
      const rate = r.json.pricePerHour;
      // GPU at the provider's $0.69/hr plus 90 GB of disk at $0.10/GB-month, ×1.1 margin, 100 credits/$.
      const expected = 0.69 * 1.1 * 100 + ((90 * 0.1) / 730) * 1.1 * 100;
      assert.ok(Math.abs(rate - expected) < 1e-4, `rate ${rate} vs ${expected}`);

      // The provider assigns an IP and maps port 22.
      const rp = [...pods.entries()].at(-1)!;
      rp[1].publicIp = "203.0.113.7";
      rp[1].portMappings = { "22": 41022 };
      const row = (await store.userPods((await store.userByEmail("grace@example.com"))!.id))[0]!;
      await billing.meter(row.last_billed_at + 3_600_000); // one hour later
      let pod = (await call("GET", `/v1/gpu/pods/${r.json.id}`, token)).json;
      assert.equal(pod.status, "running");
      assert.deepEqual(pod.ssh, { host: "203.0.113.7", port: 41022 });
      assert.ok(Math.abs(pod.spent - rate) < 0.01, `charged one hour: ${pod.spent}`);
      const ledger = (await call("GET", "/v1/ledger", token)).json;
      assert.equal(ledger[0].kind, "gpu");

      // Two more hours drain the remaining ~124 credits: the meter stops the pod.
      await billing.meter(row.last_billed_at + 3 * 3_600_000);
      pod = (await call("GET", `/v1/gpu/pods/${r.json.id}`, token)).json;
      assert.equal(pod.status, "stopped");
      assert.match(pod.statusReason, /Out of credits/);
      assert.equal(pod.ssh, null);
      assert.ok(calls.includes(`POST /v1/pods/${rp[0]}/stop`));
      const me = (await call("GET", "/v1/me", token)).json;
      assert.ok(me.balance < 0);
      // Starting again is refused while the balance is negative.
      assert.equal((await call("POST", `/v1/gpu/pods/${r.json.id}/start`, token)).status, 402);
    });

    it("lets only the owner stop or terminate a pod", async () => {
      const owner = await newUser("owner@example.com", 500);
      const other = await newUser("other@example.com", 500);
      const pod = (await call("POST", "/v1/gpu/pods", owner, { gpuTypeId: "NVIDIA RTX 4090", cloud: "COMMUNITY", gpuCount: 1, name: "mine", publicKey: KEY })).json;
      assert.equal((await call("POST", `/v1/gpu/pods/${pod.id}/stop`, other)).status, 404);
      assert.equal((await call("DELETE", `/v1/gpu/pods/${pod.id}`, other)).status, 404);
      assert.equal((await call("DELETE", `/v1/gpu/pods/${pod.id}`, owner)).status, 200);
      const list = (await call("GET", "/v1/gpu/pods", owner)).json;
      assert.equal(list.length, 0);
    });

    it("charges chat completions from usage.cost, streaming and not", async () => {
      const token = await newUser("chat@example.com", 50);
      const r = await call("POST", "/v1/chat/completions", token, { model: "anthropic/claude-opus-5.5", messages: [{ role: "user", content: "hi" }] });
      assert.equal(r.status, 200, r.text);
      assert.equal(r.json.choices[0].message.content, "Hello");
      let me = (await call("GET", "/v1/me", token)).json;
      assert.equal(me.balance, 50 - 0.002 * 1.05 * 100);

      const s = await call("POST", "/v1/chat/completions", token, { model: "anthropic/claude-opus-5.5", stream: true, messages: [{ role: "user", content: "hi" }] });
      assert.equal(s.status, 200);
      assert.match(s.text, /"content":"lo"/);
      assert.match(s.text, /\[DONE\]/);
      me = (await call("GET", "/v1/me", token)).json;
      assert.ok(Math.abs(me.balance - (50 - 2 * 0.21)) < 1e-6, `balance ${me.balance}`);
      assert.ok(Math.abs(me.spend.models.day - 0.42) < 1e-6);
    });

    it("enforces the user's monthly model limit", async () => {
      const token = await newUser("capped@example.com", 50);
      const lim = await call("PUT", "/v1/me/limits", token, { gpuMonthly: null, modelsMonthly: 0.3 });
      assert.equal(lim.status, 200);
      assert.equal(lim.json.limits.modelsMonthly, 0.3);
      const body = { model: "anthropic/claude-opus-5.5", messages: [{ role: "user", content: "hi" }] };
      assert.equal((await call("POST", "/v1/chat/completions", token, body)).status, 200);
      assert.equal((await call("POST", "/v1/chat/completions", token, body)).status, 200);
      const blocked = await call("POST", "/v1/chat/completions", token, body);
      assert.equal(blocked.status, 402);
      assert.match(blocked.json.error.message, /monthly model limit/);
    });

    it("serves the model catalog in an OpenAI-compatible shape with credit prices", async () => {
      const token = await newUser("models@example.com", 1);
      const r = await call("GET", "/v1/models", token);
      assert.equal(r.json.object, "list");
      const m = r.json.data[0];
      assert.equal(m.id, "anthropic/claude-opus-5.5");
      assert.equal(m.object, "model");
      assert.equal(m.inputPerMTok, 420); // $4/M × 1.05 × 100 credits
      assert.equal(m.outputPerMTok, 2100);
    });

    it("bills an interval once when two charges race, and runs the meter from the cron route", async () => {
      const token = await newUser("race@example.com", 1000);
      const pod = (await call("POST", "/v1/gpu/pods", token, { gpuTypeId: "NVIDIA RTX 4090", cloud: "SECURE", gpuCount: 1, name: "race", publicKey: KEY })).json;
      const row = (await store.pod(pod.id))!;
      const later = row.last_billed_at + 3_600_000;
      // Two instances charge the same hour from the same snapshot: only one may land.
      const entry = store.entry(row.user_id, "gpu", -1000, "GPU: race", row.id, later);
      await Promise.all([store.charge(row.id, row.last_billed_at, later, 1000, entry), store.charge(row.id, row.last_billed_at, later, 1000, entry)]);
      const charged = (await store.ledger(row.user_id, 10)).filter((e) => e.kind === "gpu");
      assert.equal(charged.length, 1);
      assert.equal((await store.pod(row.id))!.spent, 1000);

      assert.equal((await call("GET", "/cron/meter", "wrong")).status, 401);
      const cron = await call("GET", "/cron/meter", "cron-secret");
      assert.equal(cron.status, 200, cron.text);
      assert.equal(typeof cron.json.ms, "number");
      // The meter's own pass (at the real clock, before `later`) didn't bill the hour again.
      assert.equal((await store.ledger(row.user_id, 10)).filter((e) => e.kind === "gpu").length, 1);
    });
  });
}
