import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Architecture, KernelFunction, KernelModule, KernelType, PeDebugInfo, PeExport, PeImport, PeSection, WindowsBuild } from "@kernelarchive/shared";

interface DataDirectory {
  rva: number;
  size: number;
}

interface ParsedPe {
  machine: number;
  architecture: Architecture;
  timestamp: number;
  image_base: bigint;
  image_size: number;
  entry_point: number;
  checksum: number;
  sections: Array<PeSection & { raw_ptr: number; virtual_address_number: number; virtual_size_number: number; raw_size_number: number }>;
  imports: PeImport[];
  exports: PeExport[];
  debug: PeDebugInfo | null;
}

interface ExtractedPdbType {
  name: string;
  kind: "struct" | "union";
  size: number;
  alignment: number;
  reconstructed_c: string;
  fields: Array<{
    name: string;
    field_type_name: string;
    offset_bits: number;
    size_bits: number;
  }>;
}

const module_names = [
  "ntoskrnl.exe",
  "hal.dll",
  "ndis.sys",
  "tcpip.sys",
  "netio.sys",
  "fltmgr.sys",
  "ntfs.sys",
  "fastfat.sys",
  "win32kbase.sys",
  "win32kfull.sys",
  "dxgkrnl.sys",
  "ci.dll",
  "cng.sys",
  "ksecdd.sys",
  "storport.sys",
  "acpi.sys",
];

const pdb_type_names = [
  "_EPROCESS",
  "_ETHREAD",
  "_KTHREAD",
  "_KPROCESS",
  "_DRIVER_OBJECT",
  "_DEVICE_OBJECT",
  "_UNICODE_STRING",
  "_LIST_ENTRY",
  "_OBJECT_ATTRIBUTES",
  "_CLIENT_ID",
  "_IO_STACK_LOCATION",
  "_IRP",
  "_MDL",
  "_FILE_OBJECT",
  "_PEB",
  "_KAPC_STATE",
];

const known_function_prototypes: Record<string, Pick<KernelFunction, "return_type" | "calling_convention" | "parameters_json">> = {
  PsLookupProcessByProcessId: {
    return_type: "NTSTATUS",
    calling_convention: "NTAPI",
    parameters_json: [
      { name: "ProcessId", type: "HANDLE" },
      { name: "Process", type: "PEPROCESS*" },
    ],
  },
  ObReferenceObjectByHandle: {
    return_type: "NTSTATUS",
    calling_convention: "NTAPI",
    parameters_json: [
      { name: "Handle", type: "HANDLE" },
      { name: "DesiredAccess", type: "ACCESS_MASK" },
      { name: "ObjectType", type: "POBJECT_TYPE" },
      { name: "AccessMode", type: "KPROCESSOR_MODE" },
      { name: "Object", type: "PVOID*" },
      { name: "HandleInformation", type: "POBJECT_HANDLE_INFORMATION" },
    ],
  },
  IoCreateDevice: {
    return_type: "NTSTATUS",
    calling_convention: "NTAPI",
    parameters_json: [
      { name: "DriverObject", type: "PDRIVER_OBJECT" },
      { name: "DeviceExtensionSize", type: "ULONG" },
      { name: "DeviceName", type: "PUNICODE_STRING" },
      { name: "DeviceType", type: "DEVICE_TYPE" },
      { name: "DeviceCharacteristics", type: "ULONG" },
      { name: "Exclusive", type: "BOOLEAN" },
      { name: "DeviceObject", type: "PDEVICE_OBJECT*" },
    ],
  },
  IoDeleteDevice: {
    return_type: "VOID",
    calling_convention: "NTAPI",
    parameters_json: [{ name: "DeviceObject", type: "PDEVICE_OBJECT" }],
  },
  KeStackAttachProcess: {
    return_type: "VOID",
    calling_convention: "NTAPI",
    parameters_json: [
      { name: "Process", type: "PRKPROCESS" },
      { name: "ApcState", type: "PRKAPC_STATE" },
    ],
  },
  KeUnstackDetachProcess: {
    return_type: "VOID",
    calling_convention: "NTAPI",
    parameters_json: [{ name: "ApcState", type: "PRKAPC_STATE" }],
  },
  PsGetCurrentProcess: {
    return_type: "PEPROCESS",
    calling_convention: "NTAPI",
    parameters_json: [],
  },
  PsGetCurrentThread: {
    return_type: "PETHREAD",
    calling_convention: "NTAPI",
    parameters_json: [],
  },
  RtlInitUnicodeString: {
    return_type: "VOID",
    calling_convention: "NTAPI",
    parameters_json: [
      { name: "DestinationString", type: "PUNICODE_STRING" },
      { name: "SourceString", type: "PCWSTR" },
    ],
  },
  RtlCopyUnicodeString: {
    return_type: "VOID",
    calling_convention: "NTAPI",
    parameters_json: [
      { name: "DestinationString", type: "PUNICODE_STRING" },
      { name: "SourceString", type: "PCUNICODE_STRING" },
    ],
  },
  MmCopyVirtualMemory: {
    return_type: "NTSTATUS",
    calling_convention: "NTAPI",
    parameters_json: [
      { name: "SourceProcess", type: "PEPROCESS" },
      { name: "SourceAddress", type: "PVOID" },
      { name: "TargetProcess", type: "PEPROCESS" },
      { name: "TargetAddress", type: "PVOID" },
      { name: "BufferSize", type: "SIZE_T" },
      { name: "PreviousMode", type: "KPROCESSOR_MODE" },
      { name: "ReturnSize", type: "PSIZE_T" },
    ],
  },
};

const system_root = process.env.SystemRoot ?? "C:\\Windows";
const system32 = join(system_root, "System32");
const drivers = join(system32, "drivers");
const created_at = new Date().toISOString();
const repo_root = join(dirname(fileURLToPath(import.meta.url)), "..");
const pdb_dump_exe = join(repo_root, "tools", "pdb-dump", "pdb_dump.exe");
const dia_dll = "C:\\Program Files\\Microsoft Visual Studio\\2022\\Enterprise\\DIA SDK\\bin\\amd64\\msdia140.dll";

function hex(value: number | bigint, width = 0) {
  return `0x${value.toString(16).padStart(width, "0")}`;
}

function id_part(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
}

function read_c_string(data: Buffer, offset: number) {
  if (offset < 0 || offset >= data.length) { return ""; }
  let end = offset;
  while (end < data.length && data[end] !== 0) {
    end += 1;
  }
  return data.subarray(offset, end).toString("utf8");
}

function machine_to_arch(machine: number): Architecture {
  if (machine === 0x8664) { return "x64"; }
  if (machine === 0xaa64) { return "arm64"; }
  return "x86";
}

function machine_name(machine: number) {
  if (machine === 0x8664) { return "AMD64"; }
  if (machine === 0xaa64) { return "ARM64"; }
  if (machine === 0x14c) { return "I386"; }
  return hex(machine, 4);
}

function read_registry() {
  try {
    return execFileSync("reg", ["query", "HKLM\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion"], { encoding: "utf8" });
  } catch {
    return "";
  }
}

function registry_value(registry: string, name: string) {
  const line = registry.split(/\r?\n/).find((entry) => entry.trimStart().startsWith(name));
  if (!line) { return ""; }
  const match = line.match(/\s+REG_\w+\s+(.+)$/);
  return match?.[1]?.trim() ?? "";
}

function registry_dword(registry: string, name: string) {
  const value = registry_value(registry, name);
  if (value.startsWith("0x")) { return Number.parseInt(value.slice(2), 16).toString(10); }
  return value || "0";
}

function system_paths(name: string) {
  return [join(system32, name), join(drivers, name)];
}

function find_module_path(name: string) {
  return system_paths(name).find((path) => existsSync(path));
}

function find_cached_pdb(module: KernelModule) {
  if (!module.pdb_name || !module.debug?.pdb_identifier) { return undefined; }
  const candidates = [
    join("C:\\Symbols", module.pdb_name, module.debug.pdb_identifier, module.pdb_name),
    join("C:\\ProgramData\\Dbg\\sym", module.pdb_name, module.debug.pdb_identifier, module.pdb_name),
    join("C:\\Users\\Admin\\AppData\\Local\\Temp\\ida", module.pdb_name, module.debug.pdb_identifier, module.pdb_name),
  ];
  return candidates.find((path) => existsSync(path));
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

function rva_to_offset(sections: ParsedPe["sections"], rva: number) {
  for (const section of sections) {
    const start = section.virtual_address_number;
    const end = start + Math.max(section.virtual_size_number, section.raw_size_number);
    if (rva >= start && rva < end) {
      return section.raw_ptr + (rva - start);
    }
  }
  return rva;
}

function parse_debug(data: Buffer, sections: ParsedPe["sections"], directory: DataDirectory): PeDebugInfo | null {
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

function parse_exports(data: Buffer, sections: ParsedPe["sections"], directory: DataDirectory) {
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

function parse_imports(data: Buffer, sections: ParsedPe["sections"], directory: DataDirectory, pe32_plus: boolean) {
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

function parse_pe(data: Buffer): ParsedPe {
  if (data.subarray(0, 2).toString("ascii") !== "MZ") {
    throw new Error("missing MZ header");
  }

  const pe_offset = data.readUInt32LE(0x3c);
  if (data.subarray(pe_offset, pe_offset + 4).toString("ascii") !== "PE\u0000\u0000") {
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
  const sections: ParsedPe["sections"] = [];

  for (let index = 0; index < section_count; index += 1) {
    const offset = section_offset + index * 40;
    const name = data.subarray(offset, offset + 8).toString("ascii").split(String.fromCharCode(0))[0] ?? "";
    const virtual_size = data.readUInt32LE(offset + 8);
    const virtual_address = data.readUInt32LE(offset + 12);
    const raw_size = data.readUInt32LE(offset + 16);
    const raw_ptr = data.readUInt32LE(offset + 20);
    const characteristics = data.readUInt32LE(offset + 36);
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
    });
  }

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
  };
}

function build_function_records(module: KernelModule) {
  const exports = module.exports ?? [];
  const sorted = [...exports].sort((left, right) => Number.parseInt(left.rva.slice(2), 16) - Number.parseInt(right.rva.slice(2), 16));
  const seen_ids = new Map<string, number>();
  return sorted.map((entry, index): KernelFunction => {
    const current_rva = Number.parseInt(entry.rva.slice(2), 16);
    const next_entry = sorted[index + 1];
    const next_rva = next_entry ? Number.parseInt(next_entry.rva.slice(2), 16) : current_rva;
    const size = next_rva > current_rva ? next_rva - current_rva : 0;
    const prototype = known_function_prototypes[entry.name];
    const base_id = `fn_${id_part(module.name)}_${id_part(entry.name)}`;
    const base_symbol_id = `sym_${id_part(module.name)}_${id_part(entry.name)}`;
    const seen_count = seen_ids.get(base_id) ?? 0;
    seen_ids.set(base_id, seen_count + 1);
    const duplicate_suffix = seen_count === 0 ? "" : `_${id_part(`${entry.ordinal}_${entry.rva}`)}`;

    return {
      id: `${base_id}${duplicate_suffix}`,
      symbol_id: `${base_symbol_id}${duplicate_suffix}`,
      module_id: module.id,
      name: entry.name,
      return_type: prototype?.return_type ?? "exported symbol",
      calling_convention: prototype?.calling_convention ?? "PE export",
      parameters_json: prototype?.parameters_json ?? [],
      rva: entry.rva,
      size,
      confidence: prototype ? 0.92 : 0.7,
      has_pattern: false,
      is_exported: true,
      created_at,
    };
  });
}

function extract_pdb_types(module: KernelModule): KernelType[] {
  if (!existsSync(pdb_dump_exe) || !existsSync(dia_dll)) { return []; }
  const pdb_path = find_cached_pdb(module);
  if (!pdb_path) { return []; }

  let parsed: { types: ExtractedPdbType[] };
  try {
    const output = execFileSync(pdb_dump_exe, [dia_dll, pdb_path, ...pdb_type_names], { encoding: "utf8", maxBuffer: 128 * 1024 * 1024 });
    parsed = JSON.parse(output) as { types: ExtractedPdbType[] };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`PDB type extraction failed for ${module.name}: ${message}`);
    return [];
  }

  return parsed.types.map((type): KernelType => {
    const type_id = `type_${id_part(module.name)}_${id_part(type.name)}_${id_part(build_number)}_${architecture}`;
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
        id: `field_${id_part(type.name)}_${id_part(field.name)}_${index}`,
        type_id,
        name: field.name,
        field_type_name: field.field_type_name,
        offset_bits: field.offset_bits,
        size_bits: field.size_bits,
        flags_json: { source: "dia", offset_hex: hex(field.offset_bits / 8) },
      })),
      created_at,
    };
  });
}

const registry = read_registry();
const product_name = registry_value(registry, "ProductName") || "Windows";
const version = registry_value(registry, "DisplayVersion") || registry_value(registry, "ReleaseId") || "current";
const build_number = registry_value(registry, "CurrentBuildNumber") || "current";
const revision = registry_dword(registry, "UBR");
const module_paths = module_names.map((name) => find_module_path(name)).filter((path): path is string => Boolean(path));
const parsed_modules = module_paths.map((path) => {
  const data = readFileSync(path);
  const parsed = parse_pe(data);
  return { path, data, parsed };
});
const architecture = parsed_modules[0]?.parsed.architecture ?? "x64";
const build_id = `build_${id_part(build_number)}_${id_part(revision)}_${architecture}`;
const build: WindowsBuild = {
  id: build_id,
  product_name,
  version,
  build_number,
  revision,
  architecture,
  release_channel: "local-system",
  published: true,
  created_at,
};

let modules: KernelModule[] = parsed_modules.map(({ path, data, parsed }) => {
  const name = basename(path);
  const imports = parsed.imports;
  const exports = parsed.exports;
  const debug = parsed.debug;
  return {
    id: `mod_${id_part(name)}_${id_part(build_number)}_${architecture}`,
    build_id,
    name,
    source_path: path,
    original_path: path.replace(system_root, "\\SystemRoot"),
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
    symbol_count: exports.length + imports.reduce((total, item) => total + item.functions.length, 0),
    type_count: 0,
    function_count: exports.length,
    sections: parsed.sections.map((section) => ({
      name: section.name,
      virtual_address: section.virtual_address,
      raw_offset: hex(section.raw_ptr, 8),
      virtual_size: section.virtual_size,
      raw_size: section.raw_size,
      characteristics: section.characteristics,
    })),
    imports,
    exports,
    debug,
    created_at,
  };
});

const types = modules.flatMap((module) => module.name.toLowerCase() === "ntoskrnl.exe" ? extract_pdb_types(module) : []);
modules = modules.map((module) => ({
  ...module,
  type_count: types.filter((type) => type.module_id === module.id).length,
}));

const functions = modules.flatMap(build_function_records);
const output = `import type { KernelFunction, KernelModule, KernelType, PatternResult, WindowsBuild } from "./types";

export const system_builds: WindowsBuild[] = ${JSON.stringify([build], null, 2)};
export const system_modules: KernelModule[] = ${JSON.stringify(modules, null, 2)};
export const system_types: KernelType[] = ${JSON.stringify(types, null, 2)};
export const system_functions: KernelFunction[] = ${JSON.stringify(functions, null, 2)};
export const system_patterns: PatternResult[] = [];
`;

writeFileSync(join(repo_root, "packages", "shared", "src", "generated-system-data.ts"), output);
console.log(JSON.stringify({ build, module_count: modules.length, type_count: types.length, function_count: functions.length }, null, 2));
