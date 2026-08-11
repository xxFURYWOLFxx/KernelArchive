// Re-extracts type definitions for modules that already have them and replaces the
// stored records in place.
//
// The type extractor changed, so every reconstructed_c in the archive is stale, but
// the modules, functions, patterns and PE metadata around them are still correct.
// Re-indexing from zero would throw all of that away and take a day. This walks only
// the modules that own type rows, re-runs the extractor against the cached PDB, and
// swaps the type records for that module inside one transaction.
//
// Nothing is downloaded. A module whose PDB is not in the local symbol cache is
// skipped with its existing records left alone.
//
//   pnpm --filter @kernelarchive/api backfill-types --dry-run --limit=20
//   pnpm --filter @kernelarchive/api backfill-types --limit=50
//   pnpm --filter @kernelarchive/api backfill-types
//
// --dry-run does the whole job and rolls back every transaction, which is how to
// time it before committing to the real run. --restart ignores saved progress.
//
// --fast drops the type field-reference triggers for the duration and rebuilds that
// index in one pass at the end. Maintaining it a row at a time is most of the cost
// of a full backfill. While it is deferred the "used by" views return nothing. If
// the run dies before the rebuild, the next process to open the archive notices the
// cleared version gate and rebuilds the index itself, which is slower but correct.
//
// Stop the API first. The importer and the API writer share the database, and a
// second writer turns this into an hour of lock contention.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import type { KernelModule, WindowsBuild } from "@kernelarchive/shared";
import { ArchiveStore, type ArchiveRecord } from "./archive-store";
import { env } from "./env";
import { archive_database_paths } from "./ingestion-cache";
import { extract_pdb_data } from "./pe";

const repo_root = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const flags = new Set(process.argv.slice(2).filter((value) => value.startsWith("--") && !value.includes("=")));
const named = new Map(process.argv.slice(2)
  .filter((value) => value.startsWith("--") && value.includes("="))
  .map((value) => [value.slice(2, value.indexOf("=")), value.slice(value.indexOf("=") + 1)]));

const dry_run = flags.has("--dry-run");
const limit = Number(named.get("limit") ?? 0) || 0;
const only_module = named.get("module") ?? "";
const workers = Math.max(1, Math.min(16, Number(named.get("workers") ?? 4) || 4));
const restart = flags.has("--restart");
const fast = flags.has("--fast");

function workspace_path(value: string) {
  return isAbsolute(value) ? value : join(repo_root, value);
}

function human_duration(ms: number) {
  if (ms < 1000) { return `${Math.round(ms)}ms`; }
  if (ms < 60000) { return `${(ms / 1000).toFixed(1)}s`; }
  const minutes = Math.floor(ms / 60000);
  return `${minutes}m ${Math.round((ms % 60000) / 1000)}s`;
}

const database = archive_database_paths();
const cache_root = workspace_path(env.KERNELARCHIVE_LOCAL_CACHE_DIR);
const pdb_dump_exe = workspace_path(env.KERNELARCHIVE_PDB_DUMP_PATH);
const dia_dll = workspace_path(env.KERNELARCHIVE_DIA_DLL_PATH);
const state_path = join(cache_root, "types-backfill.json");

if (!existsSync(pdb_dump_exe)) {
  throw new Error(`type extractor not found at ${pdb_dump_exe}`);
}
if (!existsSync(dia_dll)) {
  throw new Error(`DIA runtime not found at ${dia_dll}. Set KERNELARCHIVE_DIA_DLL_PATH.`);
}
if (!existsSync(database.path)) {
  throw new Error(`archive database not found at ${database.path}`);
}

// Another writer holding the database turns every module into a 60 second wait and
// then a failure, so find out now rather than an hour in.
{
  const probe = new DatabaseSync(database.path);
  probe.exec("PRAGMA busy_timeout = 2000");
  try {
    probe.exec("BEGIN IMMEDIATE");
    probe.exec("ROLLBACK");
  } catch {
    probe.close();
    throw new Error("the archive database is locked by another process. Stop the API and any importer before running this.");
  }
  probe.close();
}

interface backfill_state {
  completed: string[];
}

function read_state(): backfill_state {
  if (restart || !existsSync(state_path)) { return { completed: [] }; }
  try {
    const parsed = JSON.parse(readFileSync(state_path, "utf8")) as backfill_state;
    return { completed: Array.isArray(parsed.completed) ? parsed.completed : [] };
  } catch {
    return { completed: [] };
  }
}

function write_state(state: backfill_state) {
  mkdirSync(dirname(state_path), { recursive: true });
  writeFileSync(state_path, JSON.stringify(state));
}

function pdb_identifier(module: KernelModule) {
  if (module.debug?.pdb_identifier) { return module.debug.pdb_identifier; }
  if (!module.pdb_guid) { return ""; }
  return `${module.pdb_guid.replace(/-/g, "")}${(module.pdb_age ?? 0).toString(16).toUpperCase()}`;
}

function cached_pdb_path(module: KernelModule) {
  const identifier = pdb_identifier(module);
  if (!module.pdb_name || !identifier) { return ""; }
  const path = join(cache_root, "symbols", module.pdb_name, identifier, module.pdb_name);
  return existsSync(path) ? path : "";
}

console.log(`archive     ${database.path}`);
console.log(`extractor   ${pdb_dump_exe}`);
console.log(`mode        ${dry_run ? "dry run, every transaction is rolled back" : "writing"}`);

const store = new ArchiveStore(database.path, database.legacy_path);

console.log("\n> finding modules that own type records");
const owners = store.type_record_owner_ids();
console.log(`  ${owners.length.toLocaleString()} modules`);

const builds = new Map<string, WindowsBuild>();
for (const record of store.load_collection("builds")) {
  builds.set(String(record.id), record as unknown as WindowsBuild);
}

const state = read_state();
const completed = new Set(state.completed);
let queue = owners;
if (only_module) { queue = queue.filter((id) => id === only_module); }
if (!dry_run) { queue = queue.filter((id) => !completed.has(id)); }
if (limit > 0) { queue = queue.slice(0, limit); }

console.log(`  ${queue.length.toLocaleString()} to process${completed.size > 0 && !dry_run ? `, ${completed.size.toLocaleString()} already done` : ""}`);

interface extraction_result {
  module_id: string;
  module_name: string;
  types?: ArchiveRecord[];
  stored_count: number;
  skip_reason?: string;
  extract_ms: number;
}

async function extract_one(module_id: string): Promise<extraction_result> {
  const started = Date.now();
  const record = store.get("modules", module_id);
  if (!record) {
    return { module_id, module_name: module_id, stored_count: 0, skip_reason: "module record missing", extract_ms: 0 };
  }
  const module = record as unknown as KernelModule;
  const stored_count = store.count("types", module_id);
  const pdb_path = cached_pdb_path(module);
  if (!pdb_path) {
    return { module_id, module_name: module.name, stored_count, skip_reason: "PDB not in the local symbol cache", extract_ms: 0 };
  }
  const build = builds.get(module.build_id);
  if (!build) {
    return { module_id, module_name: module.name, stored_count, skip_reason: "build record missing", extract_ms: 0 };
  }
  try {
    const extracted = await extract_pdb_data(module, pdb_path, pdb_dump_exe, dia_dll, build.build_number, build.architecture);
    const types = extracted.types as unknown as ArchiveRecord[];
    // A PDB that parses to nothing means the extractor failed, not that the module
    // lost its types. Writing that through would delete real data.
    if (stored_count > 0 && types.length === 0) {
      return { module_id, module_name: module.name, stored_count, skip_reason: "extractor returned no types for a module that has some", extract_ms: Date.now() - started };
    }
    return { module_id, module_name: module.name, types, stored_count, extract_ms: Date.now() - started };
  } catch (error) {
    const reason = error instanceof Error ? error.message.split("\n")[0] : "extraction failed";
    return { module_id, module_name: module.name, stored_count, skip_reason: reason, extract_ms: Date.now() - started };
  }
}

// Deferring costs a full rebuild at the end, so it only pays off across a run big
// enough to amortise it. A handful of modules is cheaper with the triggers left on.
const defer_references = fast && !dry_run && queue.length > 50;
if (fast && !defer_references) {
  console.log(`  --fast ignored: ${dry_run ? "dry runs leave the reference index alone" : "too few modules to be worth a full rebuild"}`);
}
if (defer_references) {
  console.log("\n> deferring the type field-reference index");
  store.defer_type_field_references();
}

console.log(`\n> re-extracting with ${workers} parallel extractors`);
const started_at = Date.now();
let processed = 0;
let written = 0;
let removed_total = 0;
let inserted_total = 0;
let extract_ms_total = 0;
let write_ms_total = 0;
const skipped: Array<{ module: string; reason: string }> = [];
// archive_module_counts.type_count comes from the module payload, not from counting
// type rows, so it only stays honest while the extractor finds the same set of types
// it found last time. It should, since this release changed how types are rendered
// and not which ones exist, but drift here is invisible otherwise.
const drifted: Array<{ module: string; before: number; after: number }> = [];

for (let index = 0; index < queue.length; index += workers) {
  const chunk = queue.slice(index, index + workers);
  const results = await Promise.all(chunk.map((module_id) => extract_one(module_id)));
  for (const result of results) {
    processed += 1;
    extract_ms_total += result.extract_ms;
    if (!result.types) {
      skipped.push({ module: result.module_name, reason: result.skip_reason ?? "unknown" });
      continue;
    }
    const write_started = Date.now();
    const outcome = store.replace_module_types(result.module_id, result.types, { rollback: dry_run });
    write_ms_total += Date.now() - write_started;
    written += 1;
    removed_total += outcome.removed;
    inserted_total += outcome.inserted;
    if (outcome.removed !== outcome.inserted) {
      drifted.push({ module: result.module_name, before: outcome.removed, after: outcome.inserted });
    }
    if (!dry_run) {
      completed.add(result.module_id);
      write_state({ completed: Array.from(completed) });
    }
  }
  const elapsed = Date.now() - started_at;
  const remaining = queue.length - processed;
  const projected = processed > 0 ? (elapsed / processed) * remaining : 0;
  console.log(`  ${processed}/${queue.length}  ${inserted_total.toLocaleString()} types  ${human_duration(elapsed)} elapsed  ${remaining > 0 ? `${human_duration(projected)} left` : "done"}`);
}

let rebuild_ms = 0;
if (defer_references) {
  console.log("\n> rebuilding the type field-reference index");
  const rebuilt = store.restore_type_field_references();
  rebuild_ms = rebuilt.duration_ms;
  console.log(`  ${rebuilt.rows.toLocaleString()} references in ${human_duration(rebuilt.duration_ms)}`);
}

store.close();

console.log("\nsummary");
console.log(`  modules processed   ${processed.toLocaleString()}`);
console.log(`  modules rewritten   ${written.toLocaleString()}`);
console.log(`  modules skipped     ${skipped.length.toLocaleString()}`);
console.log(`  types removed       ${removed_total.toLocaleString()}`);
console.log(`  types inserted      ${inserted_total.toLocaleString()}`);
console.log(`  extraction time     ${human_duration(extract_ms_total)} across ${workers} workers`);
console.log(`  database time       ${human_duration(write_ms_total)}`);
if (rebuild_ms > 0) { console.log(`  reference rebuild   ${human_duration(rebuild_ms)}`); }
console.log(`  wall clock          ${human_duration(Date.now() - started_at)}`);

if (skipped.length > 0) {
  console.log("\nskipped, records left untouched:");
  const reasons = new Map<string, number>();
  for (const entry of skipped) { reasons.set(entry.reason, (reasons.get(entry.reason) ?? 0) + 1); }
  for (const [reason, count] of Array.from(reasons).sort((left, right) => right[1] - left[1])) {
    console.log(`  ${String(count).padStart(6)}  ${reason}`);
  }
}

if (drifted.length > 0) {
  console.log(`\n${drifted.length} module(s) changed type count. Their module records still carry the`);
  console.log("old type_count, which is what build totals are summed from. Re-index these:");
  for (const entry of drifted.slice(0, 20)) {
    console.log(`  ${entry.module}  ${entry.before} -> ${entry.after}`);
  }
}

if (dry_run) {
  console.log("\nEvery transaction was rolled back. Nothing in the archive changed.");
} else if (written > 0) {
  console.log("\nThe WAL has grown by roughly the size of what was rewritten. With the API");
  console.log("still stopped, fold it back into the database before starting up again:");
  console.log("  node scripts/prepare-data.mjs");
}
