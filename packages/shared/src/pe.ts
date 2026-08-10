import type { KernelFunction, KernelModule, PeExport, PeSection } from "./types";

export interface SectionCharacteristicsDescription {
  raw: string;
  value: number;
  content: string[];
  permissions: string[];
  attributes: string[];
  labels: string[];
  summary: string;
  unknown_mask?: string;
}

interface FlagDefinition {
  mask: number;
  label: string;
  group: "content" | "permissions" | "attributes";
}

const flag_definitions: FlagDefinition[] = [
  { mask: 0x00000008, label: "no padding", group: "attributes" },
  { mask: 0x00000020, label: "code", group: "content" },
  { mask: 0x00000040, label: "initialized data", group: "content" },
  { mask: 0x00000080, label: "uninitialized data", group: "content" },
  { mask: 0x00000100, label: "link other", group: "attributes" },
  { mask: 0x00000200, label: "link info", group: "attributes" },
  { mask: 0x00000800, label: "link remove", group: "attributes" },
  { mask: 0x00001000, label: "COMDAT", group: "attributes" },
  { mask: 0x00004000, label: "no deferred spec exceptions", group: "attributes" },
  { mask: 0x00008000, label: "global pointer relative", group: "attributes" },
  { mask: 0x00020000, label: "purgeable or 16-bit", group: "attributes" },
  { mask: 0x00040000, label: "locked", group: "attributes" },
  { mask: 0x00080000, label: "preload", group: "attributes" },
  { mask: 0x01000000, label: "extended relocations", group: "attributes" },
  { mask: 0x02000000, label: "discardable", group: "attributes" },
  { mask: 0x04000000, label: "not cached", group: "attributes" },
  { mask: 0x08000000, label: "not paged", group: "attributes" },
  { mask: 0x10000000, label: "shared", group: "attributes" },
  { mask: 0x20000000, label: "execute", group: "permissions" },
  { mask: 0x40000000, label: "read", group: "permissions" },
  { mask: 0x80000000, label: "write", group: "permissions" },
];

const alignments = new Map<number, string>([
  [0x00100000, "align 1"],
  [0x00200000, "align 2"],
  [0x00300000, "align 4"],
  [0x00400000, "align 8"],
  [0x00500000, "align 16"],
  [0x00600000, "align 32"],
  [0x00700000, "align 64"],
  [0x00800000, "align 128"],
  [0x00900000, "align 256"],
  [0x00a00000, "align 512"],
  [0x00b00000, "align 1024"],
  [0x00c00000, "align 2048"],
  [0x00d00000, "align 4096"],
  [0x00e00000, "align 8192"],
]);

const alignment_mask = 0x00f00000;
const recognized_mask = flag_definitions.reduce((mask, flag) => mask | flag.mask, alignment_mask);

export function parse_hex(value: string | number | undefined) {
  if (typeof value === "number") { return Number.isFinite(value) ? value : 0; }
  const normalized = value?.trim().toLowerCase() ?? "";
  if (!normalized) { return 0; }
  const parsed = Number.parseInt(normalized.startsWith("0x") ? normalized.slice(2) : normalized, 16);
  return Number.isFinite(parsed) ? parsed : 0;
}

export function format_hex(value: number, width = 8) {
  return `0x${(value >>> 0).toString(16).padStart(width, "0")}`;
}

export function describe_section_characteristics(input: string | Pick<PeSection, "characteristics"> | undefined): SectionCharacteristicsDescription {
  const value = typeof input === "string" || input === undefined ? parse_hex(input) : parse_hex(input.characteristics);
  const content: string[] = [];
  const permissions: string[] = [];
  const attributes: string[] = [];

  for (const flag of flag_definitions) {
    if ((value & flag.mask) === 0) { continue; }
    if (flag.group === "content") { content.push(flag.label); }
    if (flag.group === "permissions") { permissions.push(flag.label); }
    if (flag.group === "attributes") { attributes.push(flag.label); }
  }

  const alignment = alignments.get(value & alignment_mask);
  if (alignment) { attributes.push(alignment); }

  const unknown = value & ~recognized_mask;
  if (unknown !== 0) { attributes.push(`unknown ${format_hex(unknown)}`); }

  const labels = [...content, ...permissions, ...attributes];
  return {
    raw: format_hex(value),
    value,
    content,
    permissions,
    attributes,
    labels,
    summary: labels.length > 0 ? labels.join(", ") : "no section characteristics",
    ...(unknown !== 0 ? { unknown_mask: format_hex(unknown) } : {}),
  };
}

export function interpret_section(section: PeSection): PeSection {
  const description = describe_section_characteristics(section);
  return {
    ...section,
    characteristics_raw: section.characteristics_raw ?? description.raw,
    characteristics_labels: section.characteristics_labels ?? description.labels,
    characteristics_summary: section.characteristics_summary ?? description.summary,
    content: section.content ?? description.content,
    permissions: section.permissions ?? description.permissions,
  };
}

export function interpret_module_sections<T extends KernelModule>(module: T): T {
  const interpreted = !module.sections?.length ? module : {
    ...module,
    sections: module.sections.map((section) => interpret_section(section)),
  };
  const executable_export_count = interpreted.exports
    ? interpreted.exports.filter((entry) => is_export_in_executable_section(entry, interpreted)).length
    : 0;
  return {
    ...interpreted,
    function_count: Math.max(interpreted.function_count, executable_export_count),
  } as T;
}

export function section_contains_rva(section: PeSection, rva: number) {
  const start = parse_hex(section.virtual_address);
  const end = start + Math.max(section.virtual_size, section.raw_size);
  return rva >= start && rva < end;
}

export function section_for_rva(module: Pick<KernelModule, "sections"> | undefined, rva: number): PeSection | undefined {
  return module?.sections?.find((section) => section_contains_rva(section, rva));
}

export function is_executable_section(section: PeSection | undefined) {
  return section ? (parse_hex(section.characteristics) & 0x20000000) !== 0 : false;
}

export function is_export_in_executable_section(entry: Pick<PeExport, "rva" | "forwarder">, module: Pick<KernelModule, "sections"> | undefined) {
  if (entry.forwarder) { return false; }
  if (!module?.sections?.length) { return true; }
  return is_executable_section(section_for_rva(module, parse_hex(entry.rva)));
}

export function is_function_in_executable_section(fn: Pick<KernelFunction, "rva">, module: Pick<KernelModule, "sections"> | undefined) {
  if (!module?.sections?.length) { return true; }
  return is_executable_section(section_for_rva(module, parse_hex(fn.rva)));
}
