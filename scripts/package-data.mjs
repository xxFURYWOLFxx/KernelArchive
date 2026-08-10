// Packages the archive data into uploadable volumes.
//
// Produces split archives that extract straight into the server's app root, giving
// back local-cache/ and Archive/ in exactly the layout the API expects. Splitting is
// the point: a single multi-gigabyte file that fails at 90% has to start over, while
// a failed volume is re-uploaded on its own.
//
//   node scripts/package-data.mjs                 1 GB volumes into dist/data
//   node scripts/package-data.mjs --volume 2g     larger volumes
//   node scripts/package-data.mjs --single        one archive, no splitting
//   node scripts/package-data.mjs --skip-db       binaries and Archive only
//
// The write-ahead log is folded into the database first. Packaging a live database
// without that captures a file missing its most recent writes.
import { existsSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";

const repo_root = join(dirname(fileURLToPath(import.meta.url)), "..");
const out_dir = join(repo_root, "dist", "data");
const argv = process.argv.slice(2);
const flags = new Set(argv);

function option(name, fallback) {
  const index = argv.indexOf(name);
  return index >= 0 && argv[index + 1] ? argv[index + 1] : fallback;
}

const cache_dir = process.env.KERNELARCHIVE_LOCAL_CACHE_DIR ?? "local-cache";
const archive_db_rel = process.env.KERNELARCHIVE_DATA_DB_PATH ?? join(cache_dir, "archive.sqlite");
const archive_db = join(repo_root, archive_db_rel);
const binaries_rel = join(cache_dir, "binaries");
const archive_rel = process.env.KERNELARCHIVE_ARCHIVE_DIR ?? "Archive";

const rar_candidates = [
  "C:/Program Files/WinRAR/Rar.exe",
  "C:/Program Files (x86)/WinRAR/Rar.exe",
];
const rar = rar_candidates.find((path) => existsSync(path));

function human(bytes) {
  const units = ["B", "KB", "MB", "GB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit += 1; }
  return `${value.toFixed(value >= 100 || unit === 0 ? 0 : 1)} ${units[unit]}`;
}

function tree_size(path) {
  let total = 0;
  const walk = (current) => {
    let entries;
    try { entries = readdirSync(current, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const next = join(current, entry.name);
      if (entry.isDirectory()) { walk(next); continue; }
      try { total += statSync(next).size; } catch { /* vanished */ }
    }
  };
  if (!existsSync(path)) { return 0; }
  return statSync(path).isDirectory() ? (walk(path), total) : statSync(path).size;
}

function produced(prefix) {
  if (!existsSync(out_dir)) { return []; }
  return readdirSync(out_dir).filter((name) => name.startsWith(prefix)).sort();
}

// Paths are stored relative to the repo root so the archive extracts into the app
// root on the server and lands local-cache/ and Archive/ where the API looks.
function pack(name, targets, label) {
  const present = targets.filter((target) => existsSync(join(repo_root, target)));
  if (present.length === 0) {
    console.log(`  ${label}: nothing to pack, skipped`);
    return;
  }
  const raw = present.reduce((total, target) => total + tree_size(join(repo_root, target)), 0);
  console.log(`\n> ${label}  (${human(raw)} raw)`);
  const started = Date.now();

  if (rar) {
    // No -ep flag. RAR then stores each name exactly as passed, and the targets are
    // relative to the repo root, so the set extracts into local-cache/ and Archive/
    // on the server. -ep1 would strip the leading folder and scatter the files.
    const args = ["a", "-r", "-m3", "-idq", "-o+"];
    if (!flags.has("--single")) { args.push(`-v${option("--volume", "1g")}`); }
    // auth.sqlite holds the admin password hash and live sessions; the -wal and -shm
    // files are meaningless once the checkpoint has folded them in.
    args.push("-x*auth.sqlite*", "-x*.sqlite-wal", "-x*.sqlite-shm", "-x*index.json");
    args.push(join(out_dir, `${name}.rar`), ...present);
    execFileSync(rar, args, { cwd: repo_root, stdio: "inherit" });
  } else {
    const args = ["-czf", join(out_dir, `${name}.tar.gz`),
      "--exclude=*auth.sqlite*", "--exclude=*.sqlite-wal", "--exclude=*.sqlite-shm", "--exclude=*index.json",
      ...present];
    execFileSync("tar", args, { cwd: repo_root, stdio: "inherit", shell: process.platform === "win32" });
  }

  const parts = produced(name);
  const packed = parts.reduce((total, part) => total + statSync(join(out_dir, part)).size, 0);
  const seconds = Math.round((Date.now() - started) / 1000);
  console.log(`  ${parts.length} file${parts.length === 1 ? "" : "s"}, ${human(packed)} (${(raw / Math.max(packed, 1)).toFixed(2)}x smaller) in ${seconds}s`);
}

if (!existsSync(archive_db)) {
  throw new Error(`archive database not found at ${archive_db}`);
}

console.log(rar ? `using ${rar}` : "WinRAR not found, falling back to tar.gz (no volume splitting)");

if (!flags.has("--skip-db")) {
  console.log("\n> folding the write-ahead log into the database");
  const database = new DatabaseSync(archive_db);
  database.exec("PRAGMA busy_timeout = 120000");
  const checkpoint = database.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get();
  const blocked = Object.values(checkpoint ?? {})[0];
  console.log(`  checkpoint ${JSON.stringify(checkpoint)}`);
  // quick_check reads the entire multi-gigabyte file, which costs far longer than
  // the compression that follows. The checkpoint is what protects correctness here,
  // so verification is opt-in rather than a tax on every package run.
  if (flags.has("--verify")) {
    console.log("  verifying (reads the whole database, slow)");
    const integrity = database.prepare("PRAGMA quick_check").get();
    console.log(`  quick_check ${Object.values(integrity ?? {})[0] ?? "unknown"}`);
  }
  database.close();
  if (blocked === 1) {
    throw new Error("The checkpoint was blocked, so the database still has writes in its WAL. Stop the API and run this again.");
  }
}

mkdirSync(out_dir, { recursive: true });
for (const stale of readdirSync(out_dir)) {
  if (/^kernelarchive-(db|binaries|archive)\b/.test(stale)) { rmSync(join(out_dir, stale), { force: true }); }
}

if (!flags.has("--skip-db")) { pack("kernelarchive-db", [archive_db_rel], "database"); }
pack("kernelarchive-binaries", [binaries_rel], "binary cache");
pack("kernelarchive-archive", [archive_rel], "Archive");

const all = readdirSync(out_dir).filter((name) => name.startsWith("kernelarchive-")).sort();
const total = all.reduce((sum, name) => sum + statSync(join(out_dir, name)).size, 0);
console.log(`\n${all.length} file${all.length === 1 ? "" : "s"} in dist/data, ${human(total)} total\n`);
for (const name of all) { console.log(`  ${name}  ${human(statSync(join(out_dir, name)).size)}`); }

console.log("\nUpload everything in dist/data to the server, then from the app root:");
// Only the first file of each set is named. RAR pulls the remaining volumes in by
// itself, and a set small enough to fit one volume carries no part number at all,
// so the names are read back from disk rather than guessed.
const first_of_each = ["kernelarchive-db", "kernelarchive-binaries", "kernelarchive-archive"]
  .map((prefix) => all.filter((name) => name.startsWith(prefix))[0])
  .filter(Boolean);
for (const entry of first_of_each) {
  console.log(rar ? `  "C:\\Program Files\\WinRAR\\WinRAR.exe" x ${entry}` : `  tar -xzf ${entry}`);
}
if (rar && all.length > first_of_each.length) {
  console.log("\n  Only the files above. Remaining volumes are pulled in automatically.");
}
console.log("\nauth.sqlite is deliberately not included. Create the administrator on the");
console.log("server so the password hash and live sessions never leave this machine.");
