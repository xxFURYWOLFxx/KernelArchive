// Prepares the archive data for transfer to a server.
//
// The database runs in WAL mode, so archive.sqlite on disk is NOT self-contained
// while the API is running: recent writes live in archive.sqlite-wal. Copying the
// main file alone yields a stale or torn database. This checkpoints the WAL into
// the main file, verifies it, then reports exactly what to copy.
//
//   node scripts/prepare-data.mjs           checkpoint, verify, report
//   node scripts/prepare-data.mjs --vacuum  also write a compacted copy
//
// Nothing is copied for you. The data is tens of gigabytes and belongs in a
// resumable transfer (robocopy /Z, rsync --partial), not a script that starts over
// on a dropped connection.
import { existsSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

const repo_root = join(dirname(fileURLToPath(import.meta.url)), "..");
const flags = new Set(process.argv.slice(2));
const cache_dir = process.env.KERNELARCHIVE_LOCAL_CACHE_DIR ?? "local-cache";
const archive_db = join(repo_root, process.env.KERNELARCHIVE_DATA_DB_PATH ?? join(cache_dir, "archive.sqlite"));
const binaries_dir = join(repo_root, cache_dir, "binaries");
const archive_dir = join(repo_root, process.env.KERNELARCHIVE_ARCHIVE_DIR ?? "Archive");

function human(bytes) {
  const units = ["B", "KB", "MB", "GB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit += 1; }
  return `${value.toFixed(value >= 100 || unit === 0 ? 0 : 1)} ${units[unit]}`;
}

function file_size(path) {
  try { return statSync(path).size; } catch { return 0; }
}

function tree_size(path) {
  let total = 0;
  let files = 0;
  const walk = (current) => {
    let entries;
    try { entries = readdirSync(current, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const next = join(current, entry.name);
      if (entry.isDirectory()) { walk(next); continue; }
      files += 1;
      total += file_size(next);
    }
  };
  if (existsSync(path)) { walk(path); }
  return { bytes: total, files };
}

if (!existsSync(archive_db)) {
  throw new Error(`archive database not found at ${archive_db}`);
}

console.log(`archive.sqlite      ${human(file_size(archive_db))}`);
console.log(`archive.sqlite-wal  ${human(file_size(`${archive_db}-wal`))}  (folded in below)`);

console.log("\n> checkpointing WAL");
const database = new DatabaseSync(archive_db);
database.exec("PRAGMA busy_timeout = 120000");
// TRUNCATE folds every committed frame into the main file and empties the WAL, so
// archive.sqlite becomes a complete, consistent copy on its own.
const checkpoint = database.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get();
const integrity = database.prepare("PRAGMA quick_check").get();
database.close();

const blocked = Object.values(checkpoint ?? {})[0];
console.log(`  checkpoint: ${JSON.stringify(checkpoint)}${blocked === 1 ? "  <- BLOCKED, see below" : ""}`);
console.log(`  quick_check: ${Object.values(integrity ?? {})[0] ?? "unknown"}`);
console.log(`  wal now: ${human(file_size(`${archive_db}-wal`))}`);
if (blocked === 1) {
  console.log("\n  The checkpoint could not complete because something is still reading");
  console.log("  or writing the database. Stop the API and run this again, otherwise the");
  console.log("  copy you take will be missing recent writes.");
}

let shipped_db = archive_db;
if (flags.has("--vacuum")) {
  const out_dir = join(repo_root, "dist", "data");
  mkdirSync(out_dir, { recursive: true });
  const compacted = join(out_dir, "archive.sqlite");
  rmSync(compacted, { force: true });
  console.log("\n> vacuuming into a compact copy (rewrites the whole file, needs room for two)");
  const source = new DatabaseSync(archive_db, { readOnly: true });
  source.exec("PRAGMA busy_timeout = 120000");
  source.prepare("VACUUM INTO ?").run(compacted);
  source.close();
  shipped_db = compacted;
  console.log(`  ${human(file_size(archive_db))} -> ${human(file_size(compacted))}`);
}

const binaries = tree_size(binaries_dir);
const archive = tree_size(archive_dir);
const total = file_size(shipped_db) + binaries.bytes + archive.bytes;

console.log("\nCopy to the server, preserving these relative locations:");
console.log(`  ${shipped_db}`);
console.log(`    -> <server>\\local-cache\\archive.sqlite        ${human(file_size(shipped_db))}`);
console.log(`  ${binaries_dir}`);
console.log(`    -> <server>\\local-cache\\binaries\\             ${human(binaries.bytes)} (${binaries.files.toLocaleString()} files)`);
console.log(`  ${archive_dir}`);
console.log(`    -> <server>\\Archive\\                          ${human(archive.bytes)} (${archive.files.toLocaleString()} files)`);
console.log(`\n  total to transfer: ${human(total)}`);

console.log("\nDo NOT copy auth.sqlite. Create the administrator on the server so the");
console.log("password hash and any live session tokens never leave this machine.");

console.log("\nWindows to Windows, resumable and safe to re-run:");
console.log("  robocopy local-cache \\\\server\\share\\kernelarchive\\local-cache archive.sqlite /Z");
console.log("  robocopy local-cache\\binaries \\\\server\\share\\kernelarchive\\local-cache\\binaries /E /Z /MT:16");
console.log("  robocopy Archive \\\\server\\share\\kernelarchive\\Archive /E /Z /MT:16");
console.log("\n  /Z restarts a dropped file instead of starting the set over.");
console.log("  Re-running skips files that already match, so an interrupted copy resumes.");
