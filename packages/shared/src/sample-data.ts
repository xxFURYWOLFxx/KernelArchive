import type { DiffResult, KernelFunction, KernelModule, KernelType, PatternCrossReferenceTarget, PatternResult, SearchResult, WindowsBuild } from "./types";
import { build_display_label } from "./builds";
import { system_builds, system_functions, system_modules, system_patterns, system_types } from "./generated-system-data";
import { interpret_module_sections, is_function_in_executable_section } from "./pe";

export const sample_builds: WindowsBuild[] = system_builds;
export const sample_modules: KernelModule[] = system_modules.map((module) => interpret_module_sections(module));
export const sample_types: KernelType[] = system_types;
export const sample_functions: KernelFunction[] = system_functions;
export const sample_patterns: PatternResult[] = system_patterns;
export const default_build_id = sample_builds[0]?.id ?? "";
export const default_module_id = sample_modules.find((module) => module.build_id === default_build_id)?.id ?? "";

export function list_modules_for_build(build_id: string): KernelModule[] {
  return sample_modules.filter((module) => module.build_id === build_id);
}

export function list_types_for_module(module_id: string): KernelType[] {
  return sample_types.filter((type) => type.module_id === module_id);
}

export function list_functions_for_module(module_id: string): KernelFunction[] {
  return list_functions().filter((fn) => fn.module_id === module_id);
}

export function find_module(module_id: string): KernelModule | undefined {
  return sample_modules.find((module) => module.id === module_id);
}

export function find_build(build_id: string): WindowsBuild | undefined {
  return sample_builds.find((build) => build.id === build_id);
}

export function find_type(type_id: string): KernelType | undefined {
  return sample_types.find((type) => type.id === type_id);
}

export function find_function(function_id: string): KernelFunction | undefined {
  return list_functions().find((fn) => fn.id === function_id);
}

export function find_pattern_for_function(function_id: string): PatternResult | undefined {
  return sample_patterns.find((pattern) => pattern.function_id === function_id);
}

export function list_functions(): KernelFunction[] {
  return sample_functions.filter((fn) => is_function_in_executable_section(fn, find_module(fn.module_id)));
}

export function list_pattern_cross_reference_targets(fn: KernelFunction): PatternCrossReferenceTarget[] {
  const source_module = find_module(fn.module_id);
  const module_name = source_module?.name ?? fn.module_id;
  const normalized_module_name = module_name.toLowerCase();
  const normalized_pdb_name = source_module?.pdb_name.toLowerCase() ?? "";
  const normalized_function_name = fn.name.toLowerCase();
  const functions = list_functions();

  return sample_builds.map((build) => {
    const module = sample_modules.find((item) =>
      item.build_id === build.id &&
      (item.name.toLowerCase() === normalized_module_name || (normalized_pdb_name.length > 0 && item.pdb_name.toLowerCase() === normalized_pdb_name)));
    const matched_function = module
      ? functions.find((item) => item.module_id === module.id && item.name.toLowerCase() === normalized_function_name)
      : undefined;
    const stored_pattern = matched_function ? find_pattern_for_function(matched_function.id) : undefined;
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

function normalize_type_ref(value: string) {
  return value
    .replace(/\b(const|volatile|struct|union|enum)\b/gi, "")
    .replace(/\[[^\]]*\]/g, "")
    .replace(/[_\s*&]+/g, "")
    .toLowerCase();
}

function type_aliases(type: KernelType) {
  const clean = normalize_type_ref(type.name);
  return new Set([clean, `p${clean}`, `${clean}ptr`]);
}

function define_name(value: string) {
  return value.replace(/^_+/, "").replace(/[^a-zA-Z0-9]+/g, "_").replace(/^_+|_+$/g, "").toUpperCase();
}

export function has_function_prototype(fn: KernelFunction) {
  return fn.return_type !== "exported symbol" && fn.calling_convention !== "PE export";
}

export function function_signature(fn: KernelFunction) {
  if (!has_function_prototype(fn)) {
    return `${fn.name}(...)`;
  }
  const params = fn.parameters_json.length > 0
    ? fn.parameters_json.map((param) => `${param.type} ${param.name}`).join(", ")
    : "void";
  return `${fn.return_type} ${fn.calling_convention} ${fn.name}(${params});`;
}

export function find_type_by_name(module_id: string | undefined, name: string): KernelType | undefined {
  const normalized = normalize_type_ref(name);
  const matches = sample_types.filter((type) => type_aliases(type).has(normalized));
  return matches.find((type) => type.module_id === module_id) ?? matches[0];
}

export function list_field_references_for_type(type_id: string) {
  const type = find_type(type_id);
  if (!type) { return []; }
  const aliases = type_aliases(type);
  return sample_types
    .flatMap((candidate) => candidate.fields.map((field) => ({ type: candidate, field })))
    .filter((entry) => entry.type.id !== type.id)
    .filter((entry) => aliases.has(normalize_type_ref(entry.field.field_type_name)));
}

export function list_function_references_for_type(type_id: string) {
  const type = find_type(type_id);
  if (!type) { return []; }
  const aliases = type_aliases(type);
  const core = define_name(type.name).replace(/_/g, "");
  return list_functions()
    .filter((fn) =>
      aliases.has(normalize_type_ref(fn.return_type)) ||
      fn.parameters_json.some((param) => aliases.has(normalize_type_ref(param.type))) ||
      (core.length > 3 && fn.name.toUpperCase().includes(core.replace(/^P/, ""))))
    .slice(0, 250);
}

export function generate_offset_header(type: KernelType, module?: KernelModule, build?: WindowsBuild) {
  const type_name = define_name(type.name);
  const lines = [
    "#pragma once",
    "#include <stdint.h>",
    "",
    `// ${type.name} offsets from KernelArchive.`,
    `// Module: ${module?.name ?? type.module_id}`,
    `// Build: ${build ? `${build.build_number}.${build.revision} ${build.architecture}` : "unknown"}`,
    `// PDB: ${module?.pdb_name ?? "unknown"} ${module?.pdb_guid ?? ""} age ${module?.pdb_age ?? ""}`.trim(),
    "",
    `#define ${type_name}_SIZE 0x${type.size.toString(16)}`,
  ];
  const seen = new Map<string, number>();
  for (const field of type.fields) {
    const base = `${type_name}_${define_name(field.name)}`;
    const seen_count = seen.get(base) ?? 0;
    seen.set(base, seen_count + 1);
    const name = seen_count === 0 ? base : `${base}_${seen_count}`;
    lines.push(`#define ${name} 0x${(field.offset_bits / 8).toString(16)}`);
  }
  lines.push("");
  return lines.join("\n");
}

export function search_sample(query: string): SearchResult[] {
  const normalized = query.trim().toLowerCase();
  if (!normalized) { return []; }

  const type_results = sample_types
    .filter((type) => type.name.toLowerCase().includes(normalized) || type.fields.some((field) => field.name.toLowerCase().includes(normalized)))
    .map((type) => {
      const module = find_module(type.module_id);
      const build = module ? find_build(module.build_id) : undefined;
      return {
        id: type.id,
        kind: "type" as const,
        name: type.name,
        module: module?.name ?? "unknown",
        build: build?.build_number ?? "unknown",
        architecture: build?.architecture ?? "x64",
        api_url: `/api/v1/types/${type.id}`,
        web_url: `/types/${type.id}`,
        score: type.name.toLowerCase() === normalized ? 1 : 0.78,
      };
    });

  const function_results = list_functions()
    .filter((fn) => fn.name.toLowerCase().includes(normalized) || fn.rva.toLowerCase() === normalized)
    .map((fn) => {
      const module = find_module(fn.module_id);
      const build = module ? find_build(module.build_id) : undefined;
      return {
        id: fn.id,
        kind: "function" as const,
        name: fn.name,
        module: module?.name ?? "unknown",
        build: build?.build_number ?? "unknown",
        architecture: build?.architecture ?? "x64",
        api_url: `/api/v1/functions/${fn.id}`,
        web_url: `/functions/${fn.id}`,
        score: fn.name.toLowerCase() === normalized ? 1 : 0.74,
      };
    });

  const module_results = sample_modules
    .filter((module) =>
      module.name.toLowerCase().includes(normalized) ||
      module.pdb_guid.toLowerCase().includes(normalized) ||
      module.sha256.toLowerCase().includes(normalized) ||
      module.checksum.toLowerCase() === normalized ||
      module.source_path?.toLowerCase().includes(normalized) ||
      module.imports?.some((item) => item.dll.toLowerCase().includes(normalized) || item.functions.some((fn) => fn.toLowerCase().includes(normalized))) ||
      module.exports?.some((entry) => entry.name.toLowerCase().includes(normalized) || entry.rva.toLowerCase() === normalized))
    .map((module) => {
      const build = find_build(module.build_id);
      return {
        id: module.id,
        kind: "module" as const,
        name: module.name,
        module: module.name,
        build: build?.build_number ?? "unknown",
        architecture: build?.architecture ?? "x64",
        api_url: `/api/v1/modules/${module.id}`,
        web_url: `/modules/${module.id}`,
        score: module.name.toLowerCase() === normalized ? 1 : 0.68,
      };
    });

  return [...type_results, ...function_results, ...module_results].sort((left, right) => right.score - left.score);
}

export function diff_type(name: string, from_build_id: string, to_build_id: string): DiffResult {
  const match = sample_types.find((type) => type.name.toLowerCase() === name.toLowerCase());
  return {
    entity_kind: "type",
    entity_name: name,
    from_build_id,
    to_build_id,
    summary: match ? `${name} has sample field offset and size data available for comparison.` : `${name} is not present in the sample corpus.`,
    changes: match
      ? [
          { kind: "size", path: "size", before: match.size - 0x20, after: match.size },
          { kind: "field_offset", path: `${match.name}.${match.fields[0]?.name ?? "field"}`, before: 0, after: match.fields[0]?.offset_bits ?? 0 },
        ]
      : [],
  };
}

export function diff_function(name: string, from_build_id: string, to_build_id: string): DiffResult {
  const match = list_functions().find((fn) => fn.name.toLowerCase() === name.toLowerCase());
  return {
    entity_kind: "function",
    entity_name: name,
    from_build_id,
    to_build_id,
    summary: match ? `${name} has sample RVA, size, and pattern confidence data available for comparison.` : `${name} is not present in the sample corpus.`,
    changes: match
      ? [
          { kind: "rva", path: "rva", before: "0x00000000", after: match.rva },
          { kind: "size", path: "size", before: Math.max(0, match.size - 32), after: match.size },
          { kind: "pattern", path: "has_pattern", before: false, after: match.has_pattern },
        ]
      : [],
  };
}

export function diff_module(name: string, from_build_id: string, to_build_id: string): DiffResult {
  const candidates = sample_modules.filter((module) => module.name.toLowerCase() === name.toLowerCase());
  const from_module = candidates.find((module) => module.build_id === from_build_id) ?? candidates[0];
  const to_module = candidates.find((module) => module.build_id === to_build_id) ?? candidates[candidates.length - 1];
  const changes: DiffResult["changes"] = [];

  if (from_module && to_module) {
    const from_function_count = list_functions_for_module(from_module.id).length;
    const to_function_count = list_functions_for_module(to_module.id).length;
    if (from_module.image_size !== to_module.image_size) {
      changes.push({ kind: "image_size", path: "image_size", before: from_module.image_size, after: to_module.image_size });
    }
    if (from_module.timestamp !== to_module.timestamp) {
      changes.push({ kind: "timestamp", path: "timestamp", before: from_module.timestamp, after: to_module.timestamp });
    }
    if (from_function_count !== to_function_count) {
      changes.push({ kind: "exports", path: "function_count", before: from_function_count, after: to_function_count });
    }
    if ((from_module.sections?.length ?? 0) !== (to_module.sections?.length ?? 0)) {
      changes.push({ kind: "sections", path: "sections.length", before: from_module.sections?.length ?? 0, after: to_module.sections?.length ?? 0 });
    }
    if (from_module.sha256 !== to_module.sha256) {
      changes.push({ kind: "sha256", path: "sha256", before: from_module.sha256, after: to_module.sha256 });
    }
  }

  return {
    entity_kind: "module",
    entity_name: name,
    from_build_id,
    to_build_id,
    summary: from_module && to_module ? `${name} has ${changes.length} module-level change(s).` : `${name} is not present in the corpus.`,
    changes,
  };
}
