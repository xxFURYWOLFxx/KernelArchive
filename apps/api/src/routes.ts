import { createReadStream } from "node:fs";
import { Readable } from "node:stream";
import type { FastifyInstance } from "fastify";
import { zip_entries, type ZipEntry } from "./zip-stream";
import {
  build_display_label,
  generate_offset_header,
  is_export_in_executable_section,
  is_function_in_executable_section,
  pattern_request_schema,
  pagination_query_schema,
  search_query_schema,
} from "@kernelarchive/shared";
import type { DiffResult, KernelFunction, KernelModule, KernelType, KernelTypeSummary, TypeCompareLine, TypeCompareOccurrence, TypeCompareResult, WindowsBuild } from "@kernelarchive/shared";
import { z } from "zod";
import { authenticated_admin, require_admin } from "./auth";
import { list_audit_events, record_audit_event } from "./auth-store";
import { fail, list, ok } from "./http";
import {
  all_builds,
  all_modules,
  archive_file_stats,
  cache_pattern_result,
  cache_pattern_results,
  cache_database_stats,
  cache_stats,
  find_build_any,
  find_archive_file_any,
  find_archive_file_for_module_any,
  find_cached_binary_any,
  find_function_any,
  find_ingestion_record_any,
  find_module_any,
  find_pattern_any,
  find_pattern_for_function_any,
  forget_pattern_for_function_any,
  find_type_any,
  ingest_binary,
  invalidate_local_index_cache,
  list_field_references_for_type_page_any,
  list_function_references_for_type_page_any,
  list_functions_by_name_any,
  list_functions_for_module_page_any,
  list_archive_files_page,
  list_ingestions_page,
  list_modules_for_build_any,
  list_modules_for_build_page_any,
  list_pattern_targets_any,
  list_modules_by_name_any,
  list_types_by_name_any,
  list_types_by_name_and_module_name_any,
  list_types_for_build_page_any,
  list_types_for_module_page_any,
  module_binary_file_any,
  module_counts_by_build_any,
  module_pdb_status_any,
  current_system_index,
  module_summary,
  recent_archive_files,
  search_page,
  search_page_async,
  search_all,
  type_reference_counts_any,
} from "./ingestion-cache";
import { archive_scan_status, request_archive_pdb_retry, request_archive_scan } from "./archive-importer";
import { ArchiveReadBusyError } from "./archive-read-pool";
import { cross_reference_pattern_background, generate_pattern_background } from "./pattern-service";

const id_params = z.object({ id: z.string().min(1) });
const build_params = z.object({ buildId: z.string().min(1) });
const module_params = z.object({ moduleId: z.string().min(1) });
const type_params = z.object({ typeId: z.string().min(1) });
const function_params = z.object({ functionId: z.string().min(1) });
const module_items_query = pagination_query_schema.extend({ q: z.string().trim().max(128).optional() });
// search_all still runs inline on the main thread, so the AI entry points keep the
// stricter floor rather than matching search_query_schema.
const archive_search_term = z.string().trim().min(3).max(128);
// Reference pages are OFFSET-paginated over tables with millions of rows, so cost
// grows with depth: offset 73,400 measured 23s of synchronous SQL, which stalls
// every other request on the shared event loop. Cap the reachable depth until the
// query moves to keyset pagination. Deep pages are unusable at that latency anyway,
// and the q filter reaches the same rows without the walk.
const reference_max_offset = 5000;
const module_detail_query = z.object({ include: z.enum(["summary", "full"]).default("full") });
const binary_identity_query = z.object({
  product_name: z.string().optional(),
  version: z.string().optional(),
  build_number: z.string().optional(),
  revision: z.string().optional(),
});
const archive_files_query = pagination_query_schema.extend({
  q: z.string().trim().max(128).optional().default(""),
  status: z.enum(["pending", "indexed", "cached", "skipped", "failed", "missing"]).optional(),
  pdb_status: z.enum(["no-debug-info", "cached", "downloaded", "missing", "download-failed"]).optional(),
});


// Scan status is rendered on the public /progress page, but its raw form carries
// absolute host paths in root, current_file and last_error. Keep the counters and
// reduce the paths to bare file names for anonymous callers.
function public_scan_status(status: ReturnType<typeof archive_scan_status>) {
  const base_name = (value: string) => value.split(/[\\/]/).pop() ?? "";
  const { root, current_file, last_error, ...rest } = status as typeof status & { root?: string; current_file?: string; last_error?: string };
  return {
    ...rest,
    ...(current_file ? { current_file: base_name(current_file) } : {}),
    ...(last_error ? { last_error: last_error.replace(/[A-Za-z]:[\\/][^\s"']*/g, "<path>") } : {}),
  };
}

function build_modules(build_id: string) {
  return list_modules_for_build_any(build_id);
}

function attachment_header(filename: string) {
  const ascii = filename.replace(/[^\x20-\x7e]+/g, "_").replace(/["\\]/g, "_");
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

// Zip entry names are attacker-influenced via the module name, so strip anything
// that could escape the archive root or upset an extractor.
function safe_package_segment(value: string) {
  return value.replace(/[\\/:*?"<>|]+/g, "_").replace(/\.\.+/g, "_").replace(/^\.+/, "").trim() || "unknown";
}

function type_summary(type: KernelType): KernelTypeSummary {
  return {
    id: type.id,
    module_id: type.module_id,
    name: type.name,
    kind: type.kind,
    size: type.size,
    alignment: type.alignment,
    field_count: type.fields.length,
    hash: type.hash,
  };
}

function diff_result(entity_kind: DiffResult["entity_kind"], entity_name: string, from_build_id: string, to_build_id: string, changes: DiffResult["changes"]): DiffResult {
  return {
    entity_kind,
    entity_name,
    from_build_id,
    to_build_id,
    summary: changes.length === 0 ? "No comparable changes found in indexed local data." : `${changes.length} changes found in indexed local data.`,
    changes,
  };
}

function live_type_for_build(name: string, build_id: string): KernelType | undefined {
  const module_ids = new Set(build_modules(build_id).map((module) => module.id));
  return list_types_by_name_any(name).find((type) => module_ids.has(type.module_id));
}

function live_function_for_build(name: string, build_id: string): KernelFunction | undefined {
  const modules = new Map(build_modules(build_id).map((module) => [module.id, module]));
  return list_functions_by_name_any(name).find((fn) => {
    const module = modules.get(fn.module_id);
    return Boolean(module && is_function_in_executable_section(fn, module));
  });
}

function live_module_for_build(name: string, build_id: string): KernelModule | undefined {
  return build_modules(build_id).find((module) => module.name.toLowerCase() === name.toLowerCase() || module.pdb_name.toLowerCase() === name.toLowerCase());
}

interface TypeCompareMatch {
  type: KernelType;
  module: KernelModule;
  build: WindowsBuild;
  occurrence: TypeCompareOccurrence;
}

function numeric_value(value: string) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : 0;
}

function build_sort_value(build: WindowsBuild) {
  return numeric_value(build.build_number) * 1000000 + numeric_value(build.revision);
}

function offset_label(offset_bits: number) {
  const byte_offset = Math.floor(offset_bits / 8);
  const bit_offset = offset_bits % 8;
  return bit_offset === 0 ? `0x${byte_offset.toString(16)}` : `0x${byte_offset.toString(16)}:${bit_offset}`;
}

function size_label(size_bits: number) {
  if (size_bits <= 0) { return "unknown"; }
  return size_bits % 8 === 0 ? `${size_bits / 8} bytes` : `${size_bits} bits`;
}

function field_key(field: KernelType["fields"][number]) {
  return field.name.toLowerCase();
}

function field_signature(field: KernelType["fields"][number]) {
  return JSON.stringify([field.offset_bits, field.size_bits, field.field_type_name, field.flags_json]);
}

function field_diff_line(field: KernelType["fields"][number]) {
  if (field.flags_json.enum_value !== undefined) {
    return `${field.name} = ${String(field.flags_json.enum_value)}`;
  }
  return `${offset_label(field.offset_bits)} ${field.field_type_name} ${field.name} (${size_label(field.size_bits)})`;
}

function type_diff_line(type: KernelType) {
  if (type.kind === "typedef") { return type.reconstructed_c; }
  return `${type.kind} ${type.name} size 0x${type.size.toString(16)} align ${type.alignment}`;
}

function type_compare_occurrence(type: KernelType, module: KernelModule, build: WindowsBuild): TypeCompareOccurrence {
  return {
    build_id: build.id,
    build_label: build_display_label(build),
    product_name: build.product_name,
    version: build.version,
    build_number: build.build_number,
    revision: build.revision,
    architecture: build.architecture,
    module_id: module.id,
    module_name: module.name,
    type_id: type.id,
    type_name: type.name,
    kind: type.kind,
    size: type.size,
    alignment: type.alignment,
    field_count: type.fields.length,
  };
}

function type_compare_matches(source: KernelType): TypeCompareMatch[] {
  const source_module = find_module_any(source.module_id);
  const source_build = source_module ? find_build_any(source_module.build_id) : undefined;
  if (!source_module || !source_build) { return []; }
  const source_module_name = source_module.name.toLowerCase();
  const modules = new Map<string, KernelModule>();
  const builds = new Map<string, WindowsBuild>();

  const matches = list_types_by_name_and_module_name_any(source.name, source_module.name)
    .filter((type) => type.kind === source.kind)
    .map((type) => {
      let module = modules.get(type.module_id);
      if (!module) {
        module = find_module_any(type.module_id);
        if (module) { modules.set(module.id, module); }
      }
      let build = module ? builds.get(module.build_id) : undefined;
      if (module && !build) {
        build = find_build_any(module.build_id);
        if (build) { builds.set(build.id, build); }
      }
      if (module?.name.toLowerCase() !== source_module_name) { return undefined; }
      if (build?.architecture !== source_build.architecture) { return undefined; }
      return module && build ? { type, module, build, occurrence: type_compare_occurrence(type, module, build) } : undefined;
    })
    .filter((match): match is TypeCompareMatch => Boolean(match))
    .sort((left, right) => {
      const build_delta = build_sort_value(left.build) - build_sort_value(right.build);
      if (build_delta !== 0) { return build_delta; }
      const left_is_source = left.type.id === source.id;
      const right_is_source = right.type.id === source.id;
      if (left_is_source !== right_is_source) { return left_is_source ? -1 : 1; }
      const field_delta = right.type.fields.length - left.type.fields.length;
      if (field_delta !== 0) { return field_delta; }
      return left.type.id.localeCompare(right.type.id);
    });

  const unique_builds = new Map<string, TypeCompareMatch>();
  for (const match of matches) {
    if (!unique_builds.has(match.build.id)) { unique_builds.set(match.build.id, match); }
  }
  return Array.from(unique_builds.values());
}

function compare_type_step(from: TypeCompareMatch, to: TypeCompareMatch) {
  const lines: TypeCompareLine[] = [];
  let additions = 0;
  let removals = 0;
  let modifications = 0;

  if (from.type.kind !== to.type.kind || from.type.size !== to.type.size || from.type.alignment !== to.type.alignment || (from.type.kind === "typedef" && from.type.reconstructed_c !== to.type.reconstructed_c)) {
    modifications += 1;
    lines.push({ kind: "removed", field_name: "type", text: type_diff_line(from.type), pair_id: "type" });
    lines.push({ kind: "added", field_name: "type", text: type_diff_line(to.type), pair_id: "type" });
  }

  const from_fields = new Map(from.type.fields.map((field) => [field_key(field), field]));
  const to_fields = new Map(to.type.fields.map((field) => [field_key(field), field]));
  const keys = Array.from(new Set([...from_fields.keys(), ...to_fields.keys()])).sort((left, right) => {
    const left_field = from_fields.get(left) ?? to_fields.get(left);
    const right_field = from_fields.get(right) ?? to_fields.get(right);
    return (left_field?.offset_bits ?? 0) - (right_field?.offset_bits ?? 0) || left.localeCompare(right);
  });

  for (const key of keys) {
    const before = from_fields.get(key);
    const after = to_fields.get(key);
    if (before && !after) {
      removals += 1;
      lines.push({ kind: "removed", field_name: before.name, text: field_diff_line(before), pair_id: key });
    } else if (!before && after) {
      additions += 1;
      lines.push({ kind: "added", field_name: after.name, text: field_diff_line(after), pair_id: key });
    } else if (before && after && field_signature(before) !== field_signature(after)) {
      modifications += 1;
      lines.push({ kind: "removed", field_name: before.name, text: field_diff_line(before), pair_id: key });
      lines.push({ kind: "added", field_name: after.name, text: field_diff_line(after), pair_id: key });
    }
  }

  const parts = [
    additions > 0 ? `${additions} added` : "",
    removals > 0 ? `${removals} removed` : "",
    modifications > 0 ? `${modifications} changed` : "",
  ].filter(Boolean);

  return {
    from: from.occurrence,
    to: to.occurrence,
    additions,
    removals,
    modifications,
    summary: parts.length > 0 ? parts.join(", ") : "No field changes",
    lines,
  };
}

function compare_type_versions(source: KernelType): TypeCompareResult {
  const matches = type_compare_matches(source);
  const steps = [];
  for (let index = 1; index < matches.length; index += 1) {
    const from = matches[index - 1];
    const to = matches[index];
    if (from && to) { steps.push(compare_type_step(from, to)); }
  }
  return {
    type_id: source.id,
    type_name: source.name,
    occurrences: matches.map((match) => match.occurrence),
    steps,
  };
}
function compare_value(changes: DiffResult["changes"], kind: string, path: string, before: unknown, after: unknown) {
  if (before !== after) {
    changes.push({ kind, path, before, after });
  }
}

function live_diff_type(name: string, from_build_id: string, to_build_id: string): DiffResult {
  const from = live_type_for_build(name, from_build_id);
  const to = live_type_for_build(name, to_build_id);
  const changes: DiffResult["changes"] = [];
  compare_value(changes, "presence", "indexed", Boolean(from), Boolean(to));
  if (from && to) {
    compare_value(changes, "size", "size", from.size, to.size);
    compare_value(changes, "fields", "fields.length", from.fields.length, to.fields.length);
    compare_value(changes, "hash", "hash", from.hash, to.hash);
  }
  return diff_result("type", name, from_build_id, to_build_id, changes);
}

function live_diff_function(name: string, from_build_id: string, to_build_id: string): DiffResult {
  const from = live_function_for_build(name, from_build_id);
  const to = live_function_for_build(name, to_build_id);
  const changes: DiffResult["changes"] = [];
  compare_value(changes, "presence", "indexed", Boolean(from), Boolean(to));
  if (from && to) {
    compare_value(changes, "rva", "rva", from.rva, to.rva);
    compare_value(changes, "size", "size", from.size, to.size);
    compare_value(changes, "prototype", "return_type", from.return_type, to.return_type);
    compare_value(changes, "pattern", "has_pattern", from.has_pattern, to.has_pattern);
  }
  return diff_result("function", name, from_build_id, to_build_id, changes);
}

function live_diff_module(name: string, from_build_id: string, to_build_id: string): DiffResult {
  const from = live_module_for_build(name, from_build_id);
  const to = live_module_for_build(name, to_build_id);
  const changes: DiffResult["changes"] = [];
  compare_value(changes, "presence", "indexed", Boolean(from), Boolean(to));
  if (from && to) {
    compare_value(changes, "image_size", "image_size", from.image_size, to.image_size);
    compare_value(changes, "functions", "function_count", from.function_count, to.function_count);
    compare_value(changes, "types", "type_count", from.type_count, to.type_count);
    compare_value(changes, "pdb", "pdb_name", from.pdb_name, to.pdb_name);
    compare_value(changes, "sha256", "sha256", from.sha256, to.sha256);
  }
  return diff_result("module", name, from_build_id, to_build_id, changes);
}

export async function register_routes(server: FastifyInstance) {
  server.get("/api/v1/health", { schema: { tags: ["system"] } }, async (request) => ok(request, { status: "ok", service: "kernelarchive-api" }));

  server.get("/api/v1/catalog", { schema: { tags: ["system", "builds"] } }, async (request) => ok(request, {
    builds: all_builds(),
    stats: cache_stats(),
  }, "archive-database"));

  // Public, because /progress renders it for everyone. Admins get the raw status;
  // anonymous callers get it without the absolute server paths, which would
  // otherwise disclose the host's filesystem layout.
  server.get("/api/v1/archive/scan-status", { schema: { tags: ["system"] } }, async (request) => {
    const status = archive_scan_status();
    if (authenticated_admin(request)) { return ok(request, status, "live"); }
    return ok(request, public_scan_status(status), "live");
  });

  server.get("/api/v1/builds", { schema: { tags: ["builds"] } }, async (request) => {
    const query = pagination_query_schema.parse(request.query);
    return list(request, all_builds(), query.page, query.limit);
  });

  server.get("/api/v1/builds/catalog", { schema: { tags: ["builds"] } }, async (request) => {
    const query = pagination_query_schema.parse(request.query);
    const totals_by_build = module_counts_by_build_any();
    const entries = all_builds().map((build) => {
      const totals = totals_by_build.get(build.id);
      return {
        ...build,
        module_count: totals?.module_count ?? 0,
        symbol_count: totals?.symbol_count ?? 0,
        function_count: totals?.function_count ?? 0,
        type_count: totals?.type_count ?? 0,
      };
    });
    return list(request, entries, query.page, query.limit);
  });

  server.get("/api/v1/builds/:buildId", { schema: { tags: ["builds"] } }, async (request, reply) => {
    const { buildId } = build_params.parse(request.params);
    const build = find_build_any(buildId);
    if (!build) { return fail(reply, request, 404, "NOT_FOUND", "Build not found"); }
    return ok(request, build, "archive-database");
  });

  server.get("/api/v1/builds/:buildId/modules", { schema: { tags: ["modules"] } }, async (request, reply) => {
    const { buildId } = build_params.parse(request.params);
    if (!find_build_any(buildId)) { return fail(reply, request, 404, "NOT_FOUND", "Build not found"); }
    const query = module_items_query.parse(request.query);
    const result = list_modules_for_build_page_any(buildId, query.page, query.limit, query.q);
    reply.header("X-KernelArchive-Cache", result.cache_hit ? "HIT" : "MISS");
    return {
      data: result.items,
      pagination: {
        page: query.page,
        limit: query.limit,
        total: result.total,
      },
      meta: {
        request_id: request.id,
        api_version: "v1" as const,
        source: result.cache_hit ? "memory-cache" : "archive-database",
      },
    };
  });

  server.get("/api/v1/builds/:buildId/types", { schema: { tags: ["types"] } }, async (request, reply) => {
    const { buildId } = build_params.parse(request.params);
    if (!find_build_any(buildId)) { return fail(reply, request, 404, "NOT_FOUND", "Build not found"); }
    const query = module_items_query.parse(request.query);
    const result = list_types_for_build_page_any(buildId, query.page, query.limit, query.q);
    return {
      data: result.items,
      pagination: {
        page: query.page,
        limit: query.limit,
        total: result.total,
      },
      meta: {
        request_id: request.id,
        api_version: "v1" as const,
        source: "archive-database",
      },
    };
  });

  server.get("/api/v1/modules/:moduleId", { schema: { tags: ["modules"] } }, async (request, reply) => {
    const { moduleId } = module_params.parse(request.params);
    const query = module_detail_query.parse(request.query);
    const module = find_module_any(moduleId);
    if (!module) { return fail(reply, request, 404, "NOT_FOUND", "Module not found"); }
    return ok(request, query.include === "summary" ? module_summary(module) : module_summary(module, { include_sections: true, include_pe_details: true }), "archive-database");
  });

  server.get("/api/v1/modules/:moduleId/download", { config: { rateLimit: { max: 60, timeWindow: "1 minute" } }, schema: { tags: ["modules"] } }, async (request, reply) => {
    const { moduleId } = module_params.parse(request.params);
    const module = find_module_any(moduleId);
    if (!module) { return fail(reply, request, 404, "NOT_FOUND", "Module not found"); }
    const file = module_binary_file_any(module);
    if (!file) { return fail(reply, request, 404, "BINARY_UNAVAILABLE", "The indexed binary file is not available for download"); }

    reply.header("Content-Type", "application/octet-stream");
    reply.header("Content-Disposition", attachment_header(file.filename));
    reply.header("Content-Length", file.size);
    reply.header("Last-Modified", file.modified_at.toUTCString());
    reply.header("ETag", `"sha256-${file.sha256}"`);
    reply.header("Cache-Control", "private, no-store");
    return reply.send(createReadStream(file.path));
  });

  server.get("/api/v1/packages/module", { config: { rateLimit: { max: 6, timeWindow: "1 minute" } }, schema: { tags: ["modules"] } }, async (request, reply) => {
    const query = z.object({ name: z.string().trim().min(1).max(120) }).parse(request.query);
    const modules = list_modules_by_name_any(query.name);
    if (modules.length === 0) { return fail(reply, request, 404, "NOT_FOUND", "No indexed module matches that name"); }

    const seen = new Set<string>();
    const entries: ZipEntry[] = [];
    for (const module of modules) {
      const file = module_binary_file_any(module);
      if (!file || seen.has(`${module.build_id}:${file.sha256}`)) { continue; }
      seen.add(`${module.build_id}:${file.sha256}`);
      const build = find_build_any(module.build_id);
      const folder = safe_package_segment(build ? build_display_label(build) : module.build_id);
      entries.push({ path: `${folder}/${safe_package_segment(file.filename)}`, source: file.path });
    }
    if (entries.length === 0) { return fail(reply, request, 404, "BINARY_UNAVAILABLE", "No downloadable binaries are available for that module"); }

    const base = safe_package_segment(query.name).replace(/\.[^.]+$/, "") || "module";
    reply.header("Content-Type", "application/zip");
    reply.header("Content-Disposition", attachment_header(`kernelarchive_${base}_${entries.length}_builds.zip`));
    reply.header("Cache-Control", "private, no-store");
    reply.header("X-KernelArchive-Package-Entries", String(entries.length));
    return reply.send(Readable.from(zip_entries(entries)));
  });

  server.get("/api/v1/modules/:moduleId/context", { schema: { tags: ["modules"] } }, async (request, reply) => {
    const { moduleId } = module_params.parse(request.params);
    const module = find_module_any(moduleId);
    if (!module) { return fail(reply, request, 404, "NOT_FOUND", "Module not found"); }
    return ok(request, { module: module_summary(module), build: find_build_any(module.build_id) ?? null, pdb: module_pdb_status_any(module) }, "archive-database");
  });

  server.get("/api/v1/modules/:moduleId/pdb", { schema: { tags: ["modules"] } }, async (request, reply) => {
    const { moduleId } = module_params.parse(request.params);
    const module = find_module_any(moduleId);
    if (!module) { return fail(reply, request, 404, "NOT_FOUND", "Module not found"); }
    return ok(request, module_pdb_status_any(module), "archive-database");
  });

  server.get("/api/v1/modules/:moduleId/types", { schema: { tags: ["types"] } }, async (request, reply) => {
    const { moduleId } = module_params.parse(request.params);
    if (!find_module_any(moduleId)) { return fail(reply, request, 404, "NOT_FOUND", "Module not found"); }
    const query = module_items_query.parse(request.query);
    const result = list_types_for_module_page_any(moduleId, query.page, query.limit, query.q);
    return {
      data: result.items.map(type_summary),
      pagination: {
        page: query.page,
        limit: query.limit,
        total: result.total,
      },
      meta: {
        request_id: request.id,
        api_version: "v1" as const,
        source: "archive-database",
      },
    };
  });

  server.get("/api/v1/modules/:moduleId/functions", { schema: { tags: ["functions"] } }, async (request, reply) => {
    const { moduleId } = module_params.parse(request.params);
    if (!find_module_any(moduleId)) { return fail(reply, request, 404, "NOT_FOUND", "Module not found"); }
    const query = module_items_query.parse(request.query);
    const result = list_functions_for_module_page_any(moduleId, query.page, query.limit, query.q);
    return {
      data: result.items,
      pagination: {
        page: query.page,
        limit: query.limit,
        total: result.total,
      },
      meta: {
        request_id: request.id,
        api_version: "v1" as const,
        source: "archive-database",
      },
    };
  });

  server.get("/api/v1/modules/:moduleId/sections", { schema: { tags: ["modules"] } }, async (request, reply) => {
    const { moduleId } = module_params.parse(request.params);
    const module = find_module_any(moduleId);
    if (!module) { return fail(reply, request, 404, "NOT_FOUND", "Module not found"); }
    const query = pagination_query_schema.parse(request.query);
    const sections = (module.sections ?? []).map((section) => {
      const summary = { ...section };
      delete summary.content;
      return summary;
    });
    return list(request, sections, query.page, query.limit);
  });

  server.get("/api/v1/modules/:moduleId/imports", { schema: { tags: ["modules"] } }, async (request, reply) => {
    const { moduleId } = module_params.parse(request.params);
    const module = find_module_any(moduleId);
    if (!module) { return fail(reply, request, 404, "NOT_FOUND", "Module not found"); }
    const query = pagination_query_schema.parse(request.query);
    return list(request, module.imports ?? [], query.page, query.limit);
  });

  server.get("/api/v1/modules/:moduleId/exports", { schema: { tags: ["modules"] } }, async (request, reply) => {
    const { moduleId } = module_params.parse(request.params);
    const module = find_module_any(moduleId);
    if (!module) { return fail(reply, request, 404, "NOT_FOUND", "Module not found"); }
    const query = pagination_query_schema.parse(request.query);
    return list(request, (module.exports ?? []).filter((entry) => is_export_in_executable_section(entry, module)), query.page, query.limit);
  });

  server.get("/api/v1/types/:typeId", { schema: { tags: ["types"] } }, async (request, reply) => {
    const { typeId } = type_params.parse(request.params);
    const type = find_type_any(typeId);
    if (!type) { return fail(reply, request, 404, "NOT_FOUND", "Type not found"); }
    const module = find_module_any(type.module_id);
    return {
      data: type,
      meta: {
        request_id: request.id,
        api_version: "v1" as const,
        source: "archive-database",
        pdb_guid: module?.pdb_guid,
        pdb_age: module?.pdb_age,
      },
    };
  });

  server.get("/api/v1/types/:typeId/context", { schema: { tags: ["types"] } }, async (request, reply) => {
    const { typeId } = type_params.parse(request.params);
    const type = find_type_any(typeId);
    if (!type) { return fail(reply, request, 404, "NOT_FOUND", "Type not found"); }
    const module = find_module_any(type.module_id);
    const build = module ? find_build_any(module.build_id) : undefined;
    return ok(request, { type, module: module ? module_summary(module) : null, build: build ?? null }, "archive-database");
  });

  server.get("/api/v1/types/:typeId/references", { schema: { tags: ["types"] } }, async (request, reply) => {
    const { typeId } = type_params.parse(request.params);
    const type = find_type_any(typeId);
    if (!type) { return fail(reply, request, 404, "NOT_FOUND", "Type not found"); }
    return ok(request, type_reference_counts_any(type.id), "archive-database");
  });

  server.get("/api/v1/types/:typeId/references/fields", { schema: { tags: ["types"] } }, async (request, reply) => {
    const { typeId } = type_params.parse(request.params);
    const type = find_type_any(typeId);
    if (!type) { return fail(reply, request, 404, "NOT_FOUND", "Type not found"); }
    const query = module_items_query.parse(request.query);
    if ((query.page - 1) * query.limit > reference_max_offset) {
      return fail(reply, request, 400, "PAGE_TOO_DEEP", `Reference pages stop at offset ${reference_max_offset}. Narrow the result set with q instead.`);
    }
    const result = list_field_references_for_type_page_any(type.id, query.page, query.limit, query.q);
    return {
      data: result.items,
      pagination: {
        page: query.page,
        limit: query.limit,
        total: result.total,
      },
      meta: {
        request_id: request.id,
        api_version: "v1" as const,
        source: "archive-reference-index",
      },
    };
  });

  server.get("/api/v1/types/:typeId/references/functions", { schema: { tags: ["types"] } }, async (request, reply) => {
    const { typeId } = type_params.parse(request.params);
    const type = find_type_any(typeId);
    if (!type) { return fail(reply, request, 404, "NOT_FOUND", "Type not found"); }
    const query = module_items_query.parse(request.query);
    if ((query.page - 1) * query.limit > reference_max_offset) {
      return fail(reply, request, 400, "PAGE_TOO_DEEP", `Reference pages stop at offset ${reference_max_offset}. Narrow the result set with q instead.`);
    }
    const result = list_function_references_for_type_page_any(type.id, query.page, query.limit, query.q);
    return {
      data: result.items,
      pagination: {
        page: query.page,
        limit: query.limit,
        total: result.total,
      },
      meta: {
        request_id: request.id,
        api_version: "v1" as const,
        source: "archive-reference-index",
      },
    };
  });

  server.get("/api/v1/types/:typeId/xrefs", { schema: { tags: ["types"] } }, async (request, reply) => {
    const { typeId } = type_params.parse(request.params);
    const type = find_type_any(typeId);
    if (!type) { return fail(reply, request, 404, "NOT_FOUND", "Type not found"); }
    return ok(request, compare_type_versions(type), "archive-database");
  });

  server.get("/api/v1/types/:typeId/compare", { schema: { tags: ["types"] } }, async (request, reply) => {
    const { typeId } = type_params.parse(request.params);
    const type = find_type_any(typeId);
    if (!type) { return fail(reply, request, 404, "NOT_FOUND", "Type not found"); }
    return ok(request, compare_type_versions(type), "archive-database");
  });
  server.get("/api/v1/types/:typeId/header", { schema: { tags: ["types"] } }, async (request, reply) => {
    const { typeId } = type_params.parse(request.params);
    const type = find_type_any(typeId);
    if (!type) { return fail(reply, request, 404, "NOT_FOUND", "Type not found"); }
    const module = find_module_any(type.module_id);
    const build = module ? find_build_any(module.build_id) : undefined;
    reply.type("text/plain");
    return generate_offset_header(type, module, build);
  });

  server.get("/api/v1/functions/:functionId", { schema: { tags: ["functions"] } }, async (request, reply) => {
    const { functionId } = function_params.parse(request.params);
    const fn = find_function_any(functionId);
    if (!fn) { return fail(reply, request, 404, "NOT_FOUND", "Function not found"); }
    const pattern = find_pattern_for_function_any(fn.id);
    return ok(request, { ...fn, pattern: pattern ?? null }, "archive-database");
  });

  server.get("/api/v1/functions/:functionId/context", { schema: { tags: ["functions"] } }, async (request, reply) => {
    const { functionId } = function_params.parse(request.params);
    const fn = find_function_any(functionId);
    if (!fn) { return fail(reply, request, 404, "NOT_FOUND", "Function not found"); }
    const module = find_module_any(fn.module_id);
    const build = module ? find_build_any(module.build_id) : undefined;
    return ok(request, { fn: { ...fn, pattern: find_pattern_for_function_any(fn.id) ?? null }, module: module ? module_summary(module, { include_sections: true }) : null, build: build ?? null }, "archive-database");
  });

  server.get("/api/v1/functions/:functionId/pattern", { config: { rateLimit: { max: 30, timeWindow: "1 minute" } }, schema: { tags: ["patterns"] } }, async (request, reply) => {
    const { functionId } = function_params.parse(request.params);
    const fn = find_function_any(functionId);
    if (!fn) { return fail(reply, request, 404, "NOT_FOUND", "Function not found"); }
    const module = find_module_any(fn.module_id);
    if (!module) { return fail(reply, request, 404, "NOT_FOUND", "Module not found"); }
    try {
      const cached = find_pattern_for_function_any(fn.id, module.sha256);
      if (cached) { return ok(request, cached, "pattern-cache"); }
      const pattern = await generate_pattern_background(module, fn, module.sha256, list_pattern_targets_any(fn));
      return ok(request, cache_pattern_result(pattern), "local-binary");
    } catch (error) {
      const message = error instanceof Error ? error.message : "Pattern generation failed";
      return fail(reply, request, 422, "PATTERN_REJECTED", message);
    }
  });

  server.get("/api/v1/functions/:functionId/pattern/xrefs", { config: { rateLimit: { max: 20, timeWindow: "1 minute" } }, schema: { tags: ["patterns"] } }, async (request, reply) => {
    const { functionId } = function_params.parse(request.params);
    const fn = find_function_any(functionId);
    if (!fn) { return fail(reply, request, 404, "NOT_FOUND", "Function not found"); }
    const targets = list_pattern_targets_any(fn);
    const module = find_module_any(fn.module_id);
    const source_pattern = find_pattern_for_function_any(fn.id, module?.sha256);
    try {
      const analysis = await cross_reference_pattern_background(module, fn, targets, source_pattern);
      cache_pattern_results(analysis.patterns);
      return ok(request, analysis.result, "pattern-cross-reference");
    } catch (error) {
      const message = error instanceof Error ? error.message : "Pattern cross-reference failed";
      return fail(reply, request, 422, "PATTERN_REJECTED", message);
    }
  });

  server.get("/api/v1/search", { schema: { tags: ["search"] } }, async (request, reply) => {
    const query = search_query_schema.parse(request.query);
    let results;
    try {
      results = await search_page_async(query.q, query.page, query.limit, {
        build: query.build,
        architecture: query.architecture,
        module: query.module,
        kind: query.kind,
      });
    } catch (error) {
      if (error instanceof ArchiveReadBusyError) {
        reply.header("retry-after", "2");
        return fail(reply, request, 503, "SEARCH_BUSY", "Search is busy right now. Retry in a moment.");
      }
      throw error;
    }
    return {
      ...ok(request, results.items, "archive-database"),
      pagination: {
        page: query.page,
        limit: query.limit,
        total: results.total,
      },
    };
  });

  server.get("/api/v1/symbols/resolve", { schema: { tags: ["symbols"] } }, async (request, reply) => {
    const query = z.object({ name: z.string().min(1) }).parse(request.query);
    const matches = search_all(query.name).filter((result) => result.kind === "type" || result.kind === "function");
    if (matches.length === 0) { return fail(reply, request, 404, "NOT_FOUND", "Symbol not found"); }
    return ok(request, { symbol: query.name, matches }, "archive-database");
  });

  server.get("/api/v1/diff/types", { schema: { tags: ["diff"] } }, async (request) => {
    const query = z.object({ name: z.string().min(1), from: z.string().min(1), to: z.string().min(1) }).parse(request.query);
    return ok(request, live_diff_type(query.name, query.from, query.to), "archive-database");
  });

  server.get("/api/v1/diff/functions", { schema: { tags: ["diff"] } }, async (request) => {
    const query = z.object({ name: z.string().min(1), from: z.string().min(1), to: z.string().min(1) }).parse(request.query);
    return ok(request, live_diff_function(query.name, query.from, query.to), "archive-database");
  });

  server.get("/api/v1/diff/modules", { schema: { tags: ["diff"] } }, async (request) => {
    const query = z.object({ name: z.string().min(1), from: z.string().min(1), to: z.string().min(1) }).parse(request.query);
    return ok(request, live_diff_module(query.name, query.from, query.to), "archive-database");
  });

  server.get("/api/v1/system/current", { schema: { tags: ["system"] } }, async (request, reply) => {
    const index = current_system_index();
    if (!index) { return fail(reply, request, 404, "NOT_FOUND", "System index not found"); }
    return ok(request, index, "local-system");
  });

  server.get("/api/v1/stats", { schema: { tags: ["system"] } }, async (request) => ok(request, cache_stats(), "archive-database"));

  server.get("/llms.txt", { schema: { tags: ["ai"] } }, async (_request, reply) => {
    reply.type("text/plain");
    return [
      "KernelArchive is a Windows kernel symbol and structure archive.",
      "Use the API instead of scraping pages.",
      "OpenAPI: /api/v1/openapi.json",
      "Search: /api/v1/ai/search?q=",
      "Resolve symbol: /api/v1/ai/resolve?symbol=",
      "Get type context: /api/v1/ai/context/type/:id",
      "Get function context: /api/v1/ai/context/function/:id",
    ].join("\n");
  });

  server.get("/api/v1/ai/manifest", { schema: { tags: ["ai"] } }, async (request) => ok(request, {
    name: "KernelArchive",
    description: "Windows kernel symbol and structure archive",
    openapi_url: "/api/v1/openapi.json",
    search_url: "/api/v1/ai/search?q=",
    resolve_url: "/api/v1/ai/resolve?symbol=",
    schema_url: "/api/v1/ai/schema",
  }));

  server.get("/api/v1/ai/search", { schema: { tags: ["ai"] } }, async (request) => {
    const query = z.object({ q: archive_search_term }).parse(request.query);
    return ok(request, { query: query.q, results: search_all(query.q).slice(0, 10) }, "archive-database");
  });

  server.get("/api/v1/ai/resolve", { schema: { tags: ["ai"] } }, async (request) => {
    const query = z.object({ symbol: archive_search_term }).parse(request.query);
    return ok(request, { symbol: query.symbol, matches: search_all(query.symbol).slice(0, 10) }, "archive-database");
  });

  server.get("/api/v1/ai/context/type/:id", { schema: { tags: ["ai"] } }, async (request, reply) => {
    const { id } = id_params.parse(request.params);
    const type = find_type_any(id);
    if (!type) { return fail(reply, request, 404, "NOT_FOUND", "Type context not found"); }
    const module = find_module_any(type.module_id);
    const build = module ? find_build_any(module.build_id) : undefined;
    return ok(request, { type, module: module ? module_summary(module) : null, build, api_url: `/api/v1/types/${id}` }, "archive-database");
  });

  server.get("/api/v1/ai/context/function/:id", { schema: { tags: ["ai"] } }, async (request, reply) => {
    const { id } = id_params.parse(request.params);
    const fn = find_function_any(id);
    if (!fn) { return fail(reply, request, 404, "NOT_FOUND", "Function context not found"); }
    const module = find_module_any(fn.module_id);
    const build = module ? find_build_any(module.build_id) : undefined;
    return ok(request, { function: fn, module: module ? module_summary(module, { include_sections: true }) : null, build, pattern: find_pattern_for_function_any(fn.id) ?? null, api_url: `/api/v1/functions/${id}` }, "archive-database");
  });

  const schema_manifest = {
    response_envelope: {
      data: "object | array",
      pagination: "optional pagination object for lists",
      meta: "request_id, api_version, source metadata",
      error: "code, message, request_id",
    },
    entities: {
      windows_build: ["id", "product_name", "version", "build_number", "revision", "architecture", "release_channel", "published"],
      module: ["id", "build_id", "name", "image_base", "image_size", "entry_point", "timestamp", "checksum", "sha256", "pdb_name", "pdb_guid", "sections", "imports", "exports"],
      type: ["id", "module_id", "name", "kind", "size", "alignment", "reconstructed_c", "fields", "xrefs", "header"],
      type_field: ["id", "type_id", "name", "field_type_name", "offset_bits", "size_bits", "flags_json"],
      function: ["id", "symbol_id", "module_id", "name", "return_type", "calling_convention", "parameters_json", "rva", "size", "confidence", "is_exported"],
      pattern: ["id", "function_id", "module_id", "binary_sha256", "pattern", "mask", "format", "length", "confidence", "collision_count", "tested_builds_json", "status"],
      pattern_cross_reference: ["build_id", "build_label", "architecture", "module_id", "function_id", "rva", "binary_sha256", "pattern_status", "confidence", "collision_count", "length", "pattern", "mask", "pattern_scope", "status", "note"],
      binary_ingestion: ["id", "filename", "sha256", "cache_path", "build_id", "module_id", "module_name", "build_label", "architecture", "pdb_status", "symbol_url", "created_at"],
      diff: ["entity_kind", "entity_name", "from_build_id", "to_build_id", "summary", "changes"],
      structure_cross_reference: ["type_id", "type_name", "occurrences", "steps"],
    },
  };

  server.get("/api/v1/ai/schema", { schema: { tags: ["ai"] } }, async (request) => ok(request, schema_manifest));

  server.post("/api/v1/patterns/request", { config: { rateLimit: { max: 30, timeWindow: "1 minute" } }, schema: { tags: ["patterns"] } }, async (request, reply) => {
    const body = pattern_request_schema.parse(request.body);
    const fn = find_function_any(body.function_id);
    if (!fn) { return fail(reply, request, 404, "NOT_FOUND", "Function not found"); }
    const module = find_module_any(fn.module_id);
    if (!module) { return fail(reply, request, 404, "NOT_FOUND", "Module not found"); }
    try {
      const binary_sha256 = body.binary_sha256 || module.sha256;
      if (!body.refresh) {
        const cached = find_pattern_for_function_any(fn.id, binary_sha256);
        if (cached) { return ok(request, cached, "pattern-cache"); }
      } else {
        forget_pattern_for_function_any(fn.id, binary_sha256);
      }
      const pattern = await generate_pattern_background(module, fn, binary_sha256, list_pattern_targets_any(fn));
      return ok(request, cache_pattern_result(pattern), body.refresh ? "regenerated" : "local-binary");
    } catch (error) {
      const message = error instanceof Error ? error.message : "Pattern generation failed";
      return fail(reply, request, 422, "PATTERN_REJECTED", message);
    }
  });

  server.get("/api/v1/patterns/:patternId", { schema: { tags: ["patterns"] } }, async (request, reply) => {
    const params = z.object({ patternId: z.string().min(1) }).parse(request.params);
    const pattern = find_pattern_any(params.patternId);
    if (!pattern) { return fail(reply, request, 404, "NOT_FOUND", "Pattern not found"); }
    return ok(request, pattern, "archive-database");
  });

  server.post("/api/v1/uploads/binary", { preHandler: require_admin, schema: { tags: ["uploads"] } }, async (request, reply) => {
    const query = z.object({
      filename: z.string().min(1).optional(),
      product_name: z.string().optional(),
      version: z.string().optional(),
      build_number: z.string().optional(),
      revision: z.string().optional(),
    }).parse(request.query);
    const header_filename = typeof request.headers["x-filename"] === "string" ? request.headers["x-filename"] : undefined;
    const filename = query.filename ?? header_filename ?? "upload.bin";
    if (!Buffer.isBuffer(request.body)) {
      return fail(reply, request, 400, "BAD_REQUEST", "Binary upload body must be application/octet-stream");
    }
    const result = await ingest_binary(filename, request.body, query);
    const user = authenticated_admin(request);
    record_audit_event({ user_id: user?.id === "api-key" ? null : user?.id, action: result.cache_hit ? "binary.cache_hit" : "binary.ingested", target_type: "module", target_id: result.module.id, success: true, ip_address: request.ip, user_agent: request.headers["user-agent"], details: { sha256: result.ingestion.sha256, build_id: result.build.id } });
    return ok(request, result, "archive-database");
  });

  server.post("/api/v1/admin/uploads/binary", { preHandler: require_admin, schema: { tags: ["admin", "uploads"] } }, async (request, reply) => {
    const query = z.object({
      filename: z.string().min(1).optional(),
      product_name: z.string().optional(),
      version: z.string().optional(),
      build_number: z.string().optional(),
      revision: z.string().optional(),
    }).parse(request.query);
    const header_filename = typeof request.headers["x-filename"] === "string" ? request.headers["x-filename"] : undefined;
    const filename = query.filename ?? header_filename ?? "upload.bin";
    if (!Buffer.isBuffer(request.body)) {
      return fail(reply, request, 400, "BAD_REQUEST", "Binary upload body must be application/octet-stream");
    }
    const result = await ingest_binary(filename, request.body, query);
    const user = authenticated_admin(request);
    record_audit_event({ user_id: user?.id === "api-key" ? null : user?.id, action: result.cache_hit ? "binary.cache_hit" : "binary.ingested", target_type: "module", target_id: result.module.id, success: true, ip_address: request.ip, user_agent: request.headers["user-agent"], details: { sha256: result.ingestion.sha256, build_id: result.build.id } });
    return ok(request, result, "archive-database");
  });

  server.get("/api/v1/admin/ingestions", { preHandler: require_admin, schema: { tags: ["admin", "uploads"] } }, async (request) => {
    const query = pagination_query_schema.parse(request.query);
    const ingestions = list_ingestions_page(query.page, query.limit);
    const archive_files = recent_archive_files(12);
    const archive_stats = archive_file_stats();
    const stats = cache_stats();
    return ok(request, {
      ingestions,
      archive: {
        status: archive_scan_status(),
        files: archive_files,
        stats: archive_stats,
      },
      stats,
      database: cache_database_stats(),
      pagination: {
        page: query.page,
        limit: query.limit,
        total: stats.ingestions,
      },
    }, "archive-database");
  });

  server.get("/api/v1/admin/archive/files", { preHandler: require_admin, schema: { tags: ["admin", "uploads"] } }, async (request) => {
    const query = archive_files_query.parse(request.query);
    const result = list_archive_files_page(query.page, query.limit, query.q, query.status ?? "", query.pdb_status ?? "");
    return {
      ...ok(request, result.items, "archive-database"),
      pagination: {
        page: query.page,
        limit: query.limit,
        total: result.total,
      },
    };
  });

  server.post("/api/v1/admin/archive/files/:fileId/pdb/retry", { preHandler: require_admin, schema: { tags: ["admin", "uploads"] } }, async (request, reply) => {
    const params = z.object({ fileId: z.string().min(1) }).parse(request.params);
    const record = find_archive_file_any(params.fileId);
    if (!record) { return fail(reply, request, 404, "NOT_FOUND", "Archive file not found"); }
    if (record.status === "missing") { return fail(reply, request, 409, "SOURCE_MISSING", "Archive source file is missing"); }
    if (!record.build_id) { return fail(reply, request, 409, "NOT_INDEXED", "Archive file has no indexed build metadata"); }
    if (record.pdb_status === "no-debug-info") { return fail(reply, request, 409, "NO_DEBUG_INFO", "Portable Executable has no CodeView PDB record"); }
    const retry = request_archive_pdb_retry(record);
    const user = authenticated_admin(request);
    record_audit_event({ user_id: user?.id === "api-key" ? null : user?.id, action: "archive.pdb_retry_requested", target_type: "archive_file", target_id: record.id, success: true, ip_address: request.ip, user_agent: request.headers["user-agent"], details: { relative_path: record.relative_path, previous_status: record.pdb_status } });
    reply.code(202);
    return ok(request, retry, "archive-importer");
  });

  server.post("/api/v1/admin/modules/:moduleId/pdb/retry", { preHandler: require_admin, schema: { tags: ["admin", "modules"] } }, async (request, reply) => {
    const { moduleId } = module_params.parse(request.params);
    const module = find_module_any(moduleId);
    if (!module) { return fail(reply, request, 404, "NOT_FOUND", "Module not found"); }
    const record = find_archive_file_for_module_any(moduleId);
    if (!record) { return fail(reply, request, 409, "SOURCE_UNAVAILABLE", "No Archive source file is linked to this module"); }
    if (record.status === "missing") { return fail(reply, request, 409, "SOURCE_MISSING", "Archive source file is missing"); }
    if (record.status === "skipped") { return fail(reply, request, 409, "SOURCE_UNAVAILABLE", "Archive source file is not eligible for PDB lookup"); }
    if (!record.build_id) { return fail(reply, request, 409, "NOT_INDEXED", "Archive file has no indexed build metadata"); }
    if (record.pdb_status === "no-debug-info" || !module.debug?.pdb_identifier) { return fail(reply, request, 409, "NO_DEBUG_INFO", "Portable Executable has no CodeView PDB record"); }
    const retry = request_archive_pdb_retry(record);
    const user = authenticated_admin(request);
    record_audit_event({ user_id: user?.id === "api-key" ? null : user?.id, action: "module.pdb_retry_requested", target_type: "module", target_id: module.id, success: true, ip_address: request.ip, user_agent: request.headers["user-agent"], details: { archive_file_id: record.id, relative_path: record.relative_path, previous_status: record.pdb_status } });
    reply.code(202);
    return ok(request, { ...retry, pdb: module_pdb_status_any(module) }, "archive-importer");
  });

  server.post("/api/v1/admin/archive/scan", { preHandler: require_admin, schema: { tags: ["admin", "uploads"] } }, async (request) => {
    const scan = request_archive_scan("manual");
    const user = authenticated_admin(request);
    record_audit_event({ user_id: user?.id === "api-key" ? null : user?.id, action: "archive.scan_requested", target_type: "archive", success: true, ip_address: request.ip, user_agent: request.headers["user-agent"], details: { root: scan.root } });
    return ok(request, scan, "archive-importer");
  });

  server.get("/api/v1/admin/cache/binaries/:sha256", { preHandler: require_admin, schema: { tags: ["admin", "uploads"] } }, async (request, reply) => {
    const params = z.object({ sha256: z.string().regex(/^[a-fA-F0-9]{64}$/) }).parse(request.params);
    const query = binary_identity_query.parse(request.query);
    const cached = find_cached_binary_any(params.sha256, query);
    if (!cached) { return fail(reply, request, 404, "NOT_FOUND", "Binary is not fully indexed for this identity"); }
    return ok(request, cached, "archive-database");
  });

  server.get("/api/v1/jobs/:jobId", { preHandler: require_admin, schema: { tags: ["jobs"] } }, async (request, reply) => {
    const params = z.object({ jobId: z.string().min(1) }).parse(request.params);
    const ingestion = find_ingestion_record_any(params.jobId);
    if (!ingestion) { return fail(reply, request, 404, "NOT_FOUND", "Job not found"); }
    return ok(request, { id: ingestion.id, type: "binary-ingestion", status: "completed", created_at: ingestion.created_at }, "archive-database");
  });

  server.get("/api/v1/me/api-keys", { preHandler: require_admin, schema: { tags: ["auth"] } }, async (request) => ok(request, [], "auth-database"));

  server.delete("/api/v1/admin/cache", { preHandler: require_admin, schema: { tags: ["admin"] } }, async (request) => {
    invalidate_local_index_cache();
    const user = authenticated_admin(request);
    record_audit_event({ user_id: user?.id === "api-key" ? null : user?.id, action: "cache.memory_invalidated", target_type: "cache", success: true, ip_address: request.ip, user_agent: request.headers["user-agent"] });
    return ok(request, { cleared: true, keys: ["local-index"] }, "memory-cache");
  });

  server.get("/api/v1/admin/audit-logs", { preHandler: require_admin, schema: { tags: ["admin"] } }, async (request) => {
    const query = pagination_query_schema.parse(request.query);
    return list(request, list_audit_events(), query.page, query.limit);
  });

  server.get("/api/v1/openapi.json", { schema: { tags: ["system"] } }, async (_request, reply) => {
    reply.type("application/json");
    return server.swagger();
  });

  server.get("/api/v1/schemas", { schema: { tags: ["system"] } }, async (request) => ok(request, schema_manifest));
}
