import type { KernelFunction, KernelModule, KernelType, WindowsBuild } from "./types";
import { is_function_in_executable_section, parse_hex } from "./pe";

function define_name(value: string) {
  return value.replace(/^_+/, "").replace(/[^a-zA-Z0-9]+/g, "_").replace(/^_+|_+$/g, "").toUpperCase();
}

export function has_function_prototype(fn: KernelFunction) {
  return !["exported symbol", "PDB symbol"].includes(fn.return_type) && !["PE export", "PDB public"].includes(fn.calling_convention);
}

function matches_pe_export(fn: KernelFunction, module?: KernelModule) {
  if (!module?.exports?.length) { return false; }
  const name = fn.name.toLowerCase();
  const rva = parse_hex(fn.rva);
  return module.exports.some((entry) =>
    !entry.forwarder
    && entry.name.toLowerCase() === name
    && parse_hex(entry.rva) === rva,
  );
}

export function is_exposed_function(fn: KernelFunction, module?: KernelModule) {
  const confirmed = fn.symbol_kind === "pe-export"
    || fn.symbol_kind === "pdb-function"
    || fn.symbol_kind === "pdb-public"
    || (!fn.symbol_kind && (has_function_prototype(fn) || matches_pe_export(fn, module)));
  return confirmed && is_function_in_executable_section(fn, module);
}

export function function_signature(fn: KernelFunction) {
  if (!has_function_prototype(fn)) { return `${fn.name}(...)`; }
  const params = fn.parameters_json.length > 0
    ? fn.parameters_json.map((param) => `${param.type} ${param.name}`).join(", ")
    : "void";
  return `${fn.return_type} ${fn.calling_convention} ${fn.name}(${params});`;
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
    if (type.kind === "enum") {
      lines.push(`#define ${name} ${String(field.flags_json.enum_value ?? "0")}`);
    } else {
      lines.push(`#define ${name} 0x${Math.floor(field.offset_bits / 8).toString(16)}`);
    }
  }
  lines.push("");
  return lines.join("\n");
}
