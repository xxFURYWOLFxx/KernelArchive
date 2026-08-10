// Reports what the API will actually see, without starting it.
//
// Run from the application root:  node scripts/doctor.mjs
//
// Everything here is read-only. The database is opened with readOnly so a missing
// file reports an error instead of being created, which is the failure mode that
// makes an empty archive look like a working one.
import { existsSync, readdirSync, statSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

const app_root = join(dirname(fileURLToPath(import.meta.url)), "..");

for (const candidate of [join(process.cwd(), ".env"), join(app_root, ".env")]) {
  if (!existsSync(candidate)) { continue; }
  try { process.loadEnvFile(candidate); console.log(`.env loaded from   ${candidate}`); } catch { console.log(`.env unreadable    ${candidate}`); }
  break;
}
if (!existsSync(join(process.cwd(), ".env")) && !existsSync(join(app_root, ".env"))) {
  console.log(".env               not found, defaults apply");
}

const resolve_path = (value) => (isAbsolute(value) ? value : join(app_root, value));
const cache_dir = resolve_path(process.env.KERNELARCHIVE_LOCAL_CACHE_DIR ?? "local-cache");
const db_path = resolve_path(process.env.KERNELARCHIVE_DATA_DB_PATH ?? join("local-cache", "archive.sqlite"));
const binaries_dir = join(cache_dir, "binaries");
const archive_dir = resolve_path(process.env.KERNELARCHIVE_ARCHIVE_DIR ?? "Archive");

const human = (n) => {
  const units = ["B", "KB", "MB", "GB"];
  let v = n, u = 0;
  while (v >= 1024 && u < units.length - 1) { v /= 1024; u += 1; }
  return `${v.toFixed(v >= 100 || u === 0 ? 0 : 1)} ${units[u]}`;
};

function count_files(path) {
  let files = 0;
  const walk = (current) => {
    let entries;
    try { entries = readdirSync(current, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (entry.isDirectory()) { walk(join(current, entry.name)); } else { files += 1; }
    }
  };
  if (existsSync(path)) { walk(path); }
  return files;
}

console.log(`node               ${process.version}`);
console.log(`app root           ${app_root}`);
console.log(`cwd                ${process.cwd()}`);
console.log("");
console.log(`database path      ${db_path}`);
console.log(`  exists           ${existsSync(db_path)}`);
if (existsSync(db_path)) {
  console.log(`  size             ${human(statSync(db_path).size)}  (expect about 13.5 GB)`);
}
for (const suffix of ["-wal", "-shm"]) {
  if (existsSync(db_path + suffix)) { console.log(`  ${suffix.slice(1)}              ${human(statSync(db_path + suffix).size)}`); }
}
console.log("");
console.log(`binaries           ${binaries_dir}`);
console.log(`  files            ${count_files(binaries_dir).toLocaleString()}  (expect about 8,826)`);
console.log(`Archive            ${archive_dir}`);
console.log(`  files            ${count_files(archive_dir).toLocaleString()}  (expect about 20,083)`);

if (!existsSync(db_path)) {
  console.log("\nNo database at that path. The API would create an empty one there and");
  console.log("then index Archive/ from scratch, which is why it can look like data was lost.");
  process.exit(1);
}

console.log("\n> reading the database directly");
let database;
try {
  database = new DatabaseSync(db_path, { readOnly: true });
} catch (error) {
  console.log(`  cannot open: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
database.exec("PRAGMA busy_timeout = 30000");

try {
  const tables = database.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type='table'").get();
  console.log(`  tables           ${tables.count}`);
  // archive_collection_counts is maintained by triggers. Counting archive_records
  // directly means scanning millions of rows, which on a cold disk takes minutes.
  let rows = [];
  try {
    rows = database.prepare("SELECT collection, records AS count FROM archive_collection_counts ORDER BY collection").all();
  } catch {
    rows = database.prepare("SELECT collection, COUNT(*) AS count FROM archive_records GROUP BY collection ORDER BY collection").all();
  }
  if (rows.length === 0) {
    console.log("  archive_records  EMPTY. This database has no data in it.");
  } else {
    for (const row of rows) { console.log(`  ${String(row.collection).padEnd(16)} ${Number(row.count).toLocaleString()}`); }
  }
  // The API hides builds it does not consider supported kernels, so a healthy row
  // count with nothing on screen points here rather than at the data.
  const builds = database.prepare("SELECT json_extract(payload,'$.product_name') AS product, json_extract(payload,'$.version') AS version, json_extract(payload,'$.architecture') AS arch FROM archive_records WHERE collection='builds' LIMIT 5").all();
  if (builds.length > 0) {
    console.log("\n  sample builds");
    for (const build of builds) { console.log(`    ${build.product} ${build.version} ${build.arch}`); }
  }
} catch (error) {
  console.log(`  query failed: ${error instanceof Error ? error.message : String(error)}`);
  console.log("  A schema this different usually means the file is not the shipped archive.");
} finally {
  database.close();
}
