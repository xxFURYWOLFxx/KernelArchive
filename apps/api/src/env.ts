import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

// The API is launched straight through tsx, which unlike Next does not read .env.
// Without this every setting in that file is ignored in silence and the defaults
// win, which looks exactly like a working server pointed at the wrong data.
// Real environment variables still take precedence: loadEnvFile does not overwrite
// anything already set, so a service definition or shell export beats the file.
const app_root = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
for (const candidate of [join(process.cwd(), ".env"), join(app_root, ".env")]) {
  if (!existsSync(candidate)) { continue; }
  try {
    process.loadEnvFile(candidate);
  } catch {
    // A malformed .env must not stop the server from booting on its defaults.
  }
  break;
}

const optional_secret = z.preprocess((value) => typeof value === "string" && value.trim() === "" ? undefined : value, z.string().min(32).optional());

const env_schema = z.object({
  HOST: z.string().min(1).default("127.0.0.1"),
  PORT: z.coerce.number().int().min(1).max(65535).default(4002),
  PUBLIC_APP_URL: z.string().url().default("http://localhost:3000"),
  TRUSTED_ORIGINS: z.string().default(""),
  TRUST_PROXY: z.string().default("127.0.0.1,::1"),
  KERNELARCHIVE_API_KEY: optional_secret,
  KERNELARCHIVE_LOCAL_CACHE_DIR: z.string().default("local-cache"),
  KERNELARCHIVE_DATA_DB_PATH: z.string().default("local-cache/archive.sqlite"),
  KERNELARCHIVE_AUTH_DB_PATH: z.string().default("local-cache/auth.sqlite"),
  KERNELARCHIVE_ARCHIVE_DIR: z.string().default("Archive"),
  KERNELARCHIVE_ARCHIVE_IMPORT_CONCURRENCY: z.coerce.number().int().min(1).max(16).default(4),
  KERNELARCHIVE_ARCHIVE_SCAN_INTERVAL_MS: z.coerce.number().int().min(5000).default(300000),
  // Set false on a server that serves a prebuilt archive. The importer decides a
  // file is unchanged from its size, mtime and ctime, and copying or extracting the
  // Archive folder resets those, so every file looks new. It would then re-index
  // the lot, and without the symbol cache alongside it that replaces PDB-derived
  // types and functions with PE exports alone. A mirror should only ever read.
  KERNELARCHIVE_ARCHIVE_IMPORT_ENABLED: z.enum(["true", "false"]).default("true").transform((value) => value === "true"),
  KERNELARCHIVE_SYMBOL_SERVER_URLS: z.string().default("https://msdl.microsoft.com/download/symbols"),
  KERNELARCHIVE_PDB_DUMP_PATH: z.string().default("tools/pdb-dump/pdb_dump.exe"),
  KERNELARCHIVE_DIA_DLL_PATH: z.string().default("C:\\Program Files\\Microsoft Visual Studio\\2022\\Enterprise\\DIA SDK\\bin\\amd64\\msdia140.dll"),
  UPLOAD_MAX_BYTES: z.coerce.number().int().min(1).default(256 * 1024 * 1024),
  // Applies to JSON bodies, which include anonymous POST routes. Fastify buffers and
  // parses the body before the rate limiter runs, so leaving this at the upload size
  // let an unauthenticated client push 256 MB into the heap per request.
  JSON_BODY_MAX_BYTES: z.coerce.number().int().min(1024).default(1024 * 1024),
  PDB_DOWNLOAD_TIMEOUT_MS: z.coerce.number().int().min(1000).default(12000),
  PDB_FAILURE_CACHE_MINUTES: z.coerce.number().int().min(1).max(1440).default(15),
  RATE_LIMIT_PUBLIC_PER_MINUTE: z.coerce.number().int().min(1).default(300),
  RATE_LIMIT_AUTH_PER_MINUTE: z.coerce.number().int().min(1).default(1200),
  AUTH_SESSION_HOURS: z.coerce.number().int().min(1).max(168).default(12),
  AUTH_IDLE_MINUTES: z.coerce.number().int().min(5).max(1440).default(60),
  AUTH_MAX_FAILURES: z.coerce.number().int().min(3).max(20).default(5),
  AUTH_LOCK_MINUTES: z.coerce.number().int().min(1).max(1440).default(15),
});

export const env = env_schema.parse(process.env);
