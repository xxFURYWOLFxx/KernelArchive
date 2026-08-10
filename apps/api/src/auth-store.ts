import { createHash, randomBytes, randomUUID, scrypt, timingSafeEqual } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { env } from "./env";

export interface AdminUser {
  id: string;
  username: string;
  role: "ADMIN";
  must_change_password: boolean;
}

export interface AdminSession {
  token: string;
  expires_at: number;
  user: AdminUser;
}

export interface AuditEvent {
  id: string;
  user_id: string | null;
  action: string;
  target_type: string;
  target_id: string | null;
  success: boolean;
  ip_address: string | null;
  user_agent: string | null;
  details: Record<string, unknown>;
  created_at: number;
}

interface AuditEventRow extends Omit<AuditEvent, "success" | "details"> {
  success: number;
  details_json: string;
}

interface UserRow {
  id: string;
  username: string;
  role: "ADMIN";
  password_hash: string;
  failed_attempts: number;
  locked_until: number | null;
  must_change_password: number;
}

interface SessionRow {
  id: string;
  username: string;
  role: "ADMIN";
  must_change_password: number;
  token_hash: string;
  expires_at: number;
  last_seen_at: number;
}

const repo_root = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const password_version = "scrypt-v1";
const scrypt_n = 32768;
const scrypt_r = 8;
const scrypt_p = 1;
const scrypt_key_length = 64;
const scrypt_max_memory = 64 * 1024 * 1024;
const fake_salt = Buffer.from("c7c3cbe7f13f4c15575a16f89e3214b9", "hex");
let database: DatabaseSync | undefined;

export function close_auth_store() {
  database?.close();
  database = undefined;
}

function auth_db_path() {
  return isAbsolute(env.KERNELARCHIVE_AUTH_DB_PATH) ? env.KERNELARCHIVE_AUTH_DB_PATH : join(repo_root, env.KERNELARCHIVE_AUTH_DB_PATH);
}

function auth_db() {
  if (database) { return database; }
  const path = auth_db_path();
  mkdirSync(dirname(path), { recursive: true });
  database = new DatabaseSync(path);
  database.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
  database.exec(`
    CREATE TABLE IF NOT EXISTS auth_users (
      id TEXT PRIMARY KEY,
      username TEXT NOT NULL COLLATE NOCASE UNIQUE,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL CHECK (role = 'ADMIN'),
      must_change_password INTEGER NOT NULL DEFAULT 1 CHECK (must_change_password IN (0, 1)),
      failed_attempts INTEGER NOT NULL DEFAULT 0,
      locked_until INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS auth_sessions (
      token_hash TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      expires_at INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      last_seen_at INTEGER NOT NULL,
      ip_address TEXT,
      user_agent TEXT,
      FOREIGN KEY (user_id) REFERENCES auth_users(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS auth_sessions_user_id ON auth_sessions(user_id);
    CREATE INDEX IF NOT EXISTS auth_sessions_expires_at ON auth_sessions(expires_at);
    CREATE TABLE IF NOT EXISTS auth_audit_events (
      id TEXT PRIMARY KEY,
      user_id TEXT,
      action TEXT NOT NULL,
      target_type TEXT NOT NULL,
      target_id TEXT,
      success INTEGER NOT NULL CHECK (success IN (0, 1)),
      ip_address TEXT,
      user_agent TEXT,
      details_json TEXT NOT NULL DEFAULT '{}',
      created_at INTEGER NOT NULL,
      FOREIGN KEY (user_id) REFERENCES auth_users(id) ON DELETE SET NULL
    );
    CREATE INDEX IF NOT EXISTS auth_audit_events_created_at ON auth_audit_events(created_at DESC);
    CREATE INDEX IF NOT EXISTS auth_audit_events_action ON auth_audit_events(action, created_at DESC);
  `);
  const columns = database.prepare("PRAGMA table_info(auth_users)").all() as unknown as Array<{ name: string }>;
  if (!columns.some((column) => column.name === "must_change_password")) {
    database.exec("ALTER TABLE auth_users ADD COLUMN must_change_password INTEGER NOT NULL DEFAULT 1 CHECK (must_change_password IN (0, 1));");
  }
  database.prepare("DELETE FROM auth_sessions WHERE expires_at <= ?").run(Date.now());
  return database;
}

function derive_key(password: string, salt: Buffer) {
  return new Promise<Buffer>((resolve, reject) => {
    scrypt(password, salt, scrypt_key_length, { N: scrypt_n, r: scrypt_r, p: scrypt_p, maxmem: scrypt_max_memory }, (error, key) => {
      if (error) {
        reject(error);
        return;
      }
      resolve(key);
    });
  });
}

export function password_policy_error(password: string) {
  if (password.length < 16) { return "Password must contain at least 16 characters."; }
  if (password.length > 256) { return "Password is too long."; }
  if (!/[a-z]/.test(password) || !/[A-Z]/.test(password) || !/[0-9]/.test(password) || !/[^a-zA-Z0-9]/.test(password)) {
    return "Password must include uppercase, lowercase, number, and symbol characters.";
  }
  return "";
}

function valid_username(username: string) {
  if (/^[a-zA-Z0-9._-]{3,64}$/.test(username)) { return true; }
  // Email addresses are accepted so an operator can sign in with the address they
  // already use; the local part stays restricted to the same safe character set.
  return username.length <= 254 && /^[a-zA-Z0-9._%+-]{1,64}@[a-zA-Z0-9-]{1,63}(\.[a-zA-Z0-9-]{1,63})+$/.test(username);
}

async function hash_password(password: string) {
  const salt = randomBytes(16);
  const key = await derive_key(password, salt);
  return [password_version, scrypt_n, scrypt_r, scrypt_p, salt.toString("base64url"), key.toString("base64url")].join("$");
}

async function verify_password(password: string, encoded: string) {
  const [version, n_value, r_value, p_value, salt_value, hash_value] = encoded.split("$");
  if (version !== password_version || Number(n_value) !== scrypt_n || Number(r_value) !== scrypt_r || Number(p_value) !== scrypt_p || !salt_value || !hash_value) {
    await derive_key(password, fake_salt);
    return false;
  }
  const expected = Buffer.from(hash_value, "base64url");
  const actual = await derive_key(password, Buffer.from(salt_value, "base64url"));
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

async function fake_password_check(password: string) {
  const actual = await derive_key(password, fake_salt);
  timingSafeEqual(actual, Buffer.alloc(actual.length));
}

function token_hash(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

function public_user(row: Pick<UserRow, "id" | "username" | "role" | "must_change_password">): AdminUser {
  return { id: row.id, username: row.username, role: row.role, must_change_password: Boolean(row.must_change_password) };
}

function create_session(user: AdminUser, ip_address?: string, user_agent?: string): AdminSession {
  const db = auth_db();
  const token = randomBytes(32).toString("base64url");
  const now = Date.now();
  const expires_at = now + env.AUTH_SESSION_HOURS * 60 * 60 * 1000;
  db.prepare("DELETE FROM auth_sessions WHERE expires_at <= ?").run(now);
  db.prepare("INSERT INTO auth_sessions (token_hash, user_id, expires_at, created_at, last_seen_at, ip_address, user_agent) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .run(token_hash(token), user.id, expires_at, now, now, ip_address?.slice(0, 128) ?? null, user_agent?.slice(0, 512) ?? null);
  db.prepare("DELETE FROM auth_sessions WHERE user_id = ? AND token_hash NOT IN (SELECT token_hash FROM auth_sessions WHERE user_id = ? ORDER BY created_at DESC LIMIT 5)")
    .run(user.id, user.id);
  return { token, expires_at, user };
}

export async function provision_admin(username_value: string, password: string) {
  const username = username_value.trim();
  if (!valid_username(username)) { throw new Error("Username must be 3-64 characters using letters, numbers, dots, underscores, or hyphens."); }
  const policy_error = password_policy_error(password);
  if (policy_error) { throw new Error(policy_error); }
  const db = auth_db();
  const now = Date.now();
  const password_hash = await hash_password(password);
  const existing = db.prepare("SELECT id, username, role, password_hash, failed_attempts, locked_until, must_change_password FROM auth_users WHERE username = ? COLLATE NOCASE").get(username) as UserRow | undefined;
  const id = existing?.id ?? randomUUID();
  if (existing) {
    db.prepare("UPDATE auth_users SET username = ?, password_hash = ?, must_change_password = 1, failed_attempts = 0, locked_until = NULL, updated_at = ? WHERE id = ?")
      .run(username, password_hash, now, id);
    db.prepare("DELETE FROM auth_sessions WHERE user_id = ?").run(id);
  } else {
    db.prepare("INSERT INTO auth_users (id, username, password_hash, role, must_change_password, created_at, updated_at) VALUES (?, ?, ?, 'ADMIN', 1, ?, ?)")
      .run(id, username, password_hash, now, now);
  }
  record_audit_event({ user_id: id, action: existing ? "admin.reprovisioned" : "admin.provisioned", target_type: "admin", target_id: id, success: true });
  return { id, username, role: "ADMIN" as const, must_change_password: true };
}

export function record_audit_event(event: {
  user_id?: string | null;
  action: string;
  target_type: string;
  target_id?: string | null;
  success: boolean;
  ip_address?: string;
  user_agent?: string;
  details?: Record<string, unknown>;
}) {
  const id = randomUUID();
  const created_at = Date.now();
  auth_db().prepare(`
    INSERT INTO auth_audit_events
      (id, user_id, action, target_type, target_id, success, ip_address, user_agent, details_json, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    event.user_id ?? null,
    event.action,
    event.target_type,
    event.target_id ?? null,
    event.success ? 1 : 0,
    event.ip_address?.slice(0, 128) ?? null,
    event.user_agent?.slice(0, 512) ?? null,
    JSON.stringify(event.details ?? {}),
    created_at,
  );
  return id;
}

export function list_audit_events() {
  const rows = auth_db().prepare(`
    SELECT id, user_id, action, target_type, target_id, success, ip_address, user_agent, details_json, created_at
    FROM auth_audit_events
    ORDER BY created_at DESC, id DESC
  `).all() as unknown as AuditEventRow[];
  return rows.map((row): AuditEvent => ({
    id: row.id,
    user_id: row.user_id,
    action: row.action,
    target_type: row.target_type,
    target_id: row.target_id,
    success: Boolean(row.success),
    ip_address: row.ip_address,
    user_agent: row.user_agent,
    details: JSON.parse(row.details_json) as Record<string, unknown>,
    created_at: row.created_at,
  }));
}

export async function authenticate_admin(username_value: string, password: string, ip_address?: string, user_agent?: string) {
  const username = username_value.trim();
  const db = auth_db();
  const user = db.prepare("SELECT id, username, role, password_hash, failed_attempts, locked_until, must_change_password FROM auth_users WHERE username = ? COLLATE NOCASE").get(username) as UserRow | undefined;
  if (!user) {
    await fake_password_check(password);
    return { status: "invalid" as const };
  }

  const valid = await verify_password(password, user.password_hash);
  const now = Date.now();
  // A correct password clears the lock rather than being refused by it. Locking on
  // the account alone let anyone who knew a username keep the real owner out
  // indefinitely by failing five logins every lock window. Guessing is still
  // throttled: wrong passwords below extend the lock, each attempt costs a full
  // scrypt derivation, and the route is rate limited.
  if (!valid) {
    if (user.locked_until && user.locked_until > now) {
      return { status: "locked" as const, retry_after_ms: user.locked_until - now };
    }
    const failures = user.failed_attempts + 1;
    // Escalate with the failure count so sustained guessing gets progressively
    // more expensive instead of resetting to a flat window.
    const lock_windows = Math.max(1, failures - env.AUTH_MAX_FAILURES + 1);
    const lock_minutes = Math.min(env.AUTH_LOCK_MINUTES * lock_windows, 24 * 60);
    const locked_until = failures >= env.AUTH_MAX_FAILURES ? now + lock_minutes * 60 * 1000 : null;
    db.prepare("UPDATE auth_users SET failed_attempts = ?, locked_until = ?, updated_at = ? WHERE id = ?")
      .run(failures, locked_until, now, user.id);
    return locked_until ? { status: "locked" as const, retry_after_ms: locked_until - now } : { status: "invalid" as const };
  }

  db.prepare("UPDATE auth_users SET failed_attempts = 0, locked_until = NULL, updated_at = ? WHERE id = ?").run(now, user.id);
  return { status: "ok" as const, session: create_session(public_user(user), ip_address, user_agent) };
}

export function find_admin_session(token: string | undefined) {
  if (!token || token.length < 32 || token.length > 128) { return undefined; }
  const db = auth_db();
  const now = Date.now();
  const row = db.prepare(`
    SELECT s.token_hash, s.expires_at, s.last_seen_at, u.id, u.username, u.role, u.must_change_password
    FROM auth_sessions s
    JOIN auth_users u ON u.id = s.user_id
    WHERE s.token_hash = ? AND s.expires_at > ? AND s.last_seen_at > ? AND u.role = 'ADMIN'
  `).get(token_hash(token), now, now - env.AUTH_IDLE_MINUTES * 60 * 1000) as SessionRow | undefined;
  if (!row) { return undefined; }
  if (now - row.last_seen_at > 5 * 60 * 1000) {
    db.prepare("UPDATE auth_sessions SET last_seen_at = ? WHERE token_hash = ?").run(now, row.token_hash);
  }
  return { user: public_user(row), expires_at: row.expires_at };
}

export function revoke_admin_session(token: string | undefined) {
  if (!token) { return; }
  auth_db().prepare("DELETE FROM auth_sessions WHERE token_hash = ?").run(token_hash(token));
}

export async function change_admin_password(username: string, current_password: string, new_password: string, ip_address?: string, user_agent?: string) {
  const policy_error = password_policy_error(new_password);
  if (policy_error) { return { status: "policy" as const, message: policy_error }; }
  const db = auth_db();
  const user = db.prepare("SELECT id, username, role, password_hash, failed_attempts, locked_until, must_change_password FROM auth_users WHERE username = ? COLLATE NOCASE").get(username) as UserRow | undefined;
  if (!user || !await verify_password(current_password, user.password_hash)) { return { status: "invalid" as const }; }
  const now = Date.now();
  db.prepare("UPDATE auth_users SET password_hash = ?, must_change_password = 0, failed_attempts = 0, locked_until = NULL, updated_at = ? WHERE id = ?")
    .run(await hash_password(new_password), now, user.id);
  db.prepare("DELETE FROM auth_sessions WHERE user_id = ?").run(user.id);
  return { status: "ok" as const, session: create_session(public_user({ ...user, must_change_password: 0 }), ip_address, user_agent) };
}
