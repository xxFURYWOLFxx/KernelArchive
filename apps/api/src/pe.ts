import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { basename, extname } from "node:path";
import { promisify } from "node:util";
import { describe_section_characteristics, is_export_in_executable_section, parse_hex } from "@kernelarchive/shared";
import type { Architecture, KernelFunction, KernelModule, KernelType, PeDebugInfo, PeExport, PeImport, PeSection } from "@kernelarchive/shared";

interface DataDirectory {
  rva: number;
  size: number;
}

interface ParsedSection extends PeSection {
  raw_ptr: number;
  virtual_address_number: number;
  virtual_size_number: number;
  raw_size_number: number;
}

export interface ParsedPe {
  machine: number;
  architecture: Architecture;
  timestamp: number;
  image_base: bigint;
  image_size: number;
  entry_point: number;
  checksum: number;
  sections: ParsedSection[];
  imports: PeImport[];
  exports: PeExport[];
  debug: PeDebugInfo | null;
  version: PeVersionInfo | null;
}

export interface PeVersionInfo {
  file_version: string;
  product_version: string;
  major: number;
  minor: number;
  build: number;
  revision: number;
}

interface ExtractedPdbType {
  name: string;
  kind: KernelType["kind"];
  size: number;
  alignment: number;
  underlying_type?: string;
  reconstructed_c: string;
  fields: Array<{
    name: string;
    field_type_name: string;
    offset_bits: number;
    size_bits: number;
    value?: string;
  }>;
}

interface ExtractedPdbFunction {
  name: string;
  return_type: string;
  calling_convention: string;
  rva: string;
  size: number;
  is_public: boolean;
  parameters: Array<{ name: string; type: string }>;
}

export interface ExtractedPdbData {
  types: KernelType[];
  functions: KernelFunction[];
}

const exec_file = promisify(execFile);

export function hex(value: number | bigint, width = 0) {
  return `0x${value.toString(16).padStart(width, "0")}`;
}

export function id_part(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
}

function bounded_id_part(value: string, maximum = 80) {
  const normalized = id_part(value) || "unnamed";
  if (normalized.length <= maximum) { return normalized; }
  const digest = createHash("sha256").update(value).digest("hex").slice(0, 12);
  return `${normalized.slice(0, maximum)}_${digest}`;
}

export function machine_name(machine: number) {
  if (machine === 0x8664) { return "AMD64"; }
  if (machine === 0xaa64) { return "ARM64"; }
  if (machine === 0x14c) { return "I386"; }
  return hex(machine, 4);
}

function read_c_string(data: Buffer, offset: number) {
  if (offset < 0 || offset >= data.length) { return ""; }
  let end = offset;
  while (end < data.length && data[end] !== 0) {
    end += 1;
  }
  return data.subarray(offset, end).toString("utf8");
}

function read_utf16_key(data: Buffer, offset: number, end: number) {
  let cursor = offset;
  while (cursor + 1 < end && data.readUInt16LE(cursor) !== 0) {
    cursor += 2;
  }
  return {
    key: data.subarray(offset, cursor).toString("utf16le"),
    next: cursor + 2,
  };
}

function align4(value: number) {
  return (value + 3) & ~3;
}

function machine_to_arch(machine: number): Architecture {
  if (machine === 0x8664) { return "x64"; }
  if (machine === 0xaa64) { return "arm64"; }
  return "x86";
}

function format_guid(bytes: Buffer) {
  const data1 = bytes.readUInt32LE(0).toString(16).padStart(8, "0");
  const data2 = bytes.readUInt16LE(4).toString(16).padStart(4, "0");
  const data3 = bytes.readUInt16LE(6).toString(16).padStart(4, "0");
  const data4 = bytes.subarray(8, 10).toString("hex");
  const data5 = bytes.subarray(10, 16).toString("hex");
  return `${data1}-${data2}-${data3}-${data4}-${data5}`.toUpperCase();
}

function parse_data_directories(data: Buffer, optional: number, pe32_plus: boolean) {
  const data_dir_offset = optional + (pe32_plus ? 112 : 96);
  const directories: DataDirectory[] = [];
  for (let index = 0; index < 16; index += 1) {
    const offset = data_dir_offset + index * 8;
    directories.push({
      rva: data.readUInt32LE(offset),
      size: data.readUInt32LE(offset + 4),
    });
  }
  return directories;
}

function rva_to_offset(sections: ParsedSection[], rva: number) {
  for (const section of sections) {
    const start = section.virtual_address_number;
    const end = start + Math.max(section.virtual_size_number, section.raw_size_number);
    if (rva >= start && rva < end) {
      return section.raw_ptr + (rva - start);
    }
  }
  return rva;
}

function parse_debug(data: Buffer, sections: ParsedSection[], directory: DataDirectory): PeDebugInfo | null {
  if (!directory.rva || !directory.size) { return null; }
  const debug_offset = rva_to_offset(sections, directory.rva);
  const entries = Math.floor(directory.size / 28);
  for (let index = 0; index < entries; index += 1) {
    const offset = debug_offset + index * 28;
    if (offset + 28 > data.length) { continue; }
    const type = data.readUInt32LE(offset + 12);
    const size = data.readUInt32LE(offset + 16);
    const address = data.readUInt32LE(offset + 20);
    const raw = data.readUInt32LE(offset + 24) || rva_to_offset(sections, address);
    if (type !== 2 || raw + size > data.length || data.subarray(raw, raw + 4).toString("ascii") !== "RSDS") { continue; }

    const pdb_guid = format_guid(data.subarray(raw + 4, raw + 20));
    const pdb_age = data.readUInt32LE(raw + 20);
    const pdb_path = read_c_string(data, raw + 24);
    return {
      pdb_path,
      pdb_guid,
      pdb_identifier: `${pdb_guid.replace(/-/g, "")}${pdb_age.toString(16).toUpperCase()}`,
      pdb_age,
    };
  }
  return null;
}

function parse_exports(data: Buffer, sections: ParsedSection[], directory: DataDirectory) {
  if (!directory.rva || directory.size < 40) { return []; }
  const export_offset = rva_to_offset(sections, directory.rva);
  if (export_offset + 40 > data.length) { return []; }

  const base = data.readUInt32LE(export_offset + 16);
  const number_of_functions = data.readUInt32LE(export_offset + 20);
  const number_of_names = data.readUInt32LE(export_offset + 24);
  const functions_rva = data.readUInt32LE(export_offset + 28);
  const names_rva = data.readUInt32LE(export_offset + 32);
  const ordinals_rva = data.readUInt32LE(export_offset + 36);
  const functions_offset = rva_to_offset(sections, functions_rva);
  const names_offset = rva_to_offset(sections, names_rva);
  const ordinals_offset = rva_to_offset(sections, ordinals_rva);
  const exports: PeExport[] = [];

  for (let index = 0; index < number_of_names; index += 1) {
    const name_entry = names_offset + index * 4;
    const ordinal_entry = ordinals_offset + index * 2;
    if (name_entry + 4 > data.length || ordinal_entry + 2 > data.length) { continue; }
    const name_rva = data.readUInt32LE(name_entry);
    const ordinal_index = data.readUInt16LE(ordinal_entry);
    if (ordinal_index >= number_of_functions) { continue; }
    const function_entry = functions_offset + ordinal_index * 4;
    if (function_entry + 4 > data.length) { continue; }
    const rva = data.readUInt32LE(function_entry);
    const forwarder = rva >= directory.rva && rva < directory.rva + directory.size ? read_c_string(data, rva_to_offset(sections, rva)) : undefined;
    exports.push({
      name: read_c_string(data, rva_to_offset(sections, name_rva)),
      ordinal: base + ordinal_index,
      rva: hex(rva, 8),
      ...(forwarder ? { forwarder } : {}),
    });
  }

  return exports.filter((entry) => entry.name.length > 0).sort((left, right) => left.name.localeCompare(right.name));
}

function parse_imports(data: Buffer, sections: ParsedSection[], directory: DataDirectory, pe32_plus: boolean) {
  if (!directory.rva || directory.size < 20) { return []; }
  const imports: PeImport[] = [];
  let descriptor = rva_to_offset(sections, directory.rva);
  const thunk_size = pe32_plus ? 8 : 4;
  const ordinal_mask = pe32_plus ? 0x8000000000000000n : 0x80000000n;

  for (let descriptor_index = 0; descriptor_index < 512; descriptor_index += 1) {
    if (descriptor + 20 > data.length) { break; }
    const original_first_thunk = data.readUInt32LE(descriptor);
    const name_rva = data.readUInt32LE(descriptor + 12);
    const first_thunk = data.readUInt32LE(descriptor + 16);
    if (!original_first_thunk && !name_rva && !first_thunk) { break; }

    const dll = read_c_string(data, rva_to_offset(sections, name_rva));
    const functions: string[] = [];
    let thunk = rva_to_offset(sections, original_first_thunk || first_thunk);

    for (let thunk_index = 0; thunk_index < 2048; thunk_index += 1) {
      if (thunk + thunk_size > data.length) { break; }
      const value = pe32_plus ? data.readBigUInt64LE(thunk) : BigInt(data.readUInt32LE(thunk));
      if (value === 0n) { break; }
      if ((value & ordinal_mask) !== 0n) {
        functions.push(`ordinal_${Number(value & 0xffffn)}`);
      } else {
        const import_name_offset = rva_to_offset(sections, Number(value));
        functions.push(read_c_string(data, import_name_offset + 2));
      }
      thunk += thunk_size;
    }

    if (dll) {
      imports.push({ dll, functions: functions.filter(Boolean) });
    }
    descriptor += 20;
  }

  return imports.sort((left, right) => left.dll.localeCompare(right.dll));
}

function resource_entry(data: Buffer, base: number, directory_offset: number, wanted_id?: number) {
  if (base + directory_offset + 16 > data.length) { return undefined; }
  const dir = base + directory_offset;
  const named = data.readUInt16LE(dir + 12);
  const ids = data.readUInt16LE(dir + 14);
  const count = named + ids;
  for (let index = 0; index < count; index += 1) {
    const offset = dir + 16 + index * 8;
    if (offset + 8 > data.length) { break; }
    const name = data.readUInt32LE(offset);
    const value = data.readUInt32LE(offset + 4);
    const id = name & 0xffff;
    if (wanted_id === undefined || id === wanted_id) {
      return {
        id,
        directory: (value & 0x80000000) !== 0,
        offset: value & 0x7fffffff,
      };
    }
  }
  return undefined;
}

function version_resource_data(data: Buffer, sections: ParsedSection[], directory: DataDirectory) {
  if (!directory.rva || !directory.size) { return undefined; }
  const base = rva_to_offset(sections, directory.rva);
  const type_entry = resource_entry(data, base, 0, 16);
  if (!type_entry?.directory) { return undefined; }
  const name_entry = resource_entry(data, base, type_entry.offset);
  if (!name_entry?.directory) { return undefined; }
  const language_entry = resource_entry(data, base, name_entry.offset);
  if (!language_entry || language_entry.directory) { return undefined; }
  const data_entry = base + language_entry.offset;
  if (data_entry + 16 > data.length) { return undefined; }
  const data_rva = data.readUInt32LE(data_entry);
  const size = data.readUInt32LE(data_entry + 4);
  const offset = rva_to_offset(sections, data_rva);
  if (offset + size > data.length) { return undefined; }
  return data.subarray(offset, offset + size);
}

function parse_version_info(data: Buffer) {
  if (data.length < 40) { return null; }
  const length = data.readUInt16LE(0);
  const value_length = data.readUInt16LE(2);
  const key = read_utf16_key(data, 6, Math.min(length, data.length));
  if (key.key !== "VS_VERSION_INFO" || value_length < 52) { return null; }
  const value_offset = align4(key.next);
  if (value_offset + 52 > data.length || data.readUInt32LE(value_offset) !== 0xfeef04bd) { return null; }
  const file_ms = data.readUInt32LE(value_offset + 8);
  const file_ls = data.readUInt32LE(value_offset + 12);
  const product_ms = data.readUInt32LE(value_offset + 16);
  const product_ls = data.readUInt32LE(value_offset + 20);
  const major = file_ms >>> 16;
  const minor = file_ms & 0xffff;
  const build = file_ls >>> 16;
  const revision = file_ls & 0xffff;
  return {
    file_version: `${major}.${minor}.${build}.${revision}`,
    product_version: `${product_ms >>> 16}.${product_ms & 0xffff}.${product_ls >>> 16}.${product_ls & 0xffff}`,
    major,
    minor,
    build,
    revision,
  };
}

export function parse_pe(data: Buffer): ParsedPe {
  if (data.length < 0x100 || data.subarray(0, 2).toString("ascii") !== "MZ") {
    throw new Error("missing MZ header");
  }

  const pe_offset = data.readUInt32LE(0x3c);
  if (pe_offset + 24 > data.length || data.subarray(pe_offset, pe_offset + 4).toString("ascii") !== "PE\u0000\u0000") {
    throw new Error("missing PE signature");
  }

  const coff = pe_offset + 4;
  const machine = data.readUInt16LE(coff);
  const section_count = data.readUInt16LE(coff + 2);
  const timestamp = data.readUInt32LE(coff + 4);
  const optional_size = data.readUInt16LE(coff + 16);
  const optional = coff + 20;
  const magic = data.readUInt16LE(optional);
  const pe32_plus = magic === 0x20b;
  const image_base = pe32_plus ? data.readBigUInt64LE(optional + 24) : BigInt(data.readUInt32LE(optional + 28));
  const entry_point = data.readUInt32LE(optional + 16);
  const image_size = data.readUInt32LE(optional + 56);
  const checksum = data.readUInt32LE(optional + 64);
  const directories = parse_data_directories(data, optional, pe32_plus);
  const section_offset = optional + optional_size;
  const sections: ParsedSection[] = [];

  for (let index = 0; index < section_count; index += 1) {
    const offset = section_offset + index * 40;
    if (offset + 40 > data.length) { break; }
    const name = data.subarray(offset, offset + 8).toString("ascii").split(String.fromCharCode(0))[0] ?? "";
    const virtual_size = data.readUInt32LE(offset + 8);
    const virtual_address = data.readUInt32LE(offset + 12);
    const raw_size = data.readUInt32LE(offset + 16);
    const raw_ptr = data.readUInt32LE(offset + 20);
    const characteristics = data.readUInt32LE(offset + 36);
    const description = describe_section_characteristics(hex(characteristics, 8));
    sections.push({
      name,
      virtual_address: hex(virtual_address, 8),
      virtual_address_number: virtual_address,
      virtual_size,
      virtual_size_number: virtual_size,
      raw_size,
      raw_size_number: raw_size,
      raw_ptr,
      characteristics: hex(characteristics, 8),
      characteristics_raw: description.raw,
      characteristics_labels: description.labels,
      characteristics_summary: description.summary,
      content: description.content,
      permissions: description.permissions,
    });
  }

  const version_data = version_resource_data(data, sections, directories[2] ?? { rva: 0, size: 0 });
  return {
    machine,
    architecture: machine_to_arch(machine),
    timestamp,
    image_base,
    image_size,
    entry_point,
    checksum,
    sections,
    imports: parse_imports(data, sections, directories[1] ?? { rva: 0, size: 0 }, pe32_plus),
    exports: parse_exports(data, sections, directories[0] ?? { rva: 0, size: 0 }),
    debug: parse_debug(data, sections, directories[6] ?? { rva: 0, size: 0 }),
    version: version_data ? parse_version_info(version_data) : null,
  };
}

export function build_function_records(module: KernelModule, created_at: string) {
  const exports = (module.exports ?? []).filter((entry) => is_export_in_executable_section(entry, module));
  const sorted = [...exports].sort((left, right) => parse_hex(left.rva) - parse_hex(right.rva));
  const seen_ids = new Map<string, number>();
  return sorted.map((entry, index): KernelFunction => {
    const current_rva = parse_hex(entry.rva);
    const next_entry = sorted[index + 1];
    const next_rva = next_entry ? parse_hex(next_entry.rva) : current_rva;
    const size = next_rva > current_rva ? next_rva - current_rva : 0;
    const base_id = `fn_${id_part(module.name)}_${id_part(entry.name)}_${module.sha256.slice(0, 12)}`;
    const base_symbol_id = `sym_${id_part(module.name)}_${id_part(entry.name)}_${module.sha256.slice(0, 12)}`;
    const seen_count = seen_ids.get(base_id) ?? 0;
    seen_ids.set(base_id, seen_count + 1);
    const duplicate_suffix = seen_count === 0 ? "" : `_${id_part(`${entry.ordinal}_${entry.rva}`)}`;

    return {
      id: `${base_id}${duplicate_suffix}`,
      symbol_id: `${base_symbol_id}${duplicate_suffix}`,
      symbol_kind: "pe-export",
      module_id: module.id,
      name: entry.name,
      return_type: "exported symbol",
      calling_convention: "PE export",
      parameters_json: [],
      rva: entry.rva,
      size,
      confidence: 0.7,
      has_pattern: false,
      is_exported: true,
      created_at,
    };
  });
}

export function build_pdb_function_records(module: KernelModule, extracted: ExtractedPdbFunction[], created_at: string) {
  const export_names = new Set((module.exports ?? []).map((entry) => entry.name.toLowerCase()));
  const export_rvas = new Set((module.exports ?? []).map((entry) => parse_hex(entry.rva)));
  const unique = new Map<string, ExtractedPdbFunction>();
  for (const fn of extracted) {
    const rva = parse_hex(fn.rva);
    if (!fn.name?.trim() || rva <= 0) { continue; }
    const key = `${rva}:${fn.name.trim().toLowerCase()}`;
    const current = unique.get(key);
    if (!current || fn.parameters.length > current.parameters.length || (!fn.is_public && current.is_public)) {
      unique.set(key, { ...fn, name: fn.name.trim() });
    }
  }
  const sorted = Array.from(unique.values()).sort((left, right) => parse_hex(left.rva) - parse_hex(right.rva) || left.name.localeCompare(right.name));
  return sorted.map((entry, index): KernelFunction => {
    const rva_value = parse_hex(entry.rva);
    const next_rva = sorted[index + 1] ? parse_hex(sorted[index + 1]!.rva) : rva_value;
    const inferred_size = next_rva > rva_value ? next_rva - rva_value : 0;
    const size = entry.size > 0 ? entry.size : inferred_size;
    const rva = hex(rva_value, 8);
    const id_suffix = `${module.sha256.slice(0, 12)}_${id_part(rva)}`;
    const name_id = bounded_id_part(entry.name);
    const return_type = entry.return_type && entry.return_type !== "unknown" ? entry.return_type : "PDB symbol";
    const calling_convention = entry.calling_convention && entry.calling_convention !== "unknown" ? entry.calling_convention : "PDB public";
    return {
      id: `fn_${id_part(module.name)}_${name_id}_${id_suffix}`,
      symbol_id: `sym_${id_part(module.name)}_${name_id}_${id_suffix}`,
      module_id: module.id,
      name: entry.name,
      symbol_kind: entry.is_public ? "pdb-public" : "pdb-function",
      return_type,
      calling_convention,
      parameters_json: entry.parameters ?? [],
      rva,
      size,
      confidence: return_type === "PDB symbol" ? 0.84 : 0.96,
      has_pattern: false,
      is_exported: export_rvas.has(rva_value) || export_names.has(entry.name.toLowerCase()),
      created_at,
    };
  });
}

export function build_module_from_pe(file_path: string, data: Buffer, parsed: ParsedPe, build_id: string, created_at: string): KernelModule {
  const name = basename(file_path);
  const extension = extname(name).toLowerCase();
  const debug = parsed.debug;
  const sections = parsed.sections.map((section) => {
    const description = describe_section_characteristics(section);
    return {
      name: section.name,
      virtual_address: section.virtual_address,
      raw_offset: hex(section.raw_ptr, 8),
      virtual_size: section.virtual_size,
      raw_size: section.raw_size,
      characteristics: section.characteristics,
      characteristics_raw: description.raw,
      characteristics_labels: description.labels,
      characteristics_summary: description.summary,
      content: description.content,
      permissions: description.permissions,
    };
  });
  const function_count = parsed.exports.filter((entry) => is_export_in_executable_section(entry, { sections })).length;
  return {
    id: `mod_${id_part(name)}_${id_part(build_id)}_${createHash("sha256").update(data).digest("hex").slice(0, 12)}`,
    build_id,
    name,
    source_path: file_path,
    original_path: extension === ".sys" ? `\\SystemRoot\\System32\\drivers\\${name}` : `\\SystemRoot\\System32\\${name}`,
    image_base: hex(parsed.image_base),
    image_size: parsed.image_size,
    entry_point: hex(parsed.entry_point, 8),
    machine: machine_name(parsed.machine),
    timestamp: hex(parsed.timestamp, 8),
    checksum: hex(parsed.checksum, 8),
    sha256: createHash("sha256").update(data).digest("hex"),
    pdb_name: debug?.pdb_path ? basename(debug.pdb_path) : `${name}.pdb`,
    pdb_guid: debug?.pdb_guid ?? "",
    pdb_age: debug?.pdb_age ?? 0,
    symbol_count: parsed.exports.length + parsed.imports.reduce((total, item) => total + item.functions.length, 0),
    type_count: 0,
    function_count,
    sections,
    imports: parsed.imports,
    exports: parsed.exports,
    debug,
    created_at,
  };
}

export async function extract_pdb_data(module: KernelModule, pdb_path: string, pdb_dump_exe: string, dia_dll: string, build_number: string, architecture: Architecture): Promise<ExtractedPdbData> {
  const { stdout } = await exec_file(pdb_dump_exe, [dia_dll, pdb_path], {
    encoding: "utf8",
    maxBuffer: 512 * 1024 * 1024,
    timeout: 900000,
    killSignal: "SIGKILL",
  });
  const parsed = JSON.parse(stdout) as { types?: ExtractedPdbType[]; functions?: ExtractedPdbFunction[] };

  const types = (parsed.types ?? []).map((type, type_index): KernelType => {
    const type_name_id = bounded_id_part(type.name);
    const type_id = `type_${id_part(module.name)}_${type_name_id}_${id_part(build_number)}_${architecture}_${module.sha256.slice(0, 12)}_${type_index}`;
    return {
      id: type_id,
      module_id: module.id,
      name: type.name,
      kind: type.kind,
      size: type.size,
      alignment: type.alignment,
      reconstructed_c: type.reconstructed_c,
      hash: createHash("sha256").update(type.reconstructed_c).digest("hex").slice(0, 24),
      fields: type.fields.map((field, index) => ({
        id: `field_${type_name_id}_${bounded_id_part(field.name, 48)}_${index}_${module.sha256.slice(0, 12)}`,
        type_id,
        name: field.name,
        field_type_name: field.field_type_name,
        offset_bits: field.offset_bits,
        size_bits: field.size_bits,
        flags_json: {
          source: "dia",
          offset_hex: hex(field.offset_bits / 8),
          ...(field.value !== undefined ? { enum_value: field.value } : {}),
        },
      })),
      created_at: module.created_at,
    };
  });
  return {
    types,
    functions: build_pdb_function_records(module, parsed.functions ?? [], module.created_at),
  };
}
