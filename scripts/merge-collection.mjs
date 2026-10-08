// Merges a collector run into an existing Archive without triggering a full
// re-index.
//
// The importer fingerprints a file by size, mtime and ctime. Copying a whole
// build folder over an existing one gives all ~20,000 of its files fresh
// timestamps, so every module looks changed and the next index pass rebuilds
// millions of function records that did not move. Copying only the subtree that
// is genuinely new leaves the rest untouched and the importer sees just the new
// files.
//
// A build the Archive does not have yet is copied whole, because there is nothing
// to disturb.
//
//   node scripts/merge-collection.mjs <collection> <archive>
//   node scripts/merge-collection.mjs <collection> <archive> --apply
//
// Nothing is written without --apply. Run it without first and read the plan.
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";

const args = process.argv.slice(2).filter((value) => !value.startsWith("--"));
const flags = new Set(process.argv.slice(2).filter((value) => value.startsWith("--")));
const apply = flags.has("--apply");
const [source_root, archive_root] = args;

if (!source_root || !archive_root) {
  throw new Error("usage: node scripts/merge-collection.mjs <collection> <archive> [--apply]");
}
for (const path of [source_root, archive_root]) {
  if (!existsSync(path)) { throw new Error(`not found: ${path}`); }
}

// Only this subtree is merged into a build the Archive already has. Everything
// else in a re-collected build is a different revision of files that are already
// indexed, and rewriting them costs a re-index without adding a symbol.
const merge_subtree = join("Windows", "Boot");

function walk(root, out = []) {
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const full = join(root, entry.name);
    if (entry.isDirectory()) { walk(full, out); continue; }
    out.push(full);
  }
  return out;
}

function collected_build(path) {
  const marker = join(path, ".complete.json");
  if (!existsSync(marker)) { return undefined; }
  try {
    const parsed = JSON.parse(readFileSync(marker, "utf8"));
    return { build: String(parsed.build ?? ""), release_id: String(parsed.release_id ?? "") };
  } catch {
    return undefined;
  }
}

function human(bytes) {
  const units = ["B", "KB", "MB", "GB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit += 1; }
  return `${value.toFixed(value >= 100 || unit === 0 ? 0 : 1)} ${units[unit]}`;
}

const plan = [];
for (const name of readdirSync(source_root).sort()) {
  const source_build = join(source_root, name);
  if (!statSync(source_build).isDirectory()) { continue; }
  const marker = collected_build(source_build);
  if (!marker) {
    plan.push({ name, mode: "skip", reason: "no .complete.json, the release did not finish", files: [] });
    continue;
  }

  const target_build = join(archive_root, name);
  if (!existsSync(target_build)) {
    const files = walk(source_build);
    plan.push({ name, mode: "whole", reason: "not in the Archive yet", files, build: marker.build });
    continue;
  }

  const subtree = join(source_build, merge_subtree);
  if (!existsSync(subtree)) {
    plan.push({ name, mode: "skip", reason: `no ${merge_subtree} in the collected build`, files: [], build: marker.build });
    continue;
  }
  const files = walk(subtree).filter((file) => !existsSync(join(target_build, relative(source_build, file))));
  plan.push({
    name,
    mode: files.length > 0 ? "subtree" : "skip",
    reason: files.length > 0 ? `${merge_subtree} only, already in the Archive` : "every file is already present",
    files,
    build: marker.build,
  });
}

console.log(`collection  ${source_root}`);
console.log(`archive     ${archive_root}`);
console.log(`mode        ${apply ? "APPLYING" : "dry run, nothing is written"}`);
console.log("");

let total_files = 0;
let total_bytes = 0;
for (const entry of plan) {
  const bytes = entry.files.reduce((sum, file) => sum + statSync(file).size, 0);
  total_files += entry.files.length;
  total_bytes += bytes;
  const label = entry.mode === "whole" ? "WHOLE BUILD" : entry.mode === "subtree" ? merge_subtree : "skip";
  console.log(`${entry.name.padEnd(26)} ${label.padEnd(13)} ${String(entry.files.length).padStart(5)} files ${human(bytes).padStart(9)}  ${entry.reason}`);
}
console.log("");
console.log(`  ${total_files.toLocaleString()} files, ${human(total_bytes)} to copy`);

if (!apply) {
  console.log("\nNothing was written. Re-run with --apply to copy.");
  process.exit(0);
}

let copied = 0;
for (const entry of plan) {
  for (const file of entry.files) {
    const destination = join(archive_root, entry.name, relative(join(source_root, entry.name), file));
    mkdirSync(dirname(destination), { recursive: true });
    copyFileSync(file, destination);
    copied += 1;
  }
}
console.log(`\ncopied ${copied.toLocaleString()} files`);
console.log("\nThe importer will index these on its next pass. Nothing else in the");
console.log("Archive was touched, so no already-indexed module was disturbed.");
