// Writes the sitemap that Google reads, into apps/web/public.
//
// It is generated rather than served from a route because the interesting URLs
// are archive content: a route would have to scan a 14 GB database on every
// crawler request. Generating it at deploy time makes serving free, and the
// files can be uploaded or submitted to Search Console on their own.
//
//   node scripts/generate-sitemap.mjs
//   node scripts/generate-sitemap.mjs --site=https://kernelarchive.com
//   node scripts/generate-sitemap.mjs --max-types=100000 --max-functions=20000
//
// With no archive database present it still writes the static pages, so a build
// on a machine without the archive produces a valid sitemap rather than none.
import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

const repo_root = join(dirname(fileURLToPath(import.meta.url)), "..");

// The archive path and the public origin are configured in .env, and this runs as
// a plain script rather than through the API, so nothing has loaded that file yet.
// Without this it would fall back to the defaults and, on a server that keeps its
// database somewhere else, write a sitemap built from nothing.
for (const candidate of [join(process.cwd(), ".env"), join(repo_root, ".env")]) {
  if (!existsSync(candidate)) { continue; }
  try { process.loadEnvFile(candidate); } catch { /* defaults apply */ }
  break;
}

const argv = process.argv.slice(2);
const named = new Map(argv.filter((value) => value.startsWith("--") && value.includes("="))
  .map((value) => [value.slice(2, value.indexOf("=")), value.slice(value.indexOf("=") + 1)]));

const site = (named.get("site") ?? process.env.NEXT_PUBLIC_SITE_URL ?? "https://kernelarchive.com").trim().replace(/\/+$/, "");
const max_types = Number(named.get("max-types") ?? 50000);
const max_functions = Number(named.get("max-functions") ?? 25000);
// The sitemap protocol caps a single file at 50,000 URLs and 50 MB.
const urls_per_file = 45000;

const public_dir = join(repo_root, "apps", "web", "public");
const sitemap_dir = join(public_dir, "sitemaps");
// Built aside and swapped in once every shard exists. Writing in place meant an
// interrupted run kept whichever shards had finished and silently dropped the
// rest, and the type and function shards are written last, so what survived
// advertised the module list and none of the pages worth ranking.
const staging_dir = join(public_dir, "sitemaps.staging");
const staging_index = join(public_dir, "sitemap.xml.staging");

function workspace_path(value) {
  return isAbsolute(value) ? value : join(repo_root, value);
}

const cache_dir = process.env.KERNELARCHIVE_LOCAL_CACHE_DIR ?? "local-cache";
const db_path = workspace_path(process.env.KERNELARCHIVE_DATA_DB_PATH ?? join(cache_dir, "archive.sqlite"));

function escape_xml(value) {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function url_entry(path, frequency, priority) {
  return "<url><loc>" + escape_xml(site + path) + "</loc><changefreq>" + frequency + "</changefreq><priority>" + priority + "</priority></url>";
}

function write_sitemap(name, entries) {
  const header = '<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n';
  const body = header + entries.join("\n") + "\n</urlset>\n";
  writeFileSync(join(staging_dir, name), body);
  return { name, count: entries.length, bytes: Buffer.byteLength(body) };
}

// One file per chunk, because a single sitemap may not exceed the protocol caps.
function write_sharded(prefix, entries) {
  const written = [];
  if (entries.length === 0) { return written; }
  for (let index = 0; index * urls_per_file < entries.length; index += 1) {
    const slice = entries.slice(index * urls_per_file, (index + 1) * urls_per_file);
    const suffix = entries.length > urls_per_file ? "-" + (index + 1) : "";
    written.push(write_sitemap(prefix + suffix + ".xml", slice));
  }
  return written;
}

const static_pages = [
  ["/", "daily", "1.0"],
  ["/builds", "daily", "0.9"],
  ["/search", "weekly", "0.7"],
  ["/patterns", "weekly", "0.7"],
  ["/diff", "weekly", "0.6"],
  ["/api-docs", "weekly", "0.8"],
  ["/contact", "yearly", "0.3"],
  ["/terms", "yearly", "0.2"],
  ["/privacy", "yearly", "0.2"],
];

rmSync(staging_dir, { force: true, recursive: true });
rmSync(staging_index, { force: true });
mkdirSync(staging_dir, { recursive: true });

console.log("site        " + site);
console.log("archive     " + (existsSync(db_path) ? db_path : "not found, writing static pages only"));

const files = [];
files.push(...write_sharded("pages", static_pages.map((page) => url_entry(page[0], page[1], page[2]))));

if (existsSync(db_path)) {
  const database = new DatabaseSync(db_path, { readOnly: true });
  database.exec("PRAGMA busy_timeout = 120000; PRAGMA temp_store = MEMORY; PRAGMA mmap_size = 268435456;");

  console.log("\n> builds");
  const builds = database.prepare("SELECT id, payload FROM archive_records WHERE collection = 'builds'").all()
    .map((row) => {
      let build_number = "";
      try { build_number = String(JSON.parse(row.payload).build_number ?? ""); } catch { build_number = ""; }
      return { id: row.id, build_number };
    })
    // Newest first, so a capped run spends its budget on the versions people are
    // running rather than on Windows 10 1709.
    .sort((left, right) => right.build_number.localeCompare(left.build_number, undefined, { numeric: true }));
  files.push(...write_sharded("builds", builds.map((build) => url_entry("/builds/" + build.id, "weekly", "0.8"))));
  console.log("  " + builds.length + " builds");

  console.log("> modules");
  const modules = database.prepare("SELECT id, parent_id FROM archive_records INDEXED BY archive_records_collection_parent WHERE collection = 'modules' AND parent_id IS NOT NULL").all();
  files.push(...write_sharded("modules", modules.map((module) => url_entry("/modules/" + module.id, "monthly", "0.6"))));
  console.log("  " + modules.length.toLocaleString() + " modules");

  const modules_by_build = new Map();
  for (const module of modules) {
    const bucket = modules_by_build.get(module.parent_id);
    if (bucket) { bucket.push(module.id); } else { modules_by_build.set(module.parent_id, [module.id]); }
  }

  // Windows kernel types are named in caps, with or without a leading underscore.
  // The C++ template instantiations that template-heavy drivers drag in are not,
  // and there are tens of thousands of them in a single binary. Without this the
  // whole budget goes to wistd::is_constructible noise before reaching _EPROCESS.
  // Windows kernel types are named in caps, with or without a leading underscore.
  // Exported functions are CamelCase. Neither looks like the decorated C++ names
  // and template instantiations that template-heavy drivers drag in by the tens
  // of thousands, which is what the budget went to before this existed.
  const worth_indexing = (collection, name) => {
    if (typeof name !== "string" || name.length === 0) { return false; }
    if (collection === "functions") { return /^[A-Za-z_][A-Za-z0-9_]{3,}$/.test(name); }
    return /^_?[A-Z][A-Z0-9_]{2,}$/.test(name);
  };

  // Symbols hang off their module, so the work is driven from the parent index
  // rather than a scan over millions of payloads. Modules are visited smallest
  // first so one binary carrying 20,000 template types cannot crowd out every
  // other driver, and a name is only listed once, from the newest build that has
  // it, because 25 near-identical pages for one struct help nobody.
  const collect = (collection, limit) => {
    const ids = [];
    if (limit <= 0) { return ids; }
    const counts = new Map();
    for (const row of database.prepare("SELECT parent_id, COUNT(*) AS count FROM archive_records INDEXED BY archive_records_collection_parent WHERE collection = ? AND parent_id IS NOT NULL GROUP BY parent_id").all(collection)) {
      counts.set(row.parent_id, Number(row.count));
    }
    // Size comes from the payload, but the payload is already being read to get
    // the id, so asking for it costs nothing extra.
    const statement = database.prepare("SELECT id, name, json_extract(payload, '$.size') AS size, json_extract(payload, '$.kind') AS kind FROM archive_records INDEXED BY archive_records_collection_parent WHERE collection = ? AND parent_id = ?");
    const seen = new Set();
    for (const build of builds) {
      // Richest module first. A driver that merely forward declares _EPROCESS
      // stores it with no members at all, and listing that instead of the real
      // definition would point search engines at an empty page.
      const module_ids = (modules_by_build.get(build.id) ?? [])
        .filter((module_id) => (counts.get(module_id) ?? 0) > 0)
        .sort((left, right) => (counts.get(right) ?? 0) - (counts.get(left) ?? 0));
      for (const module_id of module_ids) {
        for (const row of statement.all(collection, module_id)) {
          const key = (row.name ?? "").toLowerCase();
          if (!worth_indexing(collection, row.name) || seen.has(key)) { continue; }
          // A typedef page carries one alias line and nothing to rank on, and a
          // zero-size record is a forward declaration with no layout at all.
          if (collection === "types" && (Number(row.size ?? 0) <= 0 || row.kind === "typedef")) { continue; }
          seen.add(key);
          ids.push(row.id);
          if (ids.length >= limit) { return ids; }
        }
      }
    }
    return ids;
  };

  console.log("> types");
  const type_ids = collect("types", max_types);
  files.push(...write_sharded("types", type_ids.map((id) => url_entry("/types/" + id, "monthly", "0.7"))));
  console.log("  " + type_ids.length.toLocaleString() + " types" + (type_ids.length >= max_types ? " (capped, raise with --max-types)" : ""));

  if (max_functions > 0) {
    console.log("> functions");
    const function_ids = collect("functions", max_functions);
    files.push(...write_sharded("functions", function_ids.map((id) => url_entry("/functions/" + id, "monthly", "0.5"))));
    console.log("  " + function_ids.length.toLocaleString() + " functions" + (function_ids.length >= max_functions ? " (capped)" : ""));
  }

  database.close();
}

const now = new Date().toISOString();
const index_header = '<?xml version="1.0" encoding="UTF-8"?>\n<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n';
const index_entries = files.map((file) => "<sitemap><loc>" + escape_xml(site + "/sitemaps/" + file.name) + "</loc><lastmod>" + now + "</lastmod></sitemap>");
writeFileSync(staging_index, index_header + index_entries.join("\n") + "\n</sitemapindex>\n");

// Every shard is on disk, so publish the set. A directory cannot be renamed over
// an existing one, hence moving the old one aside first; the index is a file and
// replaces itself in one step.
const previous_dir = join(public_dir, "sitemaps.previous");
rmSync(previous_dir, { force: true, recursive: true });
if (existsSync(sitemap_dir)) { renameSync(sitemap_dir, previous_dir); }
renameSync(staging_dir, sitemap_dir);
renameSync(staging_index, join(public_dir, "sitemap.xml"));
rmSync(previous_dir, { force: true, recursive: true });

const total_urls = files.reduce((sum, file) => sum + file.count, 0);
const total_bytes = files.reduce((sum, file) => sum + file.bytes, 0);
console.log("\nwrote");
for (const file of files) {
  console.log("  sitemaps/" + file.name.padEnd(16) + String(file.count).padStart(7) + " urls  " + (file.bytes / 1024 / 1024).toFixed(1) + " MB");
}
console.log("  sitemap.xml      index of " + files.length + " file(s)");
console.log("\n  " + total_urls.toLocaleString() + " URLs, " + (total_bytes / 1024 / 1024).toFixed(1) + " MB total");
console.log("\nSubmit " + site + "/sitemap.xml in Google Search Console.");
