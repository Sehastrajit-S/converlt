// The ledger. Balances are never stored: a user's balance is the sum of their ledger entries,
// so every credit granted or spent has a row explaining it. Amounts are integer micro-credits.
import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
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

const hashToken = (t: string) => createHash("sha256").update(t).digest();

export class Store {
  readonly db: DatabaseSync;

  constructor(dataDir: string) {
    const memory = dataDir === ":memory:";
    if (!memory) mkdirSync(dataDir, { recursive: true });
    this.db = new DatabaseSync(memory ? ":memory:" : path.join(dataDir, "gateway.db"));
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA foreign_keys = ON;
      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        email TEXT NOT NULL UNIQUE,
        name TEXT NOT NULL,
        token_hash BLOB NOT NULL UNIQUE,
        created_at INTEGER NOT NULL,
        gpu_monthly_cap INTEGER,
        models_monthly_cap INTEGER
      );
      CREATE TABLE IF NOT EXISTS ledger (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id TEXT NOT NULL REFERENCES users(id),
        ts INTEGER NOT NULL,
        kind TEXT NOT NULL,
        amount INTEGER NOT NULL,
        description TEXT NOT NULL,
        ref TEXT
      );
      CREATE INDEX IF NOT EXISTS ledger_user_ts ON ledger(user_id, ts);
      CREATE TABLE IF NOT EXISTS pods (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id),
        provider_id TEXT NOT NULL,
        name TEXT NOT NULL,
        gpu_name TEXT NOT NULL,
        gpu_count INTEGER NOT NULL,
        cloud TEXT NOT NULL,
        image TEXT NOT NULL,
        volume_gb INTEGER NOT NULL,
        container_disk_gb INTEGER NOT NULL,
        rate_running INTEGER NOT NULL,
        rate_stopped INTEGER NOT NULL,
        status TEXT NOT NULL,
        status_reason TEXT,
        ssh_host TEXT,
        ssh_port INTEGER,
        created_at INTEGER NOT NULL,
        last_billed_at INTEGER NOT NULL,
        spent INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS pods_user ON pods(user_id);
    `);
  }

  /** Runs fn in one write transaction, so a charge and its pod update land together. */
  tx<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const r = fn();
      this.db.exec("COMMIT");
      return r;
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }

  // ------------------------------------------------------------ users

  /** Creates a user and returns their token. The token is shown once; only its hash is kept. */
  createUser(email: string, name: string): { user: UserRow; token: string } {
    const token = "cvt_" + randomBytes(32).toString("base64url");
    const user: UserRow = { id: randomUUID(), email: email.trim().toLowerCase(), name: name.trim() || email, created_at: Date.now(), gpu_monthly_cap: null, models_monthly_cap: null };
    this.db.prepare("INSERT INTO users (id, email, name, token_hash, created_at) VALUES (?, ?, ?, ?, ?)").run(user.id, user.email, user.name, hashToken(token), user.created_at);
    return { user, token };
  }

  /** Replaces a user's token (the old one stops working immediately). */
  rotateToken(userId: string): string {
    const token = "cvt_" + randomBytes(32).toString("base64url");
    this.db.prepare("UPDATE users SET token_hash = ? WHERE id = ?").run(hashToken(token), userId);
    return token;
  }

  userByToken(token: string): UserRow | null {
    if (!token.startsWith("cvt_")) return null;
    const h = hashToken(token);
    const row = this.db.prepare("SELECT id, email, name, created_at, gpu_monthly_cap, models_monthly_cap, token_hash FROM users WHERE token_hash = ?").get(h) as
      | (UserRow & { token_hash: Uint8Array })
      | undefined;
    if (!row || !timingSafeEqual(Buffer.from(row.token_hash), h)) return null;
    const { token_hash: _h, ...user } = row;
    return user;
  }

  userByEmail(email: string): UserRow | null {
    return (this.db.prepare("SELECT id, email, name, created_at, gpu_monthly_cap, models_monthly_cap FROM users WHERE email = ?").get(email.trim().toLowerCase()) as UserRow | undefined) ?? null;
  }

  listUsers(): UserRow[] {
    return this.db.prepare("SELECT id, email, name, created_at, gpu_monthly_cap, models_monthly_cap FROM users ORDER BY created_at").all() as unknown as UserRow[];
  }

  setLimits(userId: string, limits: SpendLimits): void {
    const cap = (v: number | null) => (v === null ? null : toMicro(v));
    this.db.prepare("UPDATE users SET gpu_monthly_cap = ?, models_monthly_cap = ? WHERE id = ?").run(cap(limits.gpuMonthly), cap(limits.modelsMonthly), userId);
  }

  limits(user: UserRow): SpendLimits {
    return {
      gpuMonthly: user.gpu_monthly_cap === null ? null : fromMicro(user.gpu_monthly_cap),
      modelsMonthly: user.models_monthly_cap === null ? null : fromMicro(user.models_monthly_cap),
    };
  }

  // ------------------------------------------------------------ ledger

  addEntry(userId: string, kind: LedgerKind, amountMicro: number, description: string, ref: string | null = null, ts = Date.now()): void {
    if (!Number.isSafeInteger(amountMicro)) throw new Error("Invalid amount");
    this.db.prepare("INSERT INTO ledger (user_id, ts, kind, amount, description, ref) VALUES (?, ?, ?, ?, ?, ?)").run(userId, ts, kind, amountMicro, description, ref);
  }

  balanceMicro(userId: string): number {
    const r = this.db.prepare("SELECT COALESCE(SUM(amount), 0) AS b FROM ledger WHERE user_id = ?").get(userId) as { b: number };
    return r.b;
  }

  /** Total spent (positive micro-credits) in the given kinds since `since`. */
  spentSince(userId: string, kinds: LedgerKind[], since: number): number {
    const marks = kinds.map(() => "?").join(",");
    const r = this.db.prepare(`SELECT COALESCE(SUM(-amount), 0) AS s FROM ledger WHERE user_id = ? AND ts >= ? AND kind IN (${marks})`).get(userId, since, ...kinds) as { s: number };
    return r.s;
  }

  ledger(userId: string, limit: number): LedgerEntry[] {
    const rows = this.db.prepare("SELECT id, ts, kind, amount, description, ref FROM ledger WHERE user_id = ? ORDER BY id DESC LIMIT ?").all(userId, limit) as unknown as {
      id: number;
      ts: number;
      kind: LedgerKind;
      amount: number;
      description: string;
      ref: string | null;
    }[];
    return rows.map((r) => ({ ...r, amount: fromMicro(r.amount) }));
  }

  // ------------------------------------------------------------ pods

  insertPod(p: PodRow): void {
    this.db
      .prepare(
        `INSERT INTO pods (id, user_id, provider_id, name, gpu_name, gpu_count, cloud, image, volume_gb, container_disk_gb, rate_running, rate_stopped,
         status, status_reason, ssh_host, ssh_port, created_at, last_billed_at, spent) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(p.id, p.user_id, p.provider_id, p.name, p.gpu_name, p.gpu_count, p.cloud, p.image, p.volume_gb, p.container_disk_gb, p.rate_running, p.rate_stopped, p.status, p.status_reason, p.ssh_host, p.ssh_port, p.created_at, p.last_billed_at, p.spent);
  }

  updatePod(id: string, patch: Partial<Pick<PodRow, "status" | "status_reason" | "ssh_host" | "ssh_port" | "last_billed_at" | "spent">>): void {
    const keys = Object.keys(patch) as (keyof typeof patch)[];
    if (!keys.length) return;
    this.db.prepare(`UPDATE pods SET ${keys.map((k) => `${k} = ?`).join(", ")} WHERE id = ?`).run(...keys.map((k) => patch[k] ?? null), id);
  }

  pod(id: string): PodRow | null {
    return (this.db.prepare("SELECT * FROM pods WHERE id = ?").get(id) as PodRow | undefined) ?? null;
  }

  userPods(userId: string, includeTerminated = false): PodRow[] {
    const sql = includeTerminated ? "SELECT * FROM pods WHERE user_id = ? ORDER BY created_at DESC" : "SELECT * FROM pods WHERE user_id = ? AND status != 'terminated' ORDER BY created_at DESC";
    return this.db.prepare(sql).all(userId) as unknown as PodRow[];
  }

  livePods(): PodRow[] {
    return this.db.prepare("SELECT * FROM pods WHERE status != 'terminated'").all() as unknown as PodRow[];
  }
}
