export type Architecture = "x64" | "arm64" | "x86";

export type EntityKind = "type" | "function" | "enum" | "union" | "typedef" | "module" | "symbol" | "field";

export type PatternStatus = "excellent" | "good" | "risky" | "rejected";

export interface PeSection {
  name: string;
  virtual_address: string;
  raw_offset?: string;
  virtual_size: number;
  raw_size: number;
  characteristics: string;
  characteristics_raw?: string;
  characteristics_labels?: string[];
  characteristics_summary?: string;
  content?: string[];
  permissions?: string[];
}

export interface PeImport {
  dll: string;
  functions: string[];
}

export interface PeExport {
  name: string;
  ordinal: number;
  rva: string;
  forwarder?: string;
}

export interface PeDebugInfo {
  pdb_path: string;
  pdb_guid: string;
  pdb_identifier: string;
  pdb_age: number;
}

export interface WindowsBuild {
  id: string;
  product_name: string;
  version: string;
  build_number: string;
  revision: string;
  architecture: Architecture;
  release_channel: string;
  published: boolean;
  created_at: string;
}

export interface KernelModule {
  id: string;
  build_id: string;
  name: string;
  source_path?: string;
  binary_available?: boolean;
  original_path: string;
  image_base: string;
  image_size: number;
  entry_point?: string;
  machine?: string;
  timestamp: string;
  checksum: string;
  sha256: string;
  pdb_name: string;
  pdb_guid: string;
  pdb_age: number;
  symbol_count: number;
  type_count: number;
  function_count: number;
  sections?: PeSection[];
  imports?: PeImport[];
  exports?: PeExport[];
  debug?: PeDebugInfo | null;
  created_at: string;
}

export interface TypeField {
  id: string;
  type_id: string;
  name: string;
  field_type_name: string;
  offset_bits: number;
  size_bits: number;
  flags_json: Record<string, unknown>;
}

export interface KernelType {
  id: string;
  module_id: string;
  name: string;
  kind: "struct" | "union" | "enum" | "typedef";
  size: number;
  alignment: number;
  reconstructed_c: string;
  hash: string;
  fields: TypeField[];
  created_at: string;
}

export interface KernelTypeSummary {
  id: string;
  module_id: string;
  name: string;
  kind: KernelType["kind"];
  size: number;
  alignment: number;
  field_count: number;
  hash: string;
}

export interface KernelFunction {
  id: string;
  symbol_id: string;
  module_id: string;
  name: string;
  symbol_kind?: "pdb-function" | "pdb-public" | "pe-export";
  return_type: string;
  calling_convention: string;
  parameters_json: Array<{ name: string; type: string }>;
  rva: string;
  size: number;
  confidence: number;
  has_pattern: boolean;
  is_exported: boolean;
  created_at: string;
}

export interface PatternResult {
  id: string;
  function_id: string;
  module_id: string;
  binary_sha256: string;
  pattern: string;
  mask: string;
  format: string;
  length: number;
  confidence: number;
  collision_count: number;
  tested_builds_json: string[];
  status: PatternStatus;
  created_at: string;
}

export type PatternCrossReferenceStatus = "tested" | "stored-pattern" | "symbol-only" | "function-missing" | "module-missing" | "error";
export type PatternScope = "multi-build" | "per-build" | "stored";

export interface PatternCrossReferenceTarget {
  build: WindowsBuild;
  build_label: string;
  module_name: string;
  module?: KernelModule;
  fn?: KernelFunction;
  stored_pattern?: PatternResult;
}

export interface PatternCrossReferenceRow {
  build_id: string;
  build_label: string;
  architecture: Architecture;
  module_id?: string;
  module_name: string;
  function_id?: string;
  function_name: string;
  rva?: string;
  binary_sha256?: string;
  pattern_id?: string;
  pattern_status?: PatternStatus;
  confidence?: number;
  collision_count?: number;
  length?: number;
  pattern?: string;
  mask?: string;
  pattern_scope?: PatternScope;
  status: PatternCrossReferenceStatus;
  note: string;
}

export interface PatternCrossReferenceResult {
  function_id: string;
  function_name: string;
  module_name: string;
  rows: PatternCrossReferenceRow[];
}

export type PdbLookupStatus = "no-debug-info" | "cached" | "downloaded" | "missing" | "download-failed";

export type ModulePdbState = PdbLookupStatus | "unchecked";

export interface ModulePdbStatus {
  module_id: string;
  status: ModulePdbState;
  available: boolean;
  checking: boolean;
  can_retry: boolean;
  requires_admin: boolean;
  provider: string;
  pdb_name?: string;
  pdb_identifier?: string;
  symbol_url?: string;
  last_checked_at?: string;
  message: string;
}

export type BuildDetectionSource = "version-resource" | "manual" | "timestamp-fallback";

export interface PdbLookupResult {
  status: PdbLookupStatus;
  pdb_name?: string;
  pdb_identifier?: string;
  symbol_url?: string;
  cache_path?: string;
  message: string;
}

export interface BinaryIngestionRecord {
  id: string;
  filename: string;
  sha256: string;
  cache_path: string;
  build_id: string;
  module_id: string;
  module_name: string;
  build_label: string;
  architecture: Architecture;
  pdb_status: PdbLookupStatus;
  build_detection_source?: BuildDetectionSource;
  parser_version?: string;
  symbol_url?: string;
  created_at: string;
}

export interface BinaryIngestionResult {
  ingestion: BinaryIngestionRecord;
  build: WindowsBuild;
  module: KernelModule;
  function_count: number;
  type_count: number;
  pdb_lookup: PdbLookupResult;
  build_detection_source: BuildDetectionSource;
  manual_identification_required: boolean;
  cache_hit: boolean;
}


export type ArchiveFileStatus = "pending" | "indexed" | "cached" | "skipped" | "failed" | "missing";

export interface ArchiveFileRecord {
  id: string;
  relative_path: string;
  source_group: string;
  identity_version: string;
  identity_key: string;
  group_fingerprint: string;
  size: number;
  modified_at: string;
  fingerprint: string;
  status: ArchiveFileStatus;
  message: string;
  sha256?: string;
  ingestion_id?: string;
  build_id?: string;
  module_id?: string;
  module_name?: string;
  pdb_status?: PdbLookupStatus;
  function_count?: number;
  type_count?: number;
  created_at: string;
  updated_at: string;
}

export type ArchiveScanState = "idle" | "scanning" | "completed" | "failed";
export type ArchiveScanReason = "startup" | "watch" | "interval" | "manual";

export interface ArchiveScanStatus {
  state: ArchiveScanState;
  reason?: ArchiveScanReason;
  root: string;
  watching: boolean;
  queued: boolean;
  scan_id?: string;
  started_at?: string;
  completed_at?: string;
  discovered_files: number;
  portable_executables: number;
  processed_files: number;
  unchanged_files: number;
  indexed_files: number;
  cached_files: number;
  skipped_files: number;
  failed_files: number;
  current_file?: string;
  last_error?: string;
}
export interface SearchResult {
  id: string;
  kind: EntityKind;
  name: string;
  module: string;
  build_id?: string;
  build: string;
  architecture: Architecture;
  api_url: string;
  web_url: string;
  score: number;
}

export interface DiffResult {
  entity_kind: "type" | "function" | "module";
  entity_name: string;
  from_build_id: string;
  to_build_id: string;
  summary: string;
  changes: Array<{ kind: string; path: string; before: unknown; after: unknown }>;
}

export interface TypeCompareOccurrence {
  build_id: string;
  build_label: string;
  product_name: string;
  version: string;
  build_number: string;
  revision: string;
  architecture: Architecture;
  module_id: string;
  module_name: string;
  type_id: string;
  type_name: string;
  kind: KernelType["kind"];
  size: number;
  alignment: number;
  field_count: number;
}

export type TypeCompareLineKind = "added" | "removed";

export interface TypeCompareLine {
  kind: TypeCompareLineKind;
  field_name: string;
  text: string;
  pair_id?: string;
}

export interface TypeCompareStep {
  from: TypeCompareOccurrence;
  to: TypeCompareOccurrence;
  additions: number;
  removals: number;
  modifications: number;
  summary: string;
  lines: TypeCompareLine[];
}

export interface TypeCompareResult {
  type_id: string;
  type_name: string;
  occurrences: TypeCompareOccurrence[];
  steps: TypeCompareStep[];
}

export interface TypeFieldReference {
  build_id: string;
  build_label: string;
  module_id: string;
  module_name: string;
  type_id: string;
  type_name: string;
  type_kind: KernelType["kind"];
  field_id: string;
  field_name: string;
  field_type_name: string;
  offset_bits: number;
}

export interface TypeFunctionReference {
  build_id: string;
  build_label: string;
  module_id: string;
  module_name: string;
  function_id: string;
  function_name: string;
  signature: string;
  rva: string;
}
