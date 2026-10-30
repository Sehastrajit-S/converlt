// HTTP API. Users authenticate with their Converlt token; /admin uses CONVERLT_ADMIN_TOKEN.
// /v1/chat/completions and /v1/models are OpenAI-compatible, so any OpenAI SDK pointed at
// <gateway>/v1 with a Converlt token as the API key spends credits on OpenRouter models.
import { timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { LaunchPodRequest, SpendLimits } from "@converge/core/cloud";
import { Billing, BillingError } from "./billing.ts";
import type { Config } from "./config.ts";
import { toMicro, type Store, type UserRow } from "./db.ts";
import type { OpenRouter } from "./openrouter.ts";
import { RunpodError, type Runpod } from "./runpod.ts";

const MAX_BODY = 20 * 1024 * 1024;

class HttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

function send(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
  res.end(text);
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > MAX_BODY) throw new HttpError(413, "Request body too large");
    chunks.push(c as Buffer);
  }
  if (!size) return {};
  try {
    const v = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error();
    return v;
  } catch {
    throw new HttpError(400, "Body must be a JSON object");
  }
}

const bearer = (req: IncomingMessage) => /^Bearer\s+(.+)$/i.exec(req.headers.authorization ?? "")?.[1]?.trim() ?? "";

function sameSecret(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

const capOrNull = (v: unknown, field: string): number | null => {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) throw new HttpError(400, `${field} must be a non-negative number or null`);
  return n;
};

export interface GatewayDeps {
  cfg: Config;
  store: Store;
  runpod: Runpod;
  openrouter: OpenRouter;
}

export function createGateway(deps: GatewayDeps): { server: Server; billing: Billing } {
  const { cfg, store, openrouter } = deps;
  const billing = new Billing(cfg, store, deps.runpod, openrouter);

  const authUser = (req: IncomingMessage): UserRow => {
    const user = store.userByToken(bearer(req));
    if (!user) throw new HttpError(401, "Invalid or missing Converlt token");
    return user;
  };
  const authAdmin = (req: IncomingMessage) => {
    if (!cfg.adminToken || !sameSecret(bearer(req), cfg.adminToken)) throw new HttpError(401, "Admin token required");
  };

  async function chat(req: IncomingMessage, res: ServerResponse, user: UserRow) {
    billing.assertCanUseModels(user);
    const body = await readJson(req);
    const model = typeof body.model === "string" ? body.model : "";
    if (!model) throw new HttpError(400, "model is required");
    const abort = new AbortController();
    res.on("close", () => abort.abort());
    const upstream = await openrouter.chat(body, abort.signal);
    const type = upstream.headers.get("content-type") ?? "application/json";
    if (!upstream.ok || !type.includes("text/event-stream")) {
      const text = await upstream.text();
      let charged: number | null = null;
      if (upstream.ok) {
        try {
          const j = JSON.parse(text);
          charged = await billing.chargeCompletion(user, String(j.model ?? model), j.usage, j.id ?? null);
        } catch (e) {
          console.error("chat: could not meter response:", e);
        }
      }
      res.writeHead(upstream.status, { "Content-Type": type, ...(charged !== null ? { "X-Converlt-Credits-Charged": String(charged) } : {}) });
      res.end(text);
      return;
    }
    // Stream through unchanged; the last chunk carrying `usage` is what gets charged.
    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-store", Connection: "keep-alive" });
    let usage: unknown = null;
    let genId: string | null = null;
    let servedModel = model;
    let buf = "";
    const decoder = new TextDecoder();
    try {
      for await (const chunk of upstream.body as unknown as AsyncIterable<Uint8Array>) {
        res.write(chunk);
        buf += decoder.decode(chunk, { stream: true });
        let nl: number;
        while ((nl = buf.indexOf("\n")) !== -1) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (!line.startsWith("data:")) continue;
          const data = line.slice(5).trim();
          if (data === "[DONE]") continue;
          try {
            const j = JSON.parse(data);
            if (j.usage) usage = j.usage;
            if (j.id) genId = j.id;
            if (j.model) servedModel = j.model;
          } catch {
            // keep-alive comments and partial lines
          }
        }
      }
    } finally {
      res.end();
      if (usage) await billing.chargeCompletion(user, servedModel, usage, genId).catch((e) => console.error("chat: metering failed:", e));
    }
  }

  async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://gateway");
    const p = url.pathname.replace(/\/+$/, "") || "/";
    const m = req.method ?? "GET";

    if (p === "/health") return send(res, 200, { ok: true, gpu: deps.runpod.configured, models: openrouter.configured });

    // -------------------------------------------------------- admin
    if (p.startsWith("/admin/")) {
      authAdmin(req);
      if (p === "/admin/users" && m === "GET")
        return send(res, 200, store.listUsers().map((u) => ({ ...u, balance: store.balanceMicro(u.id) / 1e6 })));
      if (p === "/admin/users" && m === "POST") {
        const b = await readJson(req);
        const email = String(b.email ?? "").trim();
        if (!/^[^@\s]+@[^@\s]+$/.test(email)) throw new HttpError(400, "A valid email is required");
        if (store.userByEmail(email)) throw new HttpError(409, "A user with that email exists");
        const { user, token } = store.createUser(email, String(b.name ?? ""));
        const credits = Number(b.credits ?? 0);
        if (credits > 0) store.addEntry(user.id, "grant", toMicro(credits), String(b.note ?? "Welcome credits"));
        return send(res, 201, { user, token });
      }
      if (p === "/admin/credits" && m === "POST") {
        const b = await readJson(req);
        const user = store.userByEmail(String(b.email ?? ""));
        if (!user) throw new HttpError(404, "No such user");
        const credits = Number(b.credits);
        if (!Number.isFinite(credits) || credits === 0) throw new HttpError(400, "credits must be a non-zero number");
        store.addEntry(user.id, credits > 0 ? "grant" : "adjust", toMicro(credits), String(b.note ?? (credits > 0 ? "Credits added" : "Adjustment")));
        return send(res, 200, { balance: store.balanceMicro(user.id) / 1e6 });
      }
      if (p === "/admin/rotate-token" && m === "POST") {
        const b = await readJson(req);
        const user = store.userByEmail(String(b.email ?? ""));
        if (!user) throw new HttpError(404, "No such user");
        return send(res, 200, { token: store.rotateToken(user.id) });
      }
      throw new HttpError(404, "Not found");
    }

    // -------------------------------------------------------- user
    if (!p.startsWith("/v1/")) throw new HttpError(404, "Not found");
    const user = authUser(req);

    if (p === "/v1/me" && m === "GET") return send(res, 200, billing.wallet(user));
    if (p === "/v1/me/limits" && m === "PUT") {
      const b = await readJson(req);
      const limits: SpendLimits = { gpuMonthly: capOrNull(b.gpuMonthly, "gpuMonthly"), modelsMonthly: capOrNull(b.modelsMonthly, "modelsMonthly") };
      store.setLimits(user.id, limits);
      return send(res, 200, billing.wallet({ ...user, gpu_monthly_cap: limits.gpuMonthly === null ? null : toMicro(limits.gpuMonthly), models_monthly_cap: limits.modelsMonthly === null ? null : toMicro(limits.modelsMonthly) }));
    }
    if (p === "/v1/ledger" && m === "GET") return send(res, 200, store.ledger(user.id, Math.max(1, Math.min(500, Number(url.searchParams.get("limit") ?? 100) || 100))));

    if (p === "/v1/gpu/offers" && m === "GET") return send(res, 200, await billing.offers());
    if (p === "/v1/gpu/pods" && m === "GET") return send(res, 200, store.userPods(user.id).map((x) => billing.view(x)));
    if (p === "/v1/gpu/pods" && m === "POST") return send(res, 201, await billing.launch(user, (await readJson(req)) as unknown as LaunchPodRequest));
    const podMatch = /^\/v1\/gpu\/pods\/([\w-]+)(\/stop|\/start)?$/.exec(p);
    if (podMatch) {
      const [, id, action] = podMatch;
      if (m === "GET" && !action) return send(res, 200, billing.view(billing.ownedPod(user, id!)));
      if (m === "POST" && action === "/stop") return send(res, 200, await billing.stop(user, id!));
      if (m === "POST" && action === "/start") return send(res, 200, await billing.start(user, id!));
      if (m === "DELETE" && !action) {
        await billing.terminate(user, id!);
        return send(res, 200, { ok: true });
      }
    }

    if (p === "/v1/models" && m === "GET") {
      const models = await billing.models();
      // OpenAI-compatible shape, with Converlt credit prices alongside.
      return send(res, 200, { object: "list", data: models.map((x) => ({ object: "model", owned_by: x.id.split("/")[0], ...x })) });
    }
    if (p === "/v1/chat/completions" && m === "POST") return chat(req, res, user);

    throw new HttpError(404, "Not found");
  }

  const server = createServer((req, res) => {
    route(req, res).catch((e: unknown) => {
      const status = e instanceof HttpError || e instanceof BillingError ? e.status : e instanceof RunpodError ? (e.status >= 500 || e.status === 503 ? 502 : 400) : 500;
      if (status === 500) console.error(e);
      const message = e instanceof Error ? e.message : String(e);
      if (res.headersSent) res.end();
      else send(res, status, { error: { message } });
    });
  });
  return { server, billing };
}
