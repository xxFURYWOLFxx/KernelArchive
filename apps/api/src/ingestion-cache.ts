import { createHash, randomUUID } from "node:crypto";
import { createWriteStream, existsSync, mkdirSync, readFileSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { get as http_get } from "node:http";
import { get as https_get } from "node:https";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { Architecture, ArchiveFileRecord, BinaryIngestionRecord, BinaryIngestionResult, BuildDetectionSource, KernelFunction, KernelModule, KernelType, ModulePdbStatus, PatternCrossReferenceTarget, PatternResult, PdbLookupResult, SearchResult, WindowsBuild } from "@kernelarchive/shared";
import type { TypeFieldReference, TypeFunctionReference } from "@kernelarchive/shared";
import { build_display_label, function_signature, normalize_windows_build, windows_product_label, windows_release_label, interpret_module_sections, is_exposed_function, is_supported_kernel_build } from "@kernelarchive/shared";
import { ArchiveStore, type ArchiveChanges, type ArchiveCollection, type ArchiveSearchFilters, type ArchiveSnapshot } from "./archive-store";
import { ArchiveReadBusyError, archive_read_pool_ready, run_archive_read } from "./archive-read-pool";
import { env } from "./env";
import { build_function_records, build_module_from_pe, extract_pdb_data, hex, id_part, parse_pe } from "./pe";

interface LocalIndex {
  builds: WindowsBuild[];
  modules: KernelModule[];
  functions: KernelFunction[];
  types: KernelType[];
  patterns: PatternResult[];
  pdb_lookups: PdbLookupCacheRecord[];
  ingestions: BinaryIngestionRecord[];
  archive_files: ArchiveFileRecord[];
}

interface PdbLookupCacheRecord extends PdbLookupResult {
  id: string;
  created_at: string;
  updated_at: string;
}

export interface IngestOptions {
  product_name?: string;
  version?: string;
  build_number?: string;
  revision?: string;
  architecture?: Architecture;
  force_pdb_retry?: boolean;
}

const repo_root = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const empty_index: LocalIndex = { builds: [], modules: [], functions: [], types: [], patterns: [], pdb_lookups: [], ingestions: [], archive_files: [] };
let index_cache: LocalIndex | undefined;
let index_cache_revision = -1;
let index_cache_checked_at = 0;
const ingestion_inflight = new Map<string, Promise<BinaryIngestionResult>>();
const pdb_lookup_inflight = new Map<string, Promise<PdbLookupResult>>();
const module_page_cache = new Map<string, { expires_at: number; items: KernelModule[]; revision: number; total: number }>();
const index_stat_interval_ms = 500;
const module_page_cache_limit = 512;
const module_page_cache_ttl_ms = 60 * 60 * 1000;
let archive_store_instance: ArchiveStore | undefined;

function resolve_workspace_path(value: string) {
  return isAbsolute(value) ? value : join(repo_root, value);
}

function cache_root() {
  return resolve_workspace_path(env.KERNELARCHIVE_LOCAL_CACHE_DIR);
}

function index_path() {
  return join(cache_root(), "index.json");
}

// The read replicas must open exactly the file the writer opened, so resolve it
// here rather than repeating the env lookup at the call site.
export function archive_database_paths() {
  return { path: resolve_workspace_path(env.KERNELARCHIVE_DATA_DB_PATH), legacy_path: index_path() };
}

function archive_store() {
  archive_store_instance ??= new ArchiveStore(resolve_workspace_path(env.KERNELARCHIVE_DATA_DB_PATH), index_path());
  return archive_store_instance;
}

function stored_record<T>(collection: ArchiveCollection, id: string) {
  return archive_store().get(collection, id) as unknown as T | undefined;
}

function stored_collection<T>(collection: ArchiveCollection) {
  return archive_store().load_collection(collection) as unknown as T[];
}

function stored_children<T>(collection: ArchiveCollection, parent_id: string) {
  return archive_store().load_by_parent(collection, parent_id) as unknown as T[];
}

const parser_version_value = "pe-v2:7cd1d65304119514";

function parser_version() {
  return parser_version_value;
}

export function stale_parser_sha_set(): Set<string> {
  const current = parser_version();
  const stale = new Set<string>();
  for (const ingestion of stored_collection<BinaryIngestionRecord>("ingestions")) {
    if (ingestion.parser_version !== current) { stale.add(ingestion.sha256); }
  }
  return stale;
}

function ensure_cache() {
  mkdirSync(join(cache_root(), "binaries"), { recursive: true });
  mkdirSync(join(cache_root(), "symbols"), { recursive: true });
}

function safe_filename(filename: string) {
  const clean = basename(filename).replace(/[^a-zA-Z0-9._-]+/g, "_");
  return clean || "upload.bin";
}

export function read_local_index(): LocalIndex {
  ensure_cache();
  const now = Date.now();
  if (index_cache && now - index_cache_checked_at < index_stat_interval_ms) { return index_cache; }
  try {
    const store = archive_store();
    const revision = store.revision();
    if (index_cache && index_cache_revision === revision) {
      index_cache_checked_at = now;
      return index_cache;
    }
    const parsed = store.load() as unknown as ArchiveSnapshot;
    index_cache = {
      builds: parsed.builds as unknown as WindowsBuild[],
      modules: parsed.modules as unknown as KernelModule[],
      functions: parsed.functions as unknown as KernelFunction[],
      types: parsed.types as unknown as KernelType[],
      patterns: parsed.patterns as unknown as PatternResult[],
      pdb_lookups: parsed.pdb_lookups as unknown as PdbLookupCacheRecord[],
      ingestions: parsed.ingestions as unknown as BinaryIngestionRecord[],
      archive_files: parsed.archive_files as unknown as ArchiveFileRecord[],
    };
    index_cache_revision = revision;
    index_cache_checked_at = now;
    return index_cache;
  } catch (error) {
    console.error("Failed to read the archive database", error);
    index_cache = undefined;
    index_cache_revision = -1;
    index_cache_checked_at = 0;
    return empty_index;
  }
}

function apply_index_changes(index: LocalIndex, changes: Partial<LocalIndex>): LocalIndex {
  return {
    builds: changes.builds ? merge_by_id(changes.builds, index.builds) : index.builds,
    modules: changes.modules ? merge_by_id(changes.modules, index.modules) : index.modules,
    functions: changes.functions ? merge_by_id(changes.functions, index.functions) : index.functions,
    types: changes.types ? merge_by_id(changes.types, index.types) : index.types,
    patterns: changes.patterns ? merge_by_id(changes.patterns, index.patterns) : index.patterns,
    pdb_lookups: changes.pdb_lookups ? merge_by_id(changes.pdb_lookups, index.pdb_lookups) : index.pdb_lookups,
    ingestions: changes.ingestions ? merge_by_id(changes.ingestions, index.ingestions) : index.ingestions,
    archive_files: changes.archive_files ? merge_by_id(changes.archive_files, index.archive_files) : index.archive_files,
  };
}

function persist_local_changes(changes: Partial<LocalIndex>, options: { replace_module_id?: string } = {}) {
  ensure_cache();
  const store = archive_store();
  const result = options.replace_module_id
    ? store.replace_module(options.replace_module_id, changes as unknown as ArchiveChanges)
    : store.upsert(changes as unknown as ArchiveChanges);
  if (!options.replace_module_id && index_cache && index_cache_revision === result.previous_revision) {
    index_cache = apply_index_changes(index_cache, changes);
    index_cache_revision = result.revision;
    index_cache_checked_at = Date.now();
  } else {
    index_cache = undefined;
    index_cache_revision = -1;
    index_cache_checked_at = 0;
  }
}

export function invalidate_local_index_cache() {
  index_cache = undefined;
  index_cache_revision = -1;
  index_cache_checked_at = 0;
  module_page_cache.clear();
}

export function close_local_cache() {
  archive_store_instance?.close();
  archive_store_instance = undefined;
  index_cache = undefined;
  index_cache_revision = -1;
  index_cache_checked_at = 0;
  module_page_cache.clear();
}

function merge_by_id<T extends { id: string }>(left: T[], right: T[]) {
  const items = new Map<string, T>();
  for (const item of right) { items.set(item.id, item); }
  for (const item of left) { items.set(item.id, item); }
  return Array.from(items.values());
}

export function all_builds() {
  return stored_collection<WindowsBuild>("builds")
    .map((build) => normalize_windows_build(build))
    .filter((build) => is_supported_kernel_build(build));
}

export function all_modules() {
  const build_ids = new Set(all_builds().map((build) => build.id));
  return stored_collection<KernelModule>("modules")
    .filter((module) => build_ids.has(module.build_id))
    .map((module) => interpret_module_sections(module));
}

export function all_functions() {
  const modules = new Map(all_modules().map((module) => [module.id, module]));
  return stored_collection<KernelFunction>("functions").filter((fn) => {
    const module = modules.get(fn.module_id);
    return Boolean(module && is_exposed_function(fn, module));
  });
}

export function all_types() {
  const module_ids = new Set(all_modules().map((module) => module.id));
  return stored_collection<KernelType>("types").filter((type) => module_ids.has(type.module_id));
}

export function all_ingestions() {
  return stored_collection<BinaryIngestionRecord>("ingestions");
}

export function all_archive_files() {
  return stored_collection<ArchiveFileRecord>("archive_files");
}

export function find_archive_file_any(id: string) {
  return stored_record<ArchiveFileRecord>("archive_files", id);
}

export function find_archive_file_for_module_any(module_id: string) {
  const records = stored_children<ArchiveFileRecord>("archive_files", module_id);
  return records.reduce<ArchiveFileRecord | undefined>((latest, record) => !latest || record.updated_at > latest.updated_at ? record : latest, undefined);
}

export function find_build_record_any(id: string) {
  return stored_record<WindowsBuild>("builds", id);
}

export function find_ingestion_record_any(id: string) {
  return stored_record<BinaryIngestionRecord>("ingestions", id);
}

export interface ModuleBinaryFile {
  path: string;
  filename: string;
  size: number;
  modified_at: Date;
  sha256: string;
}

function downloadable_file(candidate: string, roots: string[]) {
  try {
    const canonical_candidate = realpathSync(resolve_workspace_path(candidate));
    const allowed = roots.some((root) => {
      const canonical_root = realpathSync(resolve(root));
      const child = relative(canonical_root, canonical_candidate);
      return child !== ".." && !child.startsWith(`..${sep}`) && !isAbsolute(child);
    });
    if (!allowed) { return undefined; }
    const file_stat = statSync(canonical_candidate);
    return file_stat.isFile() ? { path: canonical_candidate, stat: file_stat } : undefined;
  } catch {
    return undefined;
  }
}

export function module_binary_file_any(module: KernelModule): ModuleBinaryFile | undefined {
  ensure_cache();
  const archive_root = resolve_workspace_path(env.KERNELARCHIVE_ARCHIVE_DIR);
  const roots = [join(cache_root(), "binaries"), archive_root];
  const cached_file = module.source_path ? downloadable_file(module.source_path, roots) : undefined;
  if (cached_file) {
    return {
      path: cached_file.path,
      filename: safe_filename(module.name),
      size: cached_file.stat.size,
      modified_at: cached_file.stat.mtime,
      sha256: module.sha256,
    };
  }

  const archive_file = find_archive_file_for_module_any(module.id);
  const ingestion = archive_file?.ingestion_id ? find_ingestion_record_any(archive_file.ingestion_id) : undefined;
  const candidates = [
    ingestion?.cache_path,
    // cache_path and source_path are absolute paths recorded on the machine that
    // did the indexing, so neither resolves after the archive is copied elsewhere.
    // The cache is laid out as binaries/<sha256>/<name>, which can be rebuilt from
    // data we already have, so downloads survive a move.
    module.sha256 ? join(cache_root(), "binaries", module.sha256, safe_filename(module.name)) : undefined,
    archive_file && archive_file.status !== "missing" && archive_file.status !== "skipped"
      ? resolve(archive_root, archive_file.relative_path)
      : undefined,
  ];
  for (const candidate of candidates) {
    if (!candidate) { continue; }
    const file = downloadable_file(candidate, roots);
    if (file) {
      return {
        path: file.path,
        filename: safe_filename(module.name),
        size: file.stat.size,
        modified_at: file.stat.mtime,
        sha256: module.sha256,
      };
    }
  }
  return undefined;
}

export function module_pdb_status_any(module: KernelModule): ModulePdbStatus {
  const archive_file = find_archive_file_for_module_any(module.id);
  const ingestion = archive_file?.ingestion_id ? find_ingestion_record_any(archive_file.ingestion_id) : undefined;
  const has_reference = Boolean(module.debug?.pdb_identifier);
  const status: ModulePdbStatus["status"] = archive_file?.pdb_status
    ?? ingestion?.pdb_status
    ?? (!has_reference ? "no-debug-info" : module.type_count > 0 ? "cached" : "unchecked");
  const available = status === "cached" || status === "downloaded";
  const checking = archive_file?.status === "pending";
  const source_available = Boolean(archive_file && archive_file.status !== "missing" && archive_file.status !== "skipped");
  const can_retry = source_available && has_reference && !available;
  const provider = env.KERNELARCHIVE_SYMBOL_SERVER_URLS.includes("msdl.microsoft.com")
    ? "Microsoft Symbol Server"
    : "Configured symbol server";

  let message: string;
  if (checking) {
    message = `${provider} is being checked for this module's exact PDB.`;
  } else if (available) {
    message = "The matching PDB and extracted symbols are available in the shared server cache.";
  } else if (status === "missing") {
    message = `${provider} did not contain this exact PDB when it was last checked.`;
  } else if (status === "download-failed") {
    message = `The last request to ${provider} failed before the PDB could be cached.`;
  } else if (status === "no-debug-info") {
    message = "This Portable Executable has no CodeView PDB reference, so a matching PDB cannot be requested.";
  } else {
    message = `${provider} has not been checked for this module yet.`;
  }

  if (!checking && can_retry) { message += " Retry the lookup to check the configured server again."; }
  if (!checking && has_reference && !available && !source_available) { message += " Retry is unavailable because no active Archive source file is linked to this module."; }

  return {
    module_id: module.id,
    status,
    available,
    checking,
    can_retry,
    requires_admin: true,
    provider,
    pdb_name: has_reference ? module.pdb_name : undefined,
    pdb_identifier: module.debug?.pdb_identifier,
    symbol_url: ingestion?.symbol_url,
    last_checked_at: archive_file?.pdb_status ? archive_file.updated_at : ingestion?.created_at,
    message,
  };
}

export function list_ingestions_page(page: number, limit: number) {
  const safe_page = Math.max(1, page);
  const safe_limit = Math.max(1, limit);
  return archive_store().page("ingestions", (safe_page - 1) * safe_limit, safe_limit, true) as unknown as BinaryIngestionRecord[];
}

export function recent_archive_files(limit: number) {
  return archive_store().page("archive_files", 0, Math.max(1, limit), true) as unknown as ArchiveFileRecord[];
}

export function list_archive_files_page(page: number, limit: number, query = "", status = "", pdb_status = "") {
  const safe_page = Math.max(1, page);
  const safe_limit = Math.max(1, limit);
  const result = archive_store().archive_files_page((safe_page - 1) * safe_limit, safe_limit, query, status, pdb_status);
  return { items: result.items as unknown as ArchiveFileRecord[], total: result.total };
}

export function archive_file_stats() {
  const store = archive_store();
  const counts = store.archive_file_status_counts();
  return {
    total: store.count("archive_files"),
    indexed: counts.indexed ?? 0,
    cached: counts.cached ?? 0,
    skipped: counts.skipped ?? 0,
    failed: counts.failed ?? 0,
    pending: counts.pending ?? 0,
    missing: counts.missing ?? 0,
  };
}

export function cache_archive_files(records: ArchiveFileRecord[]) {
  if (records.length > 0) { persist_local_changes({ archive_files: records }); }
}

export function all_patterns() {
  return stored_collection<PatternResult>("patterns")
    .filter((pattern) => Boolean(find_function_any(pattern.function_id)));
}

export function module_summary(module: KernelModule, options: { include_sections?: boolean; include_pe_details?: boolean } = {}) {
  const summary = { ...module, binary_available: Boolean(module.source_path), function_count: archive_store().exposed_function_count(module.id) };
  delete summary.source_path;
  if (options.include_sections) {
    summary.sections = (module.sections ?? []).map((section) => {
      const section_summary = { ...section };
      delete section_summary.content;
      return section_summary;
    });
  } else {
    delete summary.sections;
  }
  if (!options.include_pe_details) {
    delete summary.imports;
    delete summary.exports;
    delete summary.debug;
  }
  return summary;
}

export function module_summaries() {
  return all_modules().map((module) => module_summary(module));
}

// /api/v1/system/current is anonymous and used to rebuild this on every call,
// parsing every module payload in the archive to return one build's worth. That
// is tens of seconds of synchronous work per request on a single event loop, so
// one unauthenticated client could hold the whole API down. The answer only
// changes when the store does, so key it on the revision.
let current_system_cache: { revision: number; value: { build: WindowsBuild; modules: ReturnType<typeof module_summary>[]; generated_from: string } | undefined } | undefined;

export function current_system_index() {
  const revision = archive_store().revision();
  if (current_system_cache && current_system_cache.revision === revision) { return current_system_cache.value; }
  const build = all_builds()[0];
  // Built from the indexed per-build page query rather than all_modules(), which
  // parsed every module payload in the archive just to keep one build's worth. That
  // made the first call after any write cost over a minute of blocking work.
  const value = build
    ? {
      build,
      modules: archive_store().module_summaries_page(build.id, 0, 100000).items
        .map((module) => module_summary(module as unknown as KernelModule)),
      generated_from: "local-system",
    }
    : undefined;
  current_system_cache = { revision, value };
  return value;
}

export function cache_stats() {
  const store = archive_store();
  return {
    builds: store.count("builds"),
    modules: store.count("modules"),
    functions: store.exposed_function_total(),
    types: store.count("types"),
    patterns: store.count("patterns"),
    ingestions: store.count("ingestions"),
  };
}

export function cache_database_stats() {
  const store = archive_store();
  return { path: store.path, revision: store.revision() };
}

export function warm_local_cache() {
  const started_at = performance.now();
  const stats = cache_stats();
  return {
    builds: stats.builds,
    modules: stats.modules,
    functions: stats.functions,
    types: stats.types,
    duration_ms: Math.round((performance.now() - started_at) * 100) / 100,
  };
}

export function find_build_any(id: string) {
  const build = stored_record<WindowsBuild>("builds", id);
  if (!build) { return undefined; }
  const normalized = normalize_windows_build(build);
  return is_supported_kernel_build(normalized) ? normalized : undefined;
}

export function find_module_any(id: string) {
  const module = stored_record<KernelModule>("modules", id);
  return module && find_build_any(module.build_id) ? interpret_module_sections(module) : undefined;
}

export function find_function_any(id: string) {
  const fn = stored_record<KernelFunction>("functions", id);
  if (!fn) { return undefined; }
  const module = find_module_any(fn.module_id);
  return module && is_exposed_function(fn, module) ? fn : undefined;
}

export function find_type_any(id: string) {
  const type = stored_record<KernelType>("types", id);
  return type && find_module_any(type.module_id) ? type : undefined;
}

export function find_pattern_any(id: string) {
  const pattern = stored_record<PatternResult>("patterns", id);
  return pattern && find_function_any(pattern.function_id) ? pattern : undefined;
}

export function list_modules_for_build_any(build_id: string) {
  return stored_children<KernelModule>("modules", build_id).map((module) => interpret_module_sections(module));
}

export function list_modules_by_name_any(name: string) {
  return archive_store().load_by_name("modules", name)
    .map((module) => interpret_module_sections(module as unknown as KernelModule))
    .filter((module) => Boolean(find_build_any(module.build_id)));
}

export function list_modules_by_pdb_name_any(pdb_name: string) {
  return archive_store().load_modules_by_pdb_name(pdb_name)
    .map((module) => interpret_module_sections(module as unknown as KernelModule))
    .filter((module) => Boolean(find_build_any(module.build_id)));
}

export function list_modules_for_build_page_any(build_id: string, page: number, limit: number, query = "") {
  const safe_page = Math.max(1, page);
  const safe_limit = Math.min(100, Math.max(1, limit));
  const normalized_query = query.trim().toLowerCase();
  const cache_key = `${build_id}\u0000${normalized_query}\u0000${safe_page}\u0000${safe_limit}`;
  const store = archive_store();
  const revision = store.module_revision(build_id);
  const now = Date.now();
  const cached = module_page_cache.get(cache_key);
  if (cached && cached.revision === revision && cached.expires_at > now) {
    module_page_cache.delete(cache_key);
    module_page_cache.set(cache_key, cached);
    return { items: cached.items, total: cached.total, cache_hit: true };
  }
  if (cached) { module_page_cache.delete(cache_key); }

  const result = store.module_summaries_page(build_id, (safe_page - 1) * safe_limit, safe_limit, normalized_query);
  const entry = { expires_at: now + module_page_cache_ttl_ms, items: result.items as unknown as KernelModule[], revision, total: result.total };
  module_page_cache.set(cache_key, entry);
  while (module_page_cache.size > module_page_cache_limit) {
    const oldest = module_page_cache.keys().next().value;
    if (!oldest) { break; }
    module_page_cache.delete(oldest);
  }
  return { items: entry.items, total: entry.total, cache_hit: false };
}

// Recomputed per call this drove /builds/catalog to ~85ms, dominated by a correlated
// function_count subquery, on a route the explorer, build page and module page all hit.
// The counts only move when the store does, so key them on the revision.
type ModuleCountsEntry = ReturnType<ArchiveStore["module_counts_by_build"]>[number];
let module_counts_cache: { revision: number; value: Map<string, ModuleCountsEntry> } | undefined;

export function module_counts_by_build_any() {
  const revision = archive_store().revision();
  if (module_counts_cache && module_counts_cache.revision === revision) { return module_counts_cache.value; }
  const value = new Map(archive_store().module_counts_by_build().map((counts) => [counts.build_id, counts]));
  module_counts_cache = { revision, value };
  return value;
}

export function list_functions_for_module_any(module_id: string) {
  const module = find_module_any(module_id);
  return stored_children<KernelFunction>("functions", module_id)
    .filter((fn) => is_exposed_function(fn, module))
    .sort((left, right) => Number(right.is_exported) - Number(left.is_exported) || left.name.localeCompare(right.name) || left.rva.localeCompare(right.rva) || left.id.localeCompare(right.id));
}

export function list_functions_for_module_page_any(module_id: string, page: number, limit: number, query = "") {
  const safe_page = Math.max(1, page);
  const safe_limit = Math.min(100, Math.max(1, limit));
  const result = archive_store().module_symbols_page("functions", module_id, (safe_page - 1) * safe_limit, safe_limit, query);
  return { items: result.items as unknown as KernelFunction[], total: result.total };
}

export function list_functions_by_name_any(name: string) {
  return archive_store().load_by_name("functions", name) as unknown as KernelFunction[];
}

export function list_types_by_name_any(name: string) {
  return archive_store().load_by_name("types", name) as unknown as KernelType[];
}

export function list_types_by_name_and_module_name_any(name: string, module_name: string) {
  return archive_store().load_types_by_name_and_module_name(name, module_name) as unknown as KernelType[];
}

export function list_types_for_module_any(module_id: string) {
  return stored_children<KernelType>("types", module_id)
    .sort((left, right) => Number(left.name.startsWith("<")) - Number(right.name.startsWith("<")) || left.name.localeCompare(right.name) || left.id.localeCompare(right.id));
}

export function list_types_for_module_page_any(module_id: string, page: number, limit: number, query = "") {
  const safe_page = Math.max(1, page);
  const safe_limit = Math.min(100, Math.max(1, limit));
  const result = archive_store().module_symbols_page("types", module_id, (safe_page - 1) * safe_limit, safe_limit, query);
  return { items: result.items as unknown as KernelType[], total: result.total };
}

// The distinct-name count for a build touches every type row it owns, which is
// seconds on a cold page cache. Only the unfiltered total is reused often enough
// to cache, and it is invalidated whenever the store revision moves.
const build_type_totals = new Map<string, { revision: number; total: number }>();

// The rows half is just as expensive as the count: it groups every type row the
// build owns to return one page. Repeat views were paying that in full, including
// the limit=1 request the module page fires purely to read the tab badge total.
const build_type_page_cache = new Map<string, { items: KernelType[]; revision: number; total: number }>();
const build_type_page_cache_limit = 256;

export function list_types_for_build_page_any(build_id: string, page: number, limit: number, query = "") {
  const safe_page = Math.max(1, page);
  const safe_limit = Math.min(100, Math.max(1, limit));
  const store = archive_store();
  const normalized_query = query.trim();
  const revision = store.revision();
  const cache_key = `${build_id} ${normalized_query.toLowerCase()} ${safe_page} ${safe_limit}`;
  const cached_page = build_type_page_cache.get(cache_key);
  if (cached_page && cached_page.revision === revision) {
    build_type_page_cache.delete(cache_key);
    build_type_page_cache.set(cache_key, cached_page);
    return { items: cached_page.items, total: cached_page.total };
  }
  if (cached_page) { build_type_page_cache.delete(cache_key); }

  const cached = normalized_query ? undefined : build_type_totals.get(build_id);
  const result = store.build_types_page(build_id, (safe_page - 1) * safe_limit, safe_limit, query, cached?.revision === revision ? cached.total : undefined);
  if (!normalized_query) { build_type_totals.set(build_id, { revision, total: result.total }); }
  const items = result.items as unknown as KernelType[];
  build_type_page_cache.set(cache_key, { items, revision, total: result.total });
  while (build_type_page_cache.size > build_type_page_cache_limit) {
    const oldest = build_type_page_cache.keys().next().value;
    if (!oldest) { break; }
    build_type_page_cache.delete(oldest);
  }
  return { items, total: result.total };
}

export function function_matches_query_any(fn: KernelFunction, query: string) {
  return `${fn.name} ${fn.rva} ${function_signature(fn)}`.toLowerCase().includes(query.toLowerCase());
}

export function type_matches_query_any(type: KernelType, query: string) {
  return `${type.name} ${type.kind} ${type.fields.map((field) => `${field.name} ${field.field_type_name} ${String(field.flags_json.enum_value ?? "")}`).join(" ")}`.toLowerCase().includes(query.toLowerCase());
}

function reference_build_ids() {
  return all_builds().map((build) => build.id);
}

export function type_reference_counts_any(type_id: string) {
  const type = find_type_any(type_id);
  if (!type) { return { fields: 0, functions: 0 }; }
  return archive_store().type_reference_counts(type.name, type.id, reference_build_ids());
}

export function list_field_references_for_type_page_any(type_id: string, page: number, limit: number, query = "") {
  const type = find_type_any(type_id);
  if (!type) { return { items: [] as TypeFieldReference[], total: 0 }; }
  const safe_page = Math.max(1, page);
  const safe_limit = Math.min(100, Math.max(1, limit));
  const result = archive_store().type_field_references_page(type.name, type.id, reference_build_ids(), (safe_page - 1) * safe_limit, safe_limit, query);
  const items: TypeFieldReference[] = result.items.map((entry) => {
    const build = normalize_windows_build(entry.build as unknown as WindowsBuild);
    const module = entry.module as unknown as KernelModule;
    const source_type = entry.type as unknown as KernelType;
    const field = entry.field as unknown as KernelType["fields"][number];
    return {
      build_id: build.id,
      build_label: build_display_label(build),
      module_id: module.id,
      module_name: module.name,
      type_id: source_type.id,
      type_name: source_type.name,
      type_kind: source_type.kind,
      field_id: field.id,
      field_name: field.name,
      field_type_name: field.field_type_name,
      offset_bits: field.offset_bits,
    };
  });
  return { items, total: result.total };
}

export function list_function_references_for_type_page_any(type_id: string, page: number, limit: number, query = "") {
  const type = find_type_any(type_id);
  if (!type) { return { items: [] as TypeFunctionReference[], total: 0 }; }
  const safe_page = Math.max(1, page);
  const safe_limit = Math.min(100, Math.max(1, limit));
  const result = archive_store().type_function_references_page(type.name, reference_build_ids(), (safe_page - 1) * safe_limit, safe_limit, query);
  const items: TypeFunctionReference[] = result.items.map((entry) => {
    const build = normalize_windows_build(entry.build as unknown as WindowsBuild);
    const module = entry.module as unknown as KernelModule;
    const fn = entry.function as unknown as KernelFunction;
    return {
      build_id: build.id,
      build_label: build_display_label(build),
      module_id: module.id,
      module_name: module.name,
      function_id: fn.id,
      function_name: fn.name,
      signature: function_signature(fn),
      rva: fn.rva,
    };
  });
  return { items, total: result.total };
}

export function find_pattern_for_function_any(function_id: string, binary_sha256?: string): PatternResult | undefined {
  if (!find_function_any(function_id)) { return undefined; }
  return stored_children<PatternResult>("patterns", function_id).find((pattern) => !binary_sha256 || pattern.binary_sha256 === binary_sha256);
}

export function forget_pattern_for_function_any(function_id: string, binary_sha256?: string) {
  const removed = archive_store().remove_patterns_for_function(function_id, binary_sha256);
  if (removed > 0) {
    index_cache = undefined;
    index_cache_revision = -1;
    index_cache_checked_at = 0;
  }
  return removed;
}

export function cache_pattern_results(patterns: PatternResult[]) {
  const unique_patterns = merge_by_id(patterns, []).filter((pattern) => Boolean(find_function_any(pattern.function_id)));
  if (unique_patterns.length === 0) { return unique_patterns; }
  const functions = unique_patterns.flatMap((pattern) => {
    const fn = find_function_any(pattern.function_id);
    return fn ? [{ ...fn, has_pattern: true }] : [];
  });
  persist_local_changes({ patterns: unique_patterns, functions });
  return unique_patterns;
}

export function cache_pattern_result(pattern: PatternResult) {
  cache_pattern_results([pattern]);
  return pattern;
}

export function get_or_create_pattern(module: KernelModule, fn: KernelFunction, binary_sha256: string, create_pattern: () => PatternResult, options: { prefer_multi_build?: boolean } = {}) {
  const cached = find_pattern_for_function_any(fn.id, binary_sha256);
  if (cached) {
    const local_target_count = options.prefer_multi_build
      ? list_pattern_targets_any(fn).filter((target) => target.module?.source_path && target.fn).length
      : 0;
    const is_multi_build_pattern = cached.tested_builds_json.length > 1 && !cached.format.startsWith("ida-per-build");
    const checked_current_targets = cached.format === "ida-per-build-checked-v2" && cached.tested_builds_json.length >= local_target_count;
    if (!options.prefer_multi_build || local_target_count < 2 || is_multi_build_pattern || checked_current_targets) {
      return { pattern: cached, source: "pattern-cache" };
    }
  }
  return { pattern: cache_pattern_result(create_pattern()), source: "local-binary" };
}

export function list_pattern_targets_any(fn: KernelFunction): PatternCrossReferenceTarget[] {
  const source_module = find_module_any(fn.module_id);
  const module_name = source_module?.name ?? fn.module_id;
  const normalized_module_name = module_name.toLowerCase();
  const normalized_pdb_name = source_module?.pdb_name.toLowerCase() ?? "";
  const modules = list_modules_by_name_any(module_name);
  const module_ids = new Set(modules.map((module) => module.id));
  if (source_module?.pdb_name) {
    for (const module of list_modules_by_pdb_name_any(source_module.pdb_name)) {
      if (!module_ids.has(module.id)) {
        modules.push(module);
        module_ids.add(module.id);
      }
    }
  }

  const modules_by_build = new Map<string, KernelModule>();
  const modules_by_id = new Map<string, KernelModule>();
  for (const module of modules) {
    const matches_name = module.name.toLowerCase() === normalized_module_name;
    const matches_pdb = normalized_pdb_name.length > 0 && module.pdb_name.toLowerCase() === normalized_pdb_name;
    if (matches_name || matches_pdb) { modules_by_id.set(module.id, module); }
    if ((matches_name || matches_pdb) && !modules_by_build.has(module.build_id)) {
      modules_by_build.set(module.build_id, module);
    }
  }

  // Identical binaries are indexed once, so a build's module record can be an
  // alias that owns no symbol rows. Key matches by sha256 as well as module id
  // or those builds look unindexed when the symbols are present.
  const functions_by_module = new Map<string, KernelFunction>();
  const functions_by_sha256 = new Map<string, KernelFunction>();
  for (const candidate of list_functions_by_name_any(fn.name)) {
    const module = modules_by_id.get(candidate.module_id);
    if (!module || !is_exposed_function(candidate, module)) { continue; }
    if (!functions_by_module.has(candidate.module_id)) {
      functions_by_module.set(candidate.module_id, candidate);
    }
    if (module.sha256 && !functions_by_sha256.has(module.sha256)) {
      functions_by_sha256.set(module.sha256, candidate);
    }
  }

  return all_builds().map((build) => {
    const module = modules_by_build.get(build.id);
    const matched_function = module
      ? functions_by_module.get(module.id) ?? (module.sha256 ? functions_by_sha256.get(module.sha256) : undefined)
      : undefined;
    const stored_pattern = matched_function ? find_pattern_for_function_any(matched_function.id, module?.sha256) : undefined;
    return {
      build,
      build_label: build_display_label(build),
      module_name,
      module,
      fn: matched_function,
      stored_pattern,
    };
  });
}

function symbol_servers() {
  return env.KERNELARCHIVE_SYMBOL_SERVER_URLS.split(/[;,]/).map((item) => item.trim()).filter(Boolean);
}

function pdb_lookup_id(pdb_name: string, pdb_identifier: string) {
  return `pdb_${id_part(pdb_name)}_${id_part(pdb_identifier)}`;
}

function find_cached_pdb_lookup(pdb_name: string, pdb_identifier: string) {
  const result = stored_record<PdbLookupCacheRecord>("pdb_lookups", pdb_lookup_id(pdb_name, pdb_identifier));
  return result?.pdb_name === pdb_name && result.pdb_identifier === pdb_identifier ? result : undefined;
}

function cache_pdb_lookup(result: PdbLookupResult) {
  if (!result.pdb_name || !result.pdb_identifier) { return result; }
  const existing = find_cached_pdb_lookup(result.pdb_name, result.pdb_identifier);
  const now = new Date().toISOString();
  const record: PdbLookupCacheRecord = {
    ...result,
    id: pdb_lookup_id(result.pdb_name, result.pdb_identifier),
    created_at: existing?.created_at ?? now,
    updated_at: now,
  };
  persist_local_changes({ pdb_lookups: [record] });
  return result;
}

class PdbDownloadError extends Error {
  readonly status_code: number;

  constructor(status_code: number) {
    super(`HTTP ${status_code}`);
    this.status_code = status_code;
  }
}

function download_file(url: string, destination: string, redirect_count = 0) {
  return new Promise<void>((resolve, reject) => {
    if (redirect_count > 5) {
      reject(new Error("Too many PDB download redirects"));
      return;
    }
    let parsed_url: URL;
    try {
      parsed_url = new URL(url);
    } catch {
      reject(new Error("Invalid PDB download URL"));
      return;
    }
    if (parsed_url.protocol !== "https:" && parsed_url.protocol !== "http:") {
      reject(new Error("Unsupported PDB download protocol"));
      return;
    }
    mkdirSync(dirname(destination), { recursive: true });
    const temporary = `${destination}.${process.pid}.${randomUUID().slice(0, 8)}.partial`;
    const client = url.startsWith("https:") ? https_get : http_get;
    const request = client(url, (response) => {
      if (response.statusCode && response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
        response.resume();
        download_file(new URL(response.headers.location, parsed_url).toString(), destination, redirect_count + 1).then(resolve, reject);
        return;
      }
      if (response.statusCode !== 200) {
        response.resume();
        reject(new PdbDownloadError(response.statusCode ?? 0));
        return;
      }
      const content_length = Number(response.headers["content-length"] ?? 0);
      if (Number.isFinite(content_length) && content_length > env.UPLOAD_MAX_BYTES) {
        response.resume();
        reject(new Error("PDB download exceeds the configured size limit"));
        return;
      }
      const stream = createWriteStream(temporary);
      let received = 0;
      const fail = (error: Error) => {
        stream.destroy();
        if (existsSync(temporary)) { unlinkSync(temporary); }
        reject(error);
      };
      response.on("data", (chunk: Buffer) => {
        received += chunk.length;
        if (received > env.UPLOAD_MAX_BYTES) {
          response.destroy(new Error("PDB download exceeds the configured size limit"));
        }
      });
      response.pipe(stream);
      stream.on("finish", () => {
        stream.close();
        renameSync(temporary, destination);
        resolve();
      });
      stream.on("error", (error) => fail(error));
      response.on("error", (error) => fail(error));
    });
    request.setTimeout(env.PDB_DOWNLOAD_TIMEOUT_MS, () => {
      request.destroy(new Error("PDB download timed out"));
    });
    request.on("error", (error) => {
      if (existsSync(temporary)) { unlinkSync(temporary); }
      reject(error);
    });
  });
}

async function lookup_pdb_uncached(module: KernelModule, force_retry = false): Promise<PdbLookupResult> {
  if (!module.debug?.pdb_identifier || !module.pdb_name) {
    return { status: "no-debug-info", message: "No CodeView PDB record was found in the uploaded PE." };
  }

  const cache_path = join(cache_root(), "symbols", module.pdb_name, module.debug.pdb_identifier, module.pdb_name);
  const servers = symbol_servers();
  const symbol_url = `${servers[0]?.replace(/\/+$/, "")}/${module.pdb_name}/${module.debug.pdb_identifier}/${module.pdb_name}`;
  if (existsSync(cache_path)) {
    return cache_pdb_lookup({
      status: "cached",
      pdb_name: module.pdb_name,
      pdb_identifier: module.debug.pdb_identifier,
      symbol_url,
      cache_path,
      message: "Matching PDB is already present in the local symbol cache.",
    });
  }

  const cached = find_cached_pdb_lookup(module.pdb_name, module.debug.pdb_identifier);
  if (!force_retry && (cached?.status === "download-failed" || cached?.status === "missing")) {
    const failed_at = Date.parse(cached.updated_at);
    const retry_after = env.PDB_FAILURE_CACHE_MINUTES * 60 * 1000;
    if (Number.isFinite(failed_at) && Date.now() - failed_at < retry_after) {
      return {
        status: cached.status,
        pdb_name: cached.pdb_name,
        pdb_identifier: cached.pdb_identifier,
        symbol_url: cached.symbol_url,
        cache_path: cached.cache_path,
        message: `Cached previous PDB lookup failure: ${cached.message}`,
      };
    }
  }

  const errors: string[] = [];
  let all_missing = servers.length > 0;
  for (const server of servers) {
    const url = `${server.replace(/\/+$/, "")}/${module.pdb_name}/${module.debug.pdb_identifier}/${module.pdb_name}`;
    try {
      await download_file(url, cache_path);
      return cache_pdb_lookup({
        status: "downloaded",
        pdb_name: module.pdb_name,
        pdb_identifier: module.debug.pdb_identifier,
        symbol_url: url,
        cache_path,
        message: "Matching PDB was downloaded into the local symbol cache.",
      });
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
      if (!(error instanceof PdbDownloadError && error.status_code === 404)) { all_missing = false; }
    }
  }

  return cache_pdb_lookup({
    status: all_missing ? "missing" : "download-failed",
    pdb_name: module.pdb_name,
    pdb_identifier: module.debug.pdb_identifier,
    symbol_url,
    cache_path,
    message: all_missing ? "Matching PDB was not found on the configured symbol servers." : errors.join("; ") || "PDB download failed.",
  });
}

async function lookup_pdb(module: KernelModule, force_retry = false): Promise<PdbLookupResult> {
  const identifier = module.debug?.pdb_identifier;
  if (!identifier || !module.pdb_name) { return lookup_pdb_uncached(module, force_retry); }
  const key = `${module.pdb_name.toLowerCase()}:${identifier.toLowerCase()}:${force_retry ? "retry" : "normal"}`;
  const running = pdb_lookup_inflight.get(key);
  if (running) { return running; }
  const lookup = lookup_pdb_uncached(module, force_retry);
  pdb_lookup_inflight.set(key, lookup);
  try {
    return await lookup;
  } finally {
    if (pdb_lookup_inflight.get(key) === lookup) { pdb_lookup_inflight.delete(key); }
  }
}

function build_from_file(parsed: ReturnType<typeof parse_pe>, options: IngestOptions, sha256: string, created_at: string) {
  let source: BuildDetectionSource = "timestamp-fallback";
  const explicit_build_number = options.build_number?.trim() ?? "";
  const explicit_revision = options.revision?.trim() ?? "";
  const explicit_version = options.version?.trim() ?? "";
  const explicit_product_name = options.product_name?.trim() ?? "";
  let build_number = explicit_build_number;
  let revision = explicit_revision;
  let version = explicit_version;
  let product_name = explicit_product_name;

  if (build_number && revision) {
    source = "manual";
  } else if (parsed.version) {
    source = "version-resource";
    build_number = String(parsed.version.build);
    revision = String(parsed.version.revision);
    version = parsed.version.file_version;
  } else {
    build_number = `timestamp_${hex(parsed.timestamp).slice(2)}`;
    revision = sha256.slice(0, 8);
    version = "undetected";
  }

  if (!product_name) {
    product_name = parsed.version ? parsed.version.product_version : `sha256_${sha256.slice(0, 12)}`;
  }
  if (!version && parsed.version) {
    version = parsed.version.file_version;
  }

  const detected_identity: WindowsBuild = {
    id: "",
    product_name,
    version: version || "undetected",
    build_number,
    revision,
    architecture: options.architecture ?? parsed.architecture,
    release_channel: "local-upload",
    published: true,
    created_at,
  };
  const normalized_identity = source === "timestamp-fallback" ? detected_identity : {
    ...detected_identity,
    product_name: explicit_product_name || windows_product_label(detected_identity),
    version: explicit_version || windows_release_label(detected_identity),
  };
  const build: WindowsBuild = {
    ...normalized_identity,
    id: `build_${id_part(normalized_identity.product_name)}_${id_part(normalized_identity.build_number)}_${id_part(normalized_identity.revision)}_${normalized_identity.architecture}`,
  };

  return { build, source };
}

function shape_search_result(result: ReturnType<ArchiveStore["search"]>) {
  const items: SearchResult[] = result.items.map((row) => {
    const kind: SearchResult["kind"] = row.collection === "modules" ? "module" : row.collection === "functions" ? "function" : "type";
    const route = kind === "module" ? "modules" : kind === "function" ? "functions" : "types";
    const architecture = row.architecture === "arm64" || row.architecture === "x86" || row.architecture === "x64" ? row.architecture : "x64";
    return {
      id: row.id,
      kind,
      name: row.name,
      module: row.module_name ?? row.name,
      build_id: row.build_id ?? undefined,
      build: row.build_number ?? row.build_id ?? "unknown",
      architecture,
      api_url: `/api/v1/${route}/${row.id}`,
      web_url: `/${route}/${row.id}`,
      score: Number(row.score),
    };
  });
  return { items, total: result.total };
}

// Search is the most I/O-heavy read in the archive, so it runs on a replica when
// one is available and falls back to the main thread when the pool is down.
export async function search_page_async(query: string, page: number, limit: number, filters: ArchiveSearchFilters = {}) {
  const safe_page = Math.max(1, page);
  const safe_limit = Math.max(1, limit);
  const search_filters = { ...filters, eligible_build_ids: all_builds().map((build) => build.id) };
  if (archive_read_pool_ready()) {
    try {
      const result = await run_archive_read<ReturnType<ArchiveStore["search"]>>({
        kind: "search",
        query,
        offset: (safe_page - 1) * safe_limit,
        limit: safe_limit,
        filters: search_filters,
      });
      return shape_search_result(result);
    } catch (error) {
      // A saturated pool must not fall back to the main thread: running the query
      // inline would stall every other request, which is the failure the pool exists
      // to prevent. Only a dead pool justifies an inline read.
      if (error instanceof ArchiveReadBusyError) { throw error; }
    }
  }
  return search_page(query, page, limit, filters);
}

export function search_page(query: string, page: number, limit: number, filters: ArchiveSearchFilters = {}) {
  const safe_page = Math.max(1, page);
  const safe_limit = Math.max(1, limit);
  const result = archive_store().search(query, (safe_page - 1) * safe_limit, safe_limit, {
    ...filters,
    eligible_build_ids: all_builds().map((build) => build.id),
  });
  return shape_search_result(result);
}

export function search_all(query: string) {
  return search_page(query, 1, 100).items;
}

function options_match_build(options: IngestOptions, build: WindowsBuild) {
  const values: Array<[string | undefined, string]> = [
    [options.product_name, build.product_name],
    [options.version, build.version],
    [options.build_number, build.build_number],
    [options.revision, build.revision],
    [options.architecture, build.architecture],
  ];
  return values.every(([requested, stored]) => !requested?.trim() || requested.trim() === stored);
}

function cached_ingestion_result(sha256: string, options: IngestOptions): BinaryIngestionResult | undefined {
  const store = archive_store();
  const ingestion = stored_record<BinaryIngestionRecord>("ingestions", `ingest_${sha256.slice(0, 16)}`);
  if (!ingestion || ingestion.sha256 !== sha256) { return undefined; }
  if (ingestion.parser_version !== parser_version()) { return undefined; }
  const build = stored_record<WindowsBuild>("builds", ingestion.build_id);
  const module = stored_record<KernelModule>("modules", ingestion.module_id);
  if (!build || !module || !options_match_build(options, build)) { return undefined; }

  let pdb_lookup: PdbLookupResult;
  if (options.force_pdb_retry) { return undefined; }
  if (ingestion.pdb_status === "no-debug-info") {
    pdb_lookup = {
      status: "no-debug-info",
      message: "The cached binary has no CodeView PDB record.",
    };
  } else if (ingestion.pdb_status === "download-failed" || ingestion.pdb_status === "missing") {
    if (!module.debug?.pdb_identifier || !module.pdb_name) { return undefined; }
    const lookup = find_cached_pdb_lookup(module.pdb_name, module.debug.pdb_identifier);
    const failed_at = Date.parse(lookup?.updated_at ?? "");
    if (!lookup || !Number.isFinite(failed_at) || Date.now() - failed_at >= env.PDB_FAILURE_CACHE_MINUTES * 60 * 1000) { return undefined; }
    pdb_lookup = {
      status: lookup.status,
      pdb_name: lookup.pdb_name,
      pdb_identifier: lookup.pdb_identifier,
      symbol_url: lookup.symbol_url,
      cache_path: lookup.cache_path,
      message: `Loaded the cached PDB lookup result; retry is deferred for ${env.PDB_FAILURE_CACHE_MINUTES} minutes.`,
    };
  } else {
    if (!module.debug?.pdb_identifier || !module.pdb_name) { return undefined; }
    const lookup = find_cached_pdb_lookup(module.pdb_name, module.debug.pdb_identifier);
    if (!lookup?.cache_path || !existsSync(lookup.cache_path) || (lookup.status !== "cached" && lookup.status !== "downloaded")) { return undefined; }
    pdb_lookup = {
      status: "cached",
      pdb_name: lookup.pdb_name,
      pdb_identifier: lookup.pdb_identifier,
      symbol_url: lookup.symbol_url,
      cache_path: lookup.cache_path,
      message: "Binary, PDB, functions, and types were loaded from the persistent local cache.",
    };
  }

  const build_detection_source = ingestion.build_detection_source ?? (build.build_number.startsWith("timestamp_") ? "timestamp-fallback" : "version-resource");
  return {
    ingestion: { ...ingestion, pdb_status: pdb_lookup.status },
    build: normalize_windows_build(build),
    module: interpret_module_sections(module),
    function_count: store.exposed_function_count(module.id),
    type_count: store.count("types", module.id),
    pdb_lookup,
    build_detection_source,
    manual_identification_required: build_detection_source === "timestamp-fallback",
    cache_hit: true,
  };
}

export function find_cached_binary_any(sha256: string, options: IngestOptions = {}) {
  return cached_ingestion_result(sha256.toLowerCase(), options);
}

function ingestion_request_key(sha256: string, options: IngestOptions) {
  return [sha256, options.product_name?.trim() ?? "", options.version?.trim() ?? "", options.build_number?.trim() ?? "", options.revision?.trim() ?? "", options.architecture ?? "", options.force_pdb_retry ? "retry" : "normal"].join(":");
}

async function ingest_binary_uncached(filename: string, data: Buffer, options: IngestOptions, sha256: string): Promise<BinaryIngestionResult> {
  const created_at = new Date().toISOString();
  const parsed = parse_pe(data);
  const stored_filename = safe_filename(filename);
  const binary_dir = join(cache_root(), "binaries", sha256);
  const cache_path = join(binary_dir, stored_filename);
  mkdirSync(binary_dir, { recursive: true });
  writeFileSync(cache_path, data);

  const { build, source } = build_from_file(parsed, options, sha256, created_at);
  const module = build_module_from_pe(cache_path, data, parsed, build.id, created_at);
  const pdb_lookup = await lookup_pdb(module, options.force_pdb_retry);
  const pdb_dump_path = resolve_workspace_path(env.KERNELARCHIVE_PDB_DUMP_PATH);
  const dia_dll_path = resolve_workspace_path(env.KERNELARCHIVE_DIA_DLL_PATH);
  const pdb_data = pdb_lookup.cache_path && existsSync(pdb_lookup.cache_path) && existsSync(pdb_dump_path) && existsSync(dia_dll_path)
    ? await extract_pdb_data(module, pdb_lookup.cache_path, pdb_dump_path, dia_dll_path, build.build_number, build.architecture)
    : { types: [], functions: [] };
  const export_functions = build_function_records(module, created_at);
  const functions_by_location = new Map(export_functions.map((fn) => [`${fn.rva.toLowerCase()}:${fn.name.toLowerCase()}`, fn]));
  for (const fn of pdb_data.functions) { functions_by_location.set(`${fn.rva.toLowerCase()}:${fn.name.toLowerCase()}`, fn); }
  const indexed_functions = Array.from(functions_by_location.values()).filter((fn) => is_exposed_function(fn, module));
  const module_with_symbols = {
    ...module,
    type_count: pdb_data.types.length,
    function_count: indexed_functions.length,
  };
  const ingestion: BinaryIngestionRecord = {
    id: `ingest_${sha256.slice(0, 16)}`,
    filename: stored_filename,
    sha256,
    cache_path,
    build_id: build.id,
    module_id: module_with_symbols.id,
    module_name: module_with_symbols.name,
    build_label: build_display_label(build),
    architecture: build.architecture,
    pdb_status: pdb_lookup.status,
    build_detection_source: source,
    parser_version: parser_version(),
    symbol_url: pdb_lookup.symbol_url,
    created_at,
  };

  persist_local_changes({
    builds: [build],
    modules: [module_with_symbols],
    functions: indexed_functions,
    types: pdb_data.types,
    ingestions: [ingestion],
  }, { replace_module_id: module_with_symbols.id });

  return {
    ingestion,
    build,
    module: module_with_symbols,
    function_count: indexed_functions.length,
    type_count: pdb_data.types.length,
    pdb_lookup,
    build_detection_source: source,
    manual_identification_required: source === "timestamp-fallback",
    cache_hit: false,
  };
}

export async function ingest_binary(filename: string, data: Buffer, options: IngestOptions = {}): Promise<BinaryIngestionResult> {
  ensure_cache();
  const sha256 = createHash("sha256").update(data).digest("hex");
  const cached = cached_ingestion_result(sha256, options);
  if (cached) { return cached; }

  const key = ingestion_request_key(sha256, options);
  const running = ingestion_inflight.get(key);
  if (running) { return running; }

  const request = ingest_binary_uncached(filename, data, options, sha256);
  ingestion_inflight.set(key, request);
  try {
    return await request;
  } finally {
    if (ingestion_inflight.get(key) === request) { ingestion_inflight.delete(key); }
  }
}
