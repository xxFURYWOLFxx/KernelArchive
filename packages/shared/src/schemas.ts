import { z } from "zod";

export const architecture_schema = z.enum(["x64", "arm64", "x86"]);

export const entity_kind_schema = z.enum(["type", "function", "enum", "union", "typedef", "module", "symbol", "field"]);

export const windows_build_schema = z.object({
  id: z.string(),
  product_name: z.string(),
  version: z.string(),
  build_number: z.string(),
  revision: z.string(),
  architecture: architecture_schema,
  release_channel: z.string(),
  published: z.boolean(),
  created_at: z.string(),
});

export const pe_section_schema = z.object({
  name: z.string(),
  virtual_address: z.string(),
  raw_offset: z.string().optional(),
  virtual_size: z.number(),
  raw_size: z.number(),
  characteristics: z.string(),
  characteristics_raw: z.string().optional(),
  characteristics_labels: z.array(z.string()).optional(),
  characteristics_summary: z.string().optional(),
  content: z.array(z.string()).optional(),
  permissions: z.array(z.string()).optional(),
});

export const module_schema = z.object({
  id: z.string(),
  build_id: z.string(),
  name: z.string(),
  source_path: z.string().optional(),
  original_path: z.string(),
  image_base: z.string(),
  image_size: z.number(),
  entry_point: z.string().optional(),
  machine: z.string().optional(),
  timestamp: z.string(),
  checksum: z.string(),
  sha256: z.string(),
  pdb_name: z.string(),
  pdb_guid: z.string(),
  pdb_age: z.number(),
  symbol_count: z.number(),
  type_count: z.number(),
  function_count: z.number(),
  sections: z.array(pe_section_schema).optional(),
  created_at: z.string(),
});

export const type_field_schema = z.object({
  id: z.string(),
  type_id: z.string(),
  name: z.string(),
  field_type_name: z.string(),
  offset_bits: z.number(),
  size_bits: z.number(),
  flags_json: z.record(z.unknown()),
});

export const kernel_type_schema = z.object({
  id: z.string(),
  module_id: z.string(),
  name: z.string(),
  kind: z.enum(["struct", "union", "enum", "typedef"]),
  size: z.number(),
  alignment: z.number(),
  reconstructed_c: z.string(),
  hash: z.string(),
  fields: z.array(type_field_schema),
  created_at: z.string(),
});

export const kernel_function_schema = z.object({
  id: z.string(),
  symbol_id: z.string(),
  module_id: z.string(),
  name: z.string(),
  symbol_kind: z.enum(["pdb-function", "pdb-public", "pe-export"]).optional(),
  return_type: z.string(),
  calling_convention: z.string(),
  parameters_json: z.array(z.object({ name: z.string(), type: z.string() })),
  rva: z.string(),
  size: z.number(),
  confidence: z.number(),
  has_pattern: z.boolean(),
  is_exported: z.boolean(),
  created_at: z.string(),
});

export const pattern_result_schema = z.object({
  id: z.string(),
  function_id: z.string(),
  module_id: z.string(),
  binary_sha256: z.string(),
  pattern: z.string(),
  mask: z.string(),
  format: z.string(),
  length: z.number(),
  confidence: z.number(),
  collision_count: z.number(),
  tested_builds_json: z.array(z.string()),
  status: z.enum(["excellent", "good", "risky", "rejected"]),
  created_at: z.string(),
});

export const pattern_cross_reference_status_schema = z.enum(["tested", "stored-pattern", "symbol-only", "function-missing", "module-missing", "error"]);

export const pattern_cross_reference_row_schema = z.object({
  build_id: z.string(),
  build_label: z.string(),
  architecture: architecture_schema,
  module_id: z.string().optional(),
  module_name: z.string(),
  function_id: z.string().optional(),
  function_name: z.string(),
  rva: z.string().optional(),
  binary_sha256: z.string().optional(),
  pattern_id: z.string().optional(),
  pattern_status: z.enum(["excellent", "good", "risky", "rejected"]).optional(),
  confidence: z.number().optional(),
  collision_count: z.number().optional(),
  length: z.number().optional(),
  pattern: z.string().optional(),
  mask: z.string().optional(),
  pattern_scope: z.enum(["multi-build", "per-build", "stored"]).optional(),
  status: pattern_cross_reference_status_schema,
  note: z.string(),
});

export const pdb_lookup_status_schema = z.enum(["no-debug-info", "cached", "downloaded", "missing", "download-failed"]);

export const module_pdb_state_schema = z.union([pdb_lookup_status_schema, z.literal("unchecked")]);

export const module_pdb_status_schema = z.object({
  module_id: z.string(),
  status: module_pdb_state_schema,
  available: z.boolean(),
  checking: z.boolean(),
  can_retry: z.boolean(),
  requires_admin: z.boolean(),
  provider: z.string(),
  pdb_name: z.string().optional(),
  pdb_identifier: z.string().optional(),
  symbol_url: z.string().optional(),
  last_checked_at: z.string().optional(),
  message: z.string(),
});

export const build_detection_source_schema = z.enum(["version-resource", "manual", "timestamp-fallback"]);

export const binary_ingestion_record_schema = z.object({
  id: z.string(),
  filename: z.string(),
  sha256: z.string(),
  cache_path: z.string(),
  build_id: z.string(),
  module_id: z.string(),
  module_name: z.string(),
  build_label: z.string(),
  architecture: architecture_schema,
  pdb_status: pdb_lookup_status_schema,
  build_detection_source: build_detection_source_schema.optional(),
  parser_version: z.string().optional(),
  symbol_url: z.string().optional(),
  created_at: z.string(),
});

export const pdb_lookup_result_schema = z.object({
  status: pdb_lookup_status_schema,
  pdb_name: z.string().optional(),
  pdb_identifier: z.string().optional(),
  symbol_url: z.string().optional(),
  cache_path: z.string().optional(),
  message: z.string(),
});

export const binary_ingestion_result_schema = z.object({
  ingestion: binary_ingestion_record_schema,
  build: windows_build_schema,
  module: module_schema,
  function_count: z.number(),
  type_count: z.number(),
  pdb_lookup: pdb_lookup_result_schema,
  build_detection_source: build_detection_source_schema,
  manual_identification_required: z.boolean(),
  cache_hit: z.boolean(),
});

export const search_result_schema = z.object({
  id: z.string(),
  kind: entity_kind_schema,
  name: z.string(),
  module: z.string(),
  build_id: z.string().optional(),
  build: z.string(),
  architecture: architecture_schema,
  api_url: z.string(),
  web_url: z.string(),
  score: z.number(),
});

export const api_meta_schema = z.object({
  request_id: z.string(),
  api_version: z.literal("v1"),
  source: z.string().optional(),
  pdb_guid: z.string().optional(),
  pdb_age: z.number().optional(),
});

export const pagination_query_schema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

export const search_query_schema = pagination_query_schema.extend({
  // Two characters is the practical floor: shorter matches a large fraction of the
  // ~7M function rows for no useful result. It is safe to allow because search runs
  // on the read replicas now, so a slow query no longer blocks the server; a
  // saturated pool sheds with 503 rather than queueing without bound.
  q: z.string().min(2).max(128),
  build: z.string().optional(),
  architecture: architecture_schema.optional(),
  module: z.string().optional(),
  kind: entity_kind_schema.optional(),
});

export const pattern_request_schema = z.object({
  function_id: z.string().min(1),
  binary_sha256: z.string().min(1),
  refresh: z.coerce.boolean().optional(),
});
