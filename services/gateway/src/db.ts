// The ledger. Balances are never stored: a user's balance is the sum of their ledger entries,
// so every credit granted or spent has a row explaining it. Amounts are integer micro-credits.
//
// Two backends behind one async Store: SQLite (a file; the gateway Converlt runs on a user's own
// computer) and Postgres (hosted, e.g. Neon on Vercel). SQL is written once with `?` placeholders.
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import path from "node:path";
import type { CloudType, LedgerEntry, LedgerKind, PodStatus, SpendLimits } from "@converge/core/cloud";

export const MICRO = 1_000_000;
export const toMicro = (credits: number) => Math.round(credits * MICRO);
export const fromMicro = (micro: number) => micro / MICRO;

export interface UserRow {
  id: string;
  email: string;
  name: string;
  created_at: number;
  gpu_monthly_cap: number | null;
  models_monthly_cap: number | null;
}

export interface PodRow {
  id: string;
  user_id: string;
  provider_id: string;
  name: string;
  gpu_name: string;
  gpu_count: number;
  cloud: CloudType;
  image: string;
  volume_gb: number;
  container_disk_gb: number;
  /** Micro-credits per hour while running / while stopped. */
  rate_running: number;
  rate_stopped: number;
  status: PodStatus;
  status_reason: string | null;
  ssh_host: string | null;
  ssh_port: number | null;
  created_at: number;
  last_billed_at: number;
  spent: number;
}

// ------------------------------------------------------------ drivers

export interface Statement {
  sql: string;
  params: unknown[];
}

export interface SqlDriver {
  readonly dialect: "sqlite" | "postgres";
  all(sql: string, params?: unknown[]): Promise<Record<string, unknown>[]>;
  run(sql: string, params?: unknown[]): Promise<void>;
  /** Several writes as one transaction. */
  batch(statements: Statement[]): Promise<void>;
}

/** A SQLite file in `dataDir` (or ":memory:"). */
export async function sqliteDriver(dataDir: string): Promise<SqlDriver> {
  const { DatabaseSync } = await import("node:sqlite");
  const memory = dataDir === ":memory:";
  if (!memory) mkdirSync(dataDir, { recursive: true });
  const db = new DatabaseSync(memory ? ":memory:" : path.join(dataDir, "gateway.db"));
  db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
  const params = (p: unknown[]) => p as (string | number | null)[];
  return {
    dialect: "sqlite",
    all: async (sql, p = []) => db.prepare(sql).all(...params(p)) as Record<string, unknown>[],
    run: async (sql, p = []) => {
      db.prepare(sql).run(...params(p));
    },
    batch: async (statements) => {
      db.exec("BEGIN IMMEDIATE");
      try {
        for (const s of statements) db.prepare(s.sql).run(...params(s.params));
        db.exec("COMMIT");
      } catch (e) {
        db.exec("ROLLBACK");
        throw e;
      }
    },
  };
}

/** `?` placeholders to Postgres `$1, $2…` (the SQL here never contains a literal `?`). */
const toPg = (sql: string) => {
  let n = 0;
  return sql.replace(/\?/g, () => `$${++n}`);
};

/** Postgres through any `query(text, params)` + `transaction(statements)` pair (Neon, PGlite…). */
export function postgresDriver(q: { query(text: string, params: unknown[]): Promise<Record<string, unknown>[]>; transaction(statements: Statement[]): Promise<void> }): SqlDriver {
  return {
    dialect: "postgres",
    all: (sql, p = []) => q.query(toPg(sql), p),
    run: async (sql, p = []) => {
      await q.query(toPg(sql), p);
    },
    batch: (statements) => q.transaction(statements.map((s) => ({ sql: toPg(s.sql), params: s.params }))),
  };
}

/** Neon serverless Postgres over HTTP: one round trip per query, nothing to keep open. */
export async function neonDriver(url: string): Promise<SqlDriver> {
  const { neon } = await import("@neondatabase/serverless");
  const sql = neon(url);
  return postgresDriver({
    query: async (text, params) => (await sql.query(text, params)) as Record<string, unknown>[],
    transaction: async (statements) => {
      await sql.transaction((txn) => statements.map((s) => txn.query(s.sql, s.params)));
    },
  });
}

/** The store a config asks for: Postgres when DATABASE_URL is set, else SQLite in dataDir. */
export async function openStore(cfg: { databaseUrl: string; dataDir: string }): Promise<Store> {
  return Store.open(cfg.databaseUrl ? await neonDriver(cfg.databaseUrl) : await sqliteDriver(cfg.dataDir));
}

// ------------------------------------------------------------ schema

const SCHEMA = {
  sqlite: `
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, name TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE,
      created_at INTEGER NOT NULL, gpu_monthly_cap INTEGER, models_monthly_cap INTEGER);
    CREATE TABLE IF NOT EXISTS ledger (
      id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT NOT NULL REFERENCES users(id), ts INTEGER NOT NULL,
      kind TEXT NOT NULL, amount INTEGER NOT NULL, description TEXT NOT NULL, ref TEXT);
    CREATE INDEX IF NOT EXISTS ledger_user_ts ON ledger(user_id, ts);
    CREATE TABLE IF NOT EXISTS pods (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), provider_id TEXT NOT NULL, name TEXT NOT NULL,
      gpu_name TEXT NOT NULL, gpu_count INTEGER NOT NULL, cloud TEXT NOT NULL, image TEXT NOT NULL, volume_gb INTEGER NOT NULL,
      container_disk_gb INTEGER NOT NULL, rate_running INTEGER NOT NULL, rate_stopped INTEGER NOT NULL, status TEXT NOT NULL,
      status_reason TEXT, ssh_host TEXT, ssh_port INTEGER, created_at INTEGER NOT NULL, last_billed_at INTEGER NOT NULL,
      spent INTEGER NOT NULL DEFAULT 0, last_charge TEXT);
    CREATE INDEX IF NOT EXISTS pods_user ON pods(user_id);`,
  postgres: `
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, name TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE,
      created_at BIGINT NOT NULL, gpu_monthly_cap BIGINT, models_monthly_cap BIGINT);
    CREATE TABLE IF NOT EXISTS ledger (
      id BIGSERIAL PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), ts BIGINT NOT NULL,
      kind TEXT NOT NULL, amount BIGINT NOT NULL, description TEXT NOT NULL, ref TEXT);
    CREATE INDEX IF NOT EXISTS ledger_user_ts ON ledger(user_id, ts);
    CREATE TABLE IF NOT EXISTS pods (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), provider_id TEXT NOT NULL, name TEXT NOT NULL,
      gpu_name TEXT NOT NULL, gpu_count INTEGER NOT NULL, cloud TEXT NOT NULL, image TEXT NOT NULL, volume_gb INTEGER NOT NULL,
      container_disk_gb INTEGER NOT NULL, rate_running BIGINT NOT NULL, rate_stopped BIGINT NOT NULL, status TEXT NOT NULL,
      status_reason TEXT, ssh_host TEXT, ssh_port INTEGER, created_at BIGINT NOT NULL, last_billed_at BIGINT NOT NULL,
      spent BIGINT NOT NULL DEFAULT 0, last_charge TEXT);
    CREATE INDEX IF NOT EXISTS pods_user ON pods(user_id);`,
};

// Postgres returns BIGINT as strings; every numeric column comes back through these.
const n = (v: unknown) => Number(v);
const nn = (v: unknown) => (v === null || v === undefined ? null : Number(v));

const USER_COLS = "id, email, name, created_at, gpu_monthly_cap, models_monthly_cap";
const user = (r: Record<string, unknown>): UserRow => ({
  id: String(r.id),
  email: String(r.email),
  name: String(r.name),
  created_at: n(r.created_at),
  gpu_monthly_cap: nn(r.gpu_monthly_cap),
  models_monthly_cap: nn(r.models_monthly_cap),
});
const pod = (r: Record<string, unknown>): PodRow => ({
  id: String(r.id),
  user_id: String(r.user_id),
  provider_id: String(r.provider_id),
  name: String(r.name),
  gpu_name: String(r.gpu_name),
  gpu_count: n(r.gpu_count),
  cloud: r.cloud as CloudType,
  image: String(r.image),
  volume_gb: n(r.volume_gb),
  container_disk_gb: n(r.container_disk_gb),
  rate_running: n(r.rate_running),
  rate_stopped: n(r.rate_stopped),
  status: r.status as PodStatus,
  status_reason: (r.status_reason as string | null) ?? null,
  ssh_host: (r.ssh_host as string | null) ?? null,
  ssh_port: nn(r.ssh_port),
  created_at: n(r.created_at),
  last_billed_at: n(r.last_billed_at),
  spent: n(r.spent),
});

const hashToken = (t: string) => createHash("sha256").update(t).digest("hex");
const newToken = () => "cvt_" + randomBytes(32).toString("base64url");

// last_charge is internal to charge(); it isn't part of PodRow.
const POD_COLS = ["id", "user_id", "provider_id", "name", "gpu_name", "gpu_count", "cloud", "image", "volume_gb", "container_disk_gb", "rate_running", "rate_stopped", "status", "status_reason", "ssh_host", "ssh_port", "created_at", "last_billed_at", "spent"] as const;
type PodPatch = Partial<Pick<PodRow, "status" | "status_reason" | "ssh_host" | "ssh_port" | "last_billed_at" | "spent">>;

// ------------------------------------------------------------ store

export class Store {
  private readonly db: SqlDriver;

  private constructor(db: SqlDriver) {
    this.db = db;
  }

  /** Opens the store and creates the schema if needed. */
  static async open(db: SqlDriver): Promise<Store> {
    for (const stmt of SCHEMA[db.dialect].split(";").map((s) => s.trim()).filter(Boolean)) await db.run(stmt);
    // Databases from before the Postgres backend kept the token hash as raw bytes.
    if (db.dialect === "sqlite") {
      await db.run("UPDATE users SET token_hash = lower(hex(token_hash)) WHERE typeof(token_hash) = 'blob'");
      if (!(await db.all("PRAGMA table_info(pods)")).some((c) => c.name === "last_charge")) await db.run("ALTER TABLE pods ADD COLUMN last_charge TEXT");
    }
    return new Store(db);
  }

  // ------------------------------------------------------------ users

  /** Creates a user and returns their token. The token is shown once; only its hash is kept. */
  async createUser(email: string, name: string): Promise<{ user: UserRow; token: string }> {
    const token = newToken();
    const u: UserRow = { id: randomUUID(), email: email.trim().toLowerCase(), name: name.trim() || email, created_at: Date.now(), gpu_monthly_cap: null, models_monthly_cap: null };
    await this.db.run("INSERT INTO users (id, email, name, token_hash, created_at) VALUES (?, ?, ?, ?, ?)", [u.id, u.email, u.name, hashToken(token), u.created_at]);
    return { user: u, token };
  }

  /** Replaces a user's token (the old one stops working immediately). */
  async rotateToken(userId: string): Promise<string> {
    const token = newToken();
    await this.db.run("UPDATE users SET token_hash = ? WHERE id = ?", [hashToken(token), userId]);
    return token;
  }

  async userByToken(token: string): Promise<UserRow | null> {
    if (!token.startsWith("cvt_")) return null;
    const [r] = await this.db.all(`SELECT ${USER_COLS} FROM users WHERE token_hash = ?`, [hashToken(token)]);
    return r ? user(r) : null;
  }

  async userById(id: string): Promise<UserRow | null> {
    const [r] = await this.db.all(`SELECT ${USER_COLS} FROM users WHERE id = ?`, [id]);
    return r ? user(r) : null;
  }

  async userByEmail(email: string): Promise<UserRow | null> {
    const [r] = await this.db.all(`SELECT ${USER_COLS} FROM users WHERE email = ?`, [email.trim().toLowerCase()]);
    return r ? user(r) : null;
  }

  async listUsers(): Promise<UserRow[]> {
    return (await this.db.all(`SELECT ${USER_COLS} FROM users ORDER BY created_at`)).map(user);
  }

  async setLimits(userId: string, limits: SpendLimits): Promise<void> {
    const cap = (v: number | null) => (v === null ? null : toMicro(v));
    await this.db.run("UPDATE users SET gpu_monthly_cap = ?, models_monthly_cap = ? WHERE id = ?", [cap(limits.gpuMonthly), cap(limits.modelsMonthly), userId]);
  }

  limits(u: UserRow): SpendLimits {
    return {
      gpuMonthly: u.gpu_monthly_cap === null ? null : fromMicro(u.gpu_monthly_cap),
      modelsMonthly: u.models_monthly_cap === null ? null : fromMicro(u.models_monthly_cap),
    };
  }

  // ------------------------------------------------------------ ledger

  entry(userId: string, kind: LedgerKind, amountMicro: number, description: string, ref: string | null = null, ts = Date.now()): Statement {
    if (!Number.isSafeInteger(amountMicro)) throw new Error("Invalid amount");
    return { sql: "INSERT INTO ledger (user_id, ts, kind, amount, description, ref) VALUES (?, ?, ?, ?, ?, ?)", params: [userId, ts, kind, amountMicro, description, ref] };
  }

  async addEntry(userId: string, kind: LedgerKind, amountMicro: number, description: string, ref: string | null = null, ts = Date.now()): Promise<void> {
    const s = this.entry(userId, kind, amountMicro, description, ref, ts);
    await this.db.run(s.sql, s.params);
  }

  async balanceMicro(userId: string): Promise<number> {
    const [r] = await this.db.all("SELECT COALESCE(SUM(amount), 0) AS b FROM ledger WHERE user_id = ?", [userId]);
    return n(r?.b ?? 0);
  }

  /** Total spent (positive micro-credits) in the given kinds since `since`. */
  async spentSince(userId: string, kinds: LedgerKind[], since: number): Promise<number> {
    const marks = kinds.map(() => "?").join(",");
    const [r] = await this.db.all(`SELECT COALESCE(SUM(-amount), 0) AS s FROM ledger WHERE user_id = ? AND ts >= ? AND kind IN (${marks})`, [userId, since, ...kinds]);
    return n(r?.s ?? 0);
  }

  async ledger(userId: string, limit: number): Promise<LedgerEntry[]> {
    const rows = await this.db.all("SELECT id, ts, kind, amount, description, ref FROM ledger WHERE user_id = ? ORDER BY id DESC LIMIT ?", [userId, limit]);
    return rows.map((r) => ({ id: n(r.id), ts: n(r.ts), kind: r.kind as LedgerKind, amount: fromMicro(n(r.amount)), description: String(r.description), ref: (r.ref as string | null) ?? null }));
  }

  // ------------------------------------------------------------ pods

  async insertPod(p: PodRow): Promise<void> {
    await this.db.run(`INSERT INTO pods (${POD_COLS.join(", ")}) VALUES (${POD_COLS.map(() => "?").join(", ")})`, POD_COLS.map((c) => p[c]));
  }

  async updatePod(id: string, patch: PodPatch): Promise<void> {
    const keys = Object.keys(patch) as (keyof PodPatch)[];
    if (keys.length) await this.db.run(`UPDATE pods SET ${keys.map((k) => `${k} = ?`).join(", ")} WHERE id = ?`, [...keys.map((k) => patch[k] ?? null), id]);
  }

  /**
   * Bills a pod from `from` to `to` in one transaction: moves its last_billed_at and writes the
   * ledger entry, but only if last_billed_at is still `from`. A concurrent charge of the same
   * interval (another instance got there first) changes nothing: the entry is written only if
   * this charge's id is the one the update stamped on the pod.
   */
  async charge(podId: string, from: number, to: number, amountMicro: number, entry: Statement | null): Promise<void> {
    const chargeId = randomUUID();
    const statements: Statement[] = [{ sql: "UPDATE pods SET last_billed_at = ?, spent = spent + ?, last_charge = ? WHERE id = ? AND last_billed_at = ?", params: [to, amountMicro, chargeId, podId, from] }];
    if (entry) {
      // Postgres can't infer the types of bare parameters in a SELECT list; the casts are plain SQL in both.
      const [userId, ts, kind, amount, description, ref] = entry.params;
      statements.push({
        sql: `INSERT INTO ledger (user_id, ts, kind, amount, description, ref)
              SELECT CAST(? AS TEXT), CAST(? AS BIGINT), CAST(? AS TEXT), CAST(? AS BIGINT), CAST(? AS TEXT), CAST(? AS TEXT)
              WHERE EXISTS (SELECT 1 FROM pods WHERE id = ? AND last_charge = ?)`,
        params: [userId, ts, kind, amount, description, ref, podId, chargeId],
      });
    }
    await this.db.batch(statements);
  }

  async pod(id: string): Promise<PodRow | null> {
    const [r] = await this.db.all("SELECT * FROM pods WHERE id = ?", [id]);
    return r ? pod(r) : null;
  }

  async userPods(userId: string, includeTerminated = false): Promise<PodRow[]> {
    const sql = includeTerminated ? "SELECT * FROM pods WHERE user_id = ? ORDER BY created_at DESC" : "SELECT * FROM pods WHERE user_id = ? AND status != 'terminated' ORDER BY created_at DESC";
    return (await this.db.all(sql, [userId])).map(pod);
  }

  async livePods(): Promise<PodRow[]> {
    return (await this.db.all("SELECT * FROM pods WHERE status != 'terminated'")).map(pod);
  }
}
