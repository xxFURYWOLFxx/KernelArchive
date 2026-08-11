import { existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

export const archive_collections = [
  "builds",
  "modules",
  "functions",
  "types",
  "patterns",
  "pdb_lookups",
  "ingestions",
  "archive_files",
] as const;

export type ArchiveCollection = (typeof archive_collections)[number];
export type ArchiveRecord = { id: string } & Record<string, unknown>;
export type ArchiveChanges = Partial<Record<ArchiveCollection, ArchiveRecord[]>>;
export type ArchiveSnapshot = Record<ArchiveCollection, ArchiveRecord[]>;

interface RevisionRow {
  value: string;
}

interface CountRow {
  count: number;
}

interface PayloadRow {
  payload: string;
}

interface TypeFieldReferenceRow {
  build_payload: string;
  module_payload: string;
  type_payload: string;
  field_payload: string;
}

interface TypeFunctionReferenceRow {
  build_payload: string;
  module_payload: string;
  function_payload: string;
}

interface IdRow {
  id: string;
}

interface ArchiveStatusCountRow {
  status: string | null;
  records: number;
}

interface ModuleCountsRow {
  build_id: string;
  module_count: number;
  symbol_count: number;
  function_count: number;
  type_count: number;
}

export interface ArchiveSearchFilters {
  build?: string;
  architecture?: string;
  module?: string;
  kind?: string;
  eligible_build_ids?: string[];
}

interface ArchiveSearchRow {
  id: string;
  collection: "modules" | "functions" | "types";
  name: string;
  module_name: string | null;
  build_id: string | null;
  build_number: string | null;
  architecture: string | null;
  score: number;
  total: number;
}

interface CollectionStatsRow {
  collection: ArchiveCollection;
  records: number;
  bytes: number;
}

const schema_version = "1";
// Ranking evaluates the exposed-function predicate per candidate row, so a broad
// prefix would otherwise score hundreds of thousands of rows before LIMIT applies.
const search_candidate_limit = 2000;
// Above this many rows in scope, a payload LIKE fallback costs seconds of blocked
// event loop, so large modules stay name-only.
const payload_scan_row_limit = 4000;
const pe_export_functions_version = "1";
const exposed_function_counts_version = "2";
const type_references_version = "1";

// Kept as one string because a bulk type rewrite drops these and puts them back.
// Maintaining archive_type_field_references a row at a time costs far more than the
// type records themselves: every deleted type scatters deletes across a table keyed
// by target_key, so re-extracting the whole archive is hours of random writes with
// them attached and minutes without.
const type_field_reference_triggers = `
      CREATE TRIGGER IF NOT EXISTS archive_type_field_references_insert
      AFTER INSERT ON archive_records
      WHEN NEW.collection = 'types'
      BEGIN
        INSERT OR IGNORE INTO archive_type_field_references (target_key, source_row_id, field_index)
        SELECT
          kernelarchive_type_reference(json_extract(field.value, '$.field_type_name')),
          NEW.row_id,
          CAST(field.key AS INTEGER)
        FROM json_each(NEW.payload, '$.fields') AS field
        WHERE kernelarchive_type_reference(json_extract(field.value, '$.field_type_name')) <> '';
      END;

      CREATE TRIGGER IF NOT EXISTS archive_type_field_references_delete
      AFTER DELETE ON archive_records
      WHEN OLD.collection = 'types'
      BEGIN
        DELETE FROM archive_type_field_references WHERE source_row_id = OLD.row_id;
      END;

      CREATE TRIGGER IF NOT EXISTS archive_type_field_references_update
      AFTER UPDATE OF collection, payload ON archive_records
      WHEN OLD.collection = 'types' OR NEW.collection = 'types'
      BEGIN
        DELETE FROM archive_type_field_references WHERE source_row_id = OLD.row_id;
        INSERT OR IGNORE INTO archive_type_field_references (target_key, source_row_id, field_index)
        SELECT
          kernelarchive_type_reference(json_extract(field.value, '$.field_type_name')),
          NEW.row_id,
          CAST(field.key AS INTEGER)
        FROM json_each(NEW.payload, '$.fields') AS field
        WHERE NEW.collection = 'types'
          AND kernelarchive_type_reference(json_extract(field.value, '$.field_type_name')) <> '';
      END;
`;

function normalize_type_reference(value: unknown) {
  if (typeof value !== "string") { return ""; }
  return value
    .replace(/\b(const|volatile|struct|union|enum)\b/gi, "")
    .replace(/\[[^\]]*\]/g, "")
    .replace(/[_\s*&]+/g, "")
    .toLowerCase();
}

function type_reference_keys(value: string) {
  const clean = normalize_type_reference(value);
  return Array.from(new Set([clean, `p${clean}`, `${clean}ptr`].filter(Boolean)));
}

function empty_snapshot(): ArchiveSnapshot {
  return {
    builds: [],
    modules: [],
    functions: [],
    types: [],
    patterns: [],
    pdb_lookups: [],
    ingestions: [],
    archive_files: [],
  };
}

function string_value(record: ArchiveRecord, keys: string[]) {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.length > 0) { return value; }
  }
  return null;
}

function escape_like(value: string) {
  return value.replace(/[\\%_]/g, "\\$&");
}

function normalized_rva_sql(expression: string) {
  return `COALESCE(NULLIF(LTRIM(LOWER(${expression}), '0x'), ''), '0')`;
}

function exposed_function_condition(alias = "") {
  const prefix = `${alias || "archive_records"}.`;
  const payload = `${prefix}payload`;
  const symbol_kind = `json_extract(${payload}, '$.symbol_kind')`;
  return `(
    ${symbol_kind} IN ('pe-export', 'pdb-function', 'pdb-public')
    OR (
      ${symbol_kind} IS NULL
      AND (
        (
          COALESCE(json_extract(${payload}, '$.return_type'), '') NOT IN ('exported symbol', 'PDB symbol')
          AND COALESCE(json_extract(${payload}, '$.calling_convention'), '') NOT IN ('PE export', 'PDB public')
        )
        OR EXISTS (
          SELECT 1
          FROM archive_pe_export_functions AS pe_export
          WHERE pe_export.module_id = ${prefix}parent_id
            AND pe_export.name = ${prefix}name COLLATE NOCASE
            AND pe_export.rva_key = ${normalized_rva_sql(`json_extract(${payload}, '$.rva')`)}
        )
      )
    )
  )`;
}

function record_metadata(collection: ArchiveCollection, record: ArchiveRecord) {
  const parent_keys: Record<ArchiveCollection, string[]> = {
    builds: [],
    modules: ["build_id"],
    functions: ["module_id"],
    types: ["module_id"],
    patterns: ["function_id", "module_id"],
    pdb_lookups: ["pdb_identifier"],
    ingestions: ["build_id", "module_id"],
    archive_files: ["module_id", "build_id"],
  };
  return {
    parent_id: string_value(record, parent_keys[collection]),
    name: string_value(record, ["relative_path", "name", "module_name", "filename", "pdb_name", "product_name"]),
  };
}

export class ArchiveStore {
  readonly path: string;
  readonly legacy_path: string;
  private readonly database: DatabaseSync;

  constructor(path: string, legacy_path: string, options: { read_only?: boolean } = {}) {
    this.path = path;
    this.legacy_path = legacy_path;
    if (!options.read_only) { mkdirSync(dirname(path), { recursive: true }); }
    this.database = new DatabaseSync(path, options.read_only ? { readOnly: true } : {});
    this.database.function("kernelarchive_type_reference", { deterministic: true }, normalize_type_reference);
    // A read replica opens a file the writer already initialised, so it does no
    // schema work and never writes. WAL permits any number of concurrent readers
    // alongside the single writer, which is what lets the read pool exist at all.
    if (options.read_only) {
      this.database.exec(`
        PRAGMA busy_timeout = 60000;
        PRAGMA temp_store = MEMORY;
        PRAGMA mmap_size = 268435456;
        PRAGMA cache_size = -65536;
      `);
      return;
    }
    this.database.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      PRAGMA foreign_keys = ON;
      PRAGMA busy_timeout = 60000;
      PRAGMA temp_store = MEMORY;
      PRAGMA mmap_size = 268435456;
      PRAGMA cache_size = -65536;
    `);
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS archive_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      ) WITHOUT ROWID;

      CREATE TABLE IF NOT EXISTS archive_records (
        row_id INTEGER PRIMARY KEY AUTOINCREMENT,
        collection TEXT NOT NULL,
        id TEXT NOT NULL,
        parent_id TEXT,
        name TEXT COLLATE NOCASE,
        payload TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        UNIQUE (collection, id)
      );

      CREATE TABLE IF NOT EXISTS archive_collection_counts (
        collection TEXT PRIMARY KEY,
        records INTEGER NOT NULL DEFAULT 0
      ) WITHOUT ROWID;

      CREATE TABLE IF NOT EXISTS archive_module_counts (
        build_id TEXT PRIMARY KEY,
        module_count INTEGER NOT NULL DEFAULT 0,
        symbol_count INTEGER NOT NULL DEFAULT 0,
        function_count INTEGER NOT NULL DEFAULT 0,
        type_count INTEGER NOT NULL DEFAULT 0
      ) WITHOUT ROWID;

      CREATE TABLE IF NOT EXISTS archive_exposed_function_counts (
        module_id TEXT PRIMARY KEY,
        function_count INTEGER NOT NULL DEFAULT 0
      ) WITHOUT ROWID;

      CREATE TABLE IF NOT EXISTS archive_pe_export_functions (
        module_id TEXT NOT NULL,
        name TEXT NOT NULL COLLATE NOCASE,
        rva_key TEXT NOT NULL,
        PRIMARY KEY (module_id, name, rva_key)
      ) WITHOUT ROWID;

      CREATE TABLE IF NOT EXISTS archive_module_metadata (
        id TEXT PRIMARY KEY,
        pdb_name TEXT COLLATE NOCASE,
        pdb_guid TEXT COLLATE NOCASE,
        sha256 TEXT COLLATE NOCASE
      ) WITHOUT ROWID;

      CREATE TABLE IF NOT EXISTS archive_module_paths (
        id TEXT PRIMARY KEY,
        original_path TEXT COLLATE NOCASE
      ) WITHOUT ROWID;

      CREATE TABLE IF NOT EXISTS archive_module_revisions (
        build_id TEXT PRIMARY KEY,
        revision INTEGER NOT NULL DEFAULT 0
      ) WITHOUT ROWID;

      DROP TRIGGER IF EXISTS archive_exposed_function_counts_insert;
      CREATE TABLE IF NOT EXISTS archive_type_field_references (
        target_key TEXT NOT NULL COLLATE NOCASE,
        source_row_id INTEGER NOT NULL,
        field_index INTEGER NOT NULL,
        PRIMARY KEY (target_key, source_row_id, field_index)
      ) WITHOUT ROWID;

      CREATE TABLE IF NOT EXISTS archive_type_function_references (
        target_key TEXT NOT NULL COLLATE NOCASE,
        source_row_id INTEGER NOT NULL,
        PRIMARY KEY (target_key, source_row_id)
      ) WITHOUT ROWID;

      DROP TRIGGER IF EXISTS archive_exposed_function_counts_delete;
      DROP TRIGGER IF EXISTS archive_exposed_function_counts_update_old;
      DROP TRIGGER IF EXISTS archive_exposed_function_counts_update_new;
      DROP TRIGGER IF EXISTS archive_exposed_function_counts_module_delete;
      DROP TRIGGER IF EXISTS archive_pe_export_functions_insert;
      DROP TRIGGER IF EXISTS archive_pe_export_functions_delete;
      DROP TRIGGER IF EXISTS archive_pe_export_functions_update;

      DROP TRIGGER IF EXISTS archive_type_field_references_insert;
      DROP TRIGGER IF EXISTS archive_type_field_references_delete;
      DROP TRIGGER IF EXISTS archive_type_field_references_update;
      DROP TRIGGER IF EXISTS archive_type_function_references_insert;
      DROP TRIGGER IF EXISTS archive_type_function_references_delete;
      DROP TRIGGER IF EXISTS archive_type_function_references_update;
      CREATE TRIGGER IF NOT EXISTS archive_module_counts_insert
      AFTER INSERT ON archive_records
      WHEN NEW.collection = 'modules' AND NEW.parent_id IS NOT NULL
      BEGIN
        INSERT INTO archive_module_counts (build_id, module_count, symbol_count, function_count, type_count)
        VALUES (
          NEW.parent_id,
          1,
          COALESCE(CAST(json_extract(NEW.payload, '$.symbol_count') AS INTEGER), 0),
          COALESCE(CAST(json_extract(NEW.payload, '$.function_count') AS INTEGER), 0),
          COALESCE(CAST(json_extract(NEW.payload, '$.type_count') AS INTEGER), 0)
        )
        ON CONFLICT (build_id) DO UPDATE SET
          module_count = module_count + excluded.module_count,
          symbol_count = symbol_count + excluded.symbol_count,
          function_count = function_count + excluded.function_count,
          type_count = type_count + excluded.type_count;
      END;

      CREATE TRIGGER IF NOT EXISTS archive_module_counts_delete
      AFTER DELETE ON archive_records
      WHEN OLD.collection = 'modules' AND OLD.parent_id IS NOT NULL
      BEGIN
        UPDATE archive_module_counts
        SET module_count = MAX(module_count - 1, 0),
            symbol_count = MAX(symbol_count - COALESCE(CAST(json_extract(OLD.payload, '$.symbol_count') AS INTEGER), 0), 0),
            function_count = MAX(function_count - COALESCE(CAST(json_extract(OLD.payload, '$.function_count') AS INTEGER), 0), 0),
            type_count = MAX(type_count - COALESCE(CAST(json_extract(OLD.payload, '$.type_count') AS INTEGER), 0), 0)
        WHERE build_id = OLD.parent_id;
        DELETE FROM archive_module_counts
        WHERE build_id = OLD.parent_id AND module_count = 0;
      END;

      CREATE TRIGGER IF NOT EXISTS archive_module_counts_update
      AFTER UPDATE OF collection, parent_id, payload ON archive_records
      WHEN (OLD.collection = 'modules' AND OLD.parent_id IS NOT NULL)
        OR (NEW.collection = 'modules' AND NEW.parent_id IS NOT NULL)
      BEGIN
        UPDATE archive_module_counts
        SET module_count = MAX(module_count - 1, 0),
            symbol_count = MAX(symbol_count - COALESCE(CAST(json_extract(OLD.payload, '$.symbol_count') AS INTEGER), 0), 0),
            function_count = MAX(function_count - COALESCE(CAST(json_extract(OLD.payload, '$.function_count') AS INTEGER), 0), 0),
            type_count = MAX(type_count - COALESCE(CAST(json_extract(OLD.payload, '$.type_count') AS INTEGER), 0), 0)
        WHERE OLD.collection = 'modules' AND build_id = OLD.parent_id;
        DELETE FROM archive_module_counts
        WHERE OLD.collection = 'modules' AND build_id = OLD.parent_id AND module_count = 0;
        INSERT INTO archive_module_counts (build_id, module_count, symbol_count, function_count, type_count)
        SELECT
          NEW.parent_id,
          1,
          COALESCE(CAST(json_extract(NEW.payload, '$.symbol_count') AS INTEGER), 0),
          COALESCE(CAST(json_extract(NEW.payload, '$.function_count') AS INTEGER), 0),
          COALESCE(CAST(json_extract(NEW.payload, '$.type_count') AS INTEGER), 0)
        WHERE NEW.collection = 'modules' AND NEW.parent_id IS NOT NULL
        ON CONFLICT (build_id) DO UPDATE SET
          module_count = module_count + excluded.module_count,
          symbol_count = symbol_count + excluded.symbol_count,
          function_count = function_count + excluded.function_count,
          type_count = type_count + excluded.type_count;
      END;

      CREATE TRIGGER IF NOT EXISTS archive_pe_export_functions_insert
      AFTER INSERT ON archive_records
      WHEN NEW.collection = 'modules'
      BEGIN
        INSERT OR IGNORE INTO archive_pe_export_functions (module_id, name, rva_key)
        SELECT
          NEW.id,
          json_extract(export.value, '$.name'),
          ${normalized_rva_sql("json_extract(export.value, '$.rva')")}
        FROM json_each(NEW.payload, '$.exports') AS export
        WHERE COALESCE(json_extract(export.value, '$.name'), '') <> ''
          AND COALESCE(json_extract(export.value, '$.rva'), '') <> ''
          AND COALESCE(json_extract(export.value, '$.forwarder'), '') = '';
        DELETE FROM archive_exposed_function_counts WHERE module_id = NEW.id;
        INSERT INTO archive_exposed_function_counts (module_id, function_count)
        SELECT parent_id, COUNT(*)
        FROM archive_records INDEXED BY archive_records_collection_parent
        WHERE collection = 'functions'
          AND parent_id = NEW.id
          AND ${exposed_function_condition()}
        GROUP BY parent_id;
      END;

      CREATE TRIGGER IF NOT EXISTS archive_pe_export_functions_delete
      AFTER DELETE ON archive_records
      WHEN OLD.collection = 'modules'
      BEGIN
        DELETE FROM archive_pe_export_functions WHERE module_id = OLD.id;
        DELETE FROM archive_exposed_function_counts WHERE module_id = OLD.id;
      END;

      CREATE TRIGGER IF NOT EXISTS archive_pe_export_functions_update
      AFTER UPDATE OF collection, id, payload ON archive_records
      WHEN OLD.collection = 'modules' OR NEW.collection = 'modules'
      BEGIN
        DELETE FROM archive_pe_export_functions WHERE module_id = OLD.id;
        INSERT OR IGNORE INTO archive_pe_export_functions (module_id, name, rva_key)
        SELECT
          NEW.id,
          json_extract(export.value, '$.name'),
          ${normalized_rva_sql("json_extract(export.value, '$.rva')")}
        FROM json_each(NEW.payload, '$.exports') AS export
        WHERE NEW.collection = 'modules'
          AND COALESCE(json_extract(export.value, '$.name'), '') <> ''
          AND COALESCE(json_extract(export.value, '$.rva'), '') <> ''
          AND COALESCE(json_extract(export.value, '$.forwarder'), '') = '';
        DELETE FROM archive_exposed_function_counts WHERE module_id IN (OLD.id, NEW.id);
        INSERT INTO archive_exposed_function_counts (module_id, function_count)
        SELECT parent_id, COUNT(*)
        FROM archive_records INDEXED BY archive_records_collection_parent
        WHERE NEW.collection = 'modules'
          AND collection = 'functions'
          AND parent_id = NEW.id
          AND ${exposed_function_condition()}
        GROUP BY parent_id;
      END;

      CREATE TRIGGER IF NOT EXISTS archive_exposed_function_counts_insert
      AFTER INSERT ON archive_records
      WHEN NEW.collection = 'functions'
        AND NEW.parent_id IS NOT NULL
        AND ${exposed_function_condition("NEW")}
      BEGIN
        INSERT INTO archive_exposed_function_counts (module_id, function_count)
        VALUES (NEW.parent_id, 1)
        ON CONFLICT (module_id) DO UPDATE SET function_count = function_count + 1;
      END;

      CREATE TRIGGER IF NOT EXISTS archive_exposed_function_counts_delete
      AFTER DELETE ON archive_records
      WHEN OLD.collection = 'functions'
        AND OLD.parent_id IS NOT NULL
        AND ${exposed_function_condition("OLD")}
      BEGIN
        UPDATE archive_exposed_function_counts
        SET function_count = MAX(function_count - 1, 0)
        WHERE module_id = OLD.parent_id;
      END;

      CREATE TRIGGER IF NOT EXISTS archive_exposed_function_counts_update_old
      AFTER UPDATE OF collection, parent_id, payload ON archive_records
      WHEN OLD.collection = 'functions'
        AND OLD.parent_id IS NOT NULL
        AND ${exposed_function_condition("OLD")}
      BEGIN
        UPDATE archive_exposed_function_counts
        SET function_count = MAX(function_count - 1, 0)
        WHERE module_id = OLD.parent_id;
      END;

      CREATE TRIGGER IF NOT EXISTS archive_exposed_function_counts_update_new
      AFTER UPDATE OF collection, parent_id, payload ON archive_records
      WHEN NEW.collection = 'functions'
        AND NEW.parent_id IS NOT NULL
        AND ${exposed_function_condition("NEW")}
      BEGIN
        INSERT INTO archive_exposed_function_counts (module_id, function_count)
        VALUES (NEW.parent_id, 1)
        ON CONFLICT (module_id) DO UPDATE SET function_count = function_count + 1;
      END;

      CREATE TRIGGER IF NOT EXISTS archive_exposed_function_counts_module_delete
      AFTER DELETE ON archive_records
      WHEN OLD.collection = 'modules'
      BEGIN
        DELETE FROM archive_exposed_function_counts WHERE module_id = OLD.id;
      END;

      ${type_field_reference_triggers}

      CREATE TRIGGER IF NOT EXISTS archive_type_function_references_insert
      AFTER INSERT ON archive_records
      WHEN NEW.collection = 'functions'
        AND ${exposed_function_condition("NEW")}
      BEGIN
        INSERT OR IGNORE INTO archive_type_function_references (target_key, source_row_id)
        SELECT target_key, NEW.row_id
        FROM (
          SELECT kernelarchive_type_reference(json_extract(NEW.payload, '$.return_type')) AS target_key
          UNION
          SELECT kernelarchive_type_reference(json_extract(parameter.value, '$.type')) AS target_key
          FROM json_each(NEW.payload, '$.parameters_json') AS parameter
        )
        WHERE target_key <> '';
      END;

      CREATE TRIGGER IF NOT EXISTS archive_type_function_references_delete
      AFTER DELETE ON archive_records
      WHEN OLD.collection = 'functions'
      BEGIN
        DELETE FROM archive_type_function_references WHERE source_row_id = OLD.row_id;
      END;

      CREATE TRIGGER IF NOT EXISTS archive_type_function_references_update
      AFTER UPDATE OF collection, parent_id, payload ON archive_records
      WHEN OLD.collection = 'functions' OR NEW.collection = 'functions'
      BEGIN
        DELETE FROM archive_type_function_references WHERE source_row_id = OLD.row_id;
        INSERT OR IGNORE INTO archive_type_function_references (target_key, source_row_id)
        SELECT target_key, NEW.row_id
        FROM (
          SELECT kernelarchive_type_reference(json_extract(NEW.payload, '$.return_type')) AS target_key
          UNION
          SELECT kernelarchive_type_reference(json_extract(parameter.value, '$.type')) AS target_key
          FROM json_each(NEW.payload, '$.parameters_json') AS parameter
        )
        WHERE NEW.collection = 'functions'
          AND ${exposed_function_condition("NEW")}
          AND target_key <> '';
      END;

      CREATE TRIGGER IF NOT EXISTS archive_module_revision_insert
      AFTER INSERT ON archive_records
      WHEN NEW.collection = 'modules' AND NEW.parent_id IS NOT NULL
      BEGIN
        INSERT INTO archive_module_revisions (build_id, revision)
        VALUES (NEW.parent_id, 1)
        ON CONFLICT (build_id) DO UPDATE SET revision = revision + 1;
      END;

      CREATE TRIGGER IF NOT EXISTS archive_module_revision_delete
      AFTER DELETE ON archive_records
      WHEN OLD.collection = 'modules' AND OLD.parent_id IS NOT NULL
      BEGIN
        INSERT INTO archive_module_revisions (build_id, revision)
        VALUES (OLD.parent_id, 1)
        ON CONFLICT (build_id) DO UPDATE SET revision = revision + 1;
      END;

      CREATE TRIGGER IF NOT EXISTS archive_module_revision_update_old
      AFTER UPDATE OF collection, parent_id, payload ON archive_records
      WHEN OLD.collection = 'modules' AND OLD.parent_id IS NOT NULL
      BEGIN
        INSERT INTO archive_module_revisions (build_id, revision)
        VALUES (OLD.parent_id, 1)
        ON CONFLICT (build_id) DO UPDATE SET revision = revision + 1;
      END;

      CREATE TRIGGER IF NOT EXISTS archive_module_revision_update_new
      AFTER UPDATE OF collection, parent_id, payload ON archive_records
      WHEN NEW.collection = 'modules' AND NEW.parent_id IS NOT NULL
      BEGIN
        INSERT INTO archive_module_revisions (build_id, revision)
        VALUES (NEW.parent_id, 1)
        ON CONFLICT (build_id) DO UPDATE SET revision = revision + 1;
      END;

      CREATE TRIGGER IF NOT EXISTS archive_module_metadata_insert
      AFTER INSERT ON archive_records
      WHEN NEW.collection = 'modules'
      BEGIN
        INSERT INTO archive_module_metadata (id, pdb_name, pdb_guid, sha256)
        VALUES (
          NEW.id,
          json_extract(NEW.payload, '$.pdb_name'),
          json_extract(NEW.payload, '$.pdb_guid'),
          json_extract(NEW.payload, '$.sha256')
        )
        ON CONFLICT (id) DO UPDATE SET
          pdb_name = excluded.pdb_name,
          pdb_guid = excluded.pdb_guid,
          sha256 = excluded.sha256;
      END;

      CREATE TRIGGER IF NOT EXISTS archive_module_metadata_delete
      AFTER DELETE ON archive_records
      WHEN OLD.collection = 'modules'
      BEGIN
        DELETE FROM archive_module_metadata WHERE id = OLD.id;
      END;

      CREATE TRIGGER IF NOT EXISTS archive_module_metadata_update
      AFTER UPDATE OF collection, id, payload ON archive_records
      WHEN OLD.collection = 'modules' OR NEW.collection = 'modules'
      BEGIN
        DELETE FROM archive_module_metadata WHERE id = OLD.id;
        INSERT INTO archive_module_metadata (id, pdb_name, pdb_guid, sha256)
        SELECT NEW.id, json_extract(NEW.payload, '$.pdb_name'), json_extract(NEW.payload, '$.pdb_guid'), json_extract(NEW.payload, '$.sha256')
        WHERE NEW.collection = 'modules'
        ON CONFLICT (id) DO UPDATE SET
          pdb_name = excluded.pdb_name,
          pdb_guid = excluded.pdb_guid,
          sha256 = excluded.sha256;
      END;

      CREATE TRIGGER IF NOT EXISTS archive_module_paths_insert
      AFTER INSERT ON archive_records
      WHEN NEW.collection = 'modules'
      BEGIN
        INSERT INTO archive_module_paths (id, original_path)
        VALUES (NEW.id, json_extract(NEW.payload, '$.original_path'))
        ON CONFLICT (id) DO UPDATE SET original_path = excluded.original_path;
      END;

      CREATE TRIGGER IF NOT EXISTS archive_module_paths_delete
      AFTER DELETE ON archive_records
      WHEN OLD.collection = 'modules'
      BEGIN
        DELETE FROM archive_module_paths WHERE id = OLD.id;
      END;

      CREATE TRIGGER IF NOT EXISTS archive_module_paths_update
      AFTER UPDATE OF collection, id, payload ON archive_records
      WHEN OLD.collection = 'modules' OR NEW.collection = 'modules'
      BEGIN
        DELETE FROM archive_module_paths WHERE id = OLD.id;
        INSERT INTO archive_module_paths (id, original_path)
        SELECT NEW.id, json_extract(NEW.payload, '$.original_path')
        WHERE NEW.collection = 'modules'
        ON CONFLICT (id) DO UPDATE SET original_path = excluded.original_path;
      END;

      CREATE TRIGGER IF NOT EXISTS archive_records_count_insert
      AFTER INSERT ON archive_records
      BEGIN
        INSERT INTO archive_collection_counts (collection, records)
        VALUES (NEW.collection, 1)
        ON CONFLICT (collection) DO UPDATE SET records = records + 1;
      END;

      CREATE TRIGGER IF NOT EXISTS archive_records_count_delete
      AFTER DELETE ON archive_records
      BEGIN
        UPDATE archive_collection_counts
        SET records = MAX(records - 1, 0)
        WHERE collection = OLD.collection;
      END;

      CREATE INDEX IF NOT EXISTS archive_records_collection_parent
        ON archive_records (collection, parent_id);
      CREATE INDEX IF NOT EXISTS archive_records_collection_parent_name
        ON archive_records (collection, parent_id, name COLLATE NOCASE);
      CREATE INDEX IF NOT EXISTS archive_records_collection_name
        ON archive_records (collection, name COLLATE NOCASE);
      CREATE INDEX IF NOT EXISTS archive_module_metadata_pdb_name
        ON archive_module_metadata (pdb_name COLLATE NOCASE);
      CREATE INDEX IF NOT EXISTS archive_module_metadata_pdb_guid
        ON archive_module_metadata (pdb_guid COLLATE NOCASE);
      CREATE INDEX IF NOT EXISTS archive_module_metadata_sha256
        ON archive_module_metadata (sha256 COLLATE NOCASE);
      CREATE INDEX IF NOT EXISTS archive_module_paths_original_path
        ON archive_module_paths (original_path COLLATE NOCASE);
      CREATE INDEX IF NOT EXISTS archive_type_field_references_source
        ON archive_type_field_references (source_row_id);
      CREATE INDEX IF NOT EXISTS archive_type_function_references_source
        ON archive_type_function_references (source_row_id);
      CREATE INDEX IF NOT EXISTS archive_pe_export_functions_module
        ON archive_pe_export_functions (module_id);
      CREATE INDEX IF NOT EXISTS archive_exposed_function_counts_module
        ON archive_exposed_function_counts (module_id);
    `);
    this.database.prepare("INSERT OR IGNORE INTO archive_meta (key, value) VALUES ('schema_version', ?)").run(schema_version);
    this.database.prepare("INSERT OR IGNORE INTO archive_meta (key, value) VALUES ('revision', '0')").run();
    this.initialize_collection_counts();
    this.initialize_module_counts();
    this.migrate_legacy_index();
    this.initialize_pe_export_functions();
    this.initialize_exposed_function_counts();
    this.initialize_module_metadata();
    this.initialize_module_paths();
    this.initialize_module_revisions();
    this.prune_orphans_once();
    this.initialize_type_references();
  }

  private initialize_collection_counts() {
    const initialized = this.database.prepare("SELECT value FROM archive_meta WHERE key = 'collection_counts_initialized'").get() as unknown as RevisionRow | undefined;
    if (initialized?.value !== "1") {
      this.database.exec("BEGIN IMMEDIATE");
      try {
        this.database.prepare("DELETE FROM archive_collection_counts").run();
        this.database.prepare(`
          INSERT INTO archive_collection_counts (collection, records)
          SELECT collection, COUNT(*)
          FROM archive_records
          GROUP BY collection
        `).run();
        this.database.prepare("INSERT OR REPLACE INTO archive_meta (key, value) VALUES ('collection_counts_initialized', '1')").run();
        this.database.exec("COMMIT");
      } catch (error) {
        this.database.exec("ROLLBACK");
        throw error;
      }
    }

    const ensure_collection = this.database.prepare("INSERT OR IGNORE INTO archive_collection_counts (collection, records) VALUES (?, 0)");
    for (const collection of archive_collections) { ensure_collection.run(collection); }
  }

  private initialize_module_counts() {
    const initialized = this.database.prepare("SELECT value FROM archive_meta WHERE key = 'module_counts_initialized'").get() as unknown as RevisionRow | undefined;
    if (initialized?.value !== schema_version) {
      this.database.exec("BEGIN IMMEDIATE");
      try {
        this.database.prepare("DELETE FROM archive_module_counts").run();
        this.database.prepare(`
          INSERT INTO archive_module_counts (build_id, module_count, symbol_count, function_count, type_count)
          SELECT
            parent_id AS build_id,
            COUNT(*) AS module_count,
            COALESCE(SUM(CAST(json_extract(payload, '$.symbol_count') AS INTEGER)), 0) AS symbol_count,
            COALESCE(SUM(CAST(json_extract(payload, '$.function_count') AS INTEGER)), 0) AS function_count,
            COALESCE(SUM(CAST(json_extract(payload, '$.type_count') AS INTEGER)), 0) AS type_count
          FROM archive_records
          WHERE collection = 'modules' AND parent_id IS NOT NULL
          GROUP BY parent_id
        `).run();
        this.database.prepare("INSERT OR REPLACE INTO archive_meta (key, value) VALUES ('module_counts_initialized', ?)").run(schema_version);
        this.database.exec("COMMIT");
      } catch (error) {
        this.database.exec("ROLLBACK");
        throw error;
      }
    }
  }

  private initialize_exposed_function_counts() {
    const initialized = this.database.prepare("SELECT value FROM archive_meta WHERE key = 'exposed_function_counts_version'").get() as unknown as RevisionRow | undefined;
    if (initialized?.value === exposed_function_counts_version) { return; }

    this.database.exec("BEGIN IMMEDIATE");
    try {
      this.database.prepare("DELETE FROM archive_exposed_function_counts").run();
      this.database.prepare(`
        INSERT INTO archive_exposed_function_counts (module_id, function_count)
        SELECT parent_id, COUNT(*)
        FROM archive_records INDEXED BY archive_records_collection_parent
        WHERE collection = 'functions'
          AND parent_id IS NOT NULL
          AND ${exposed_function_condition()}
        GROUP BY parent_id
      `).run();
      this.database.prepare("INSERT OR REPLACE INTO archive_meta (key, value) VALUES ('exposed_function_counts_version', ?)").run(exposed_function_counts_version);
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  private initialize_type_references() {
    const initialized = this.database.prepare("SELECT value FROM archive_meta WHERE key = 'type_references_version'").get() as unknown as RevisionRow | undefined;
    if (initialized?.value === type_references_version) { return; }

    const started_at = Date.now();
    console.info("Building the persistent type-reference index...");
    this.database.exec("BEGIN IMMEDIATE");
    try {
      this.database.prepare("DELETE FROM archive_type_field_references").run();
      this.database.prepare("DELETE FROM archive_type_function_references").run();
      this.database.prepare(`
        INSERT OR IGNORE INTO archive_type_field_references (target_key, source_row_id, field_index)
        SELECT
          kernelarchive_type_reference(json_extract(field.value, '$.field_type_name')),
          record.row_id,
          CAST(field.key AS INTEGER)
        FROM archive_records AS record INDEXED BY archive_records_collection_parent
        JOIN json_each(record.payload, '$.fields') AS field
        WHERE record.collection = 'types'
          AND kernelarchive_type_reference(json_extract(field.value, '$.field_type_name')) <> ''
      `).run();
      this.database.prepare(`
        INSERT OR IGNORE INTO archive_type_function_references (target_key, source_row_id)
        SELECT target_key, source_row_id
        FROM (
          SELECT
            kernelarchive_type_reference(json_extract(record.payload, '$.return_type')) AS target_key,
            record.row_id AS source_row_id
          FROM archive_records AS record INDEXED BY archive_records_collection_parent
          WHERE record.collection = 'functions'
            AND ${exposed_function_condition("record")}
          UNION
          SELECT
            kernelarchive_type_reference(json_extract(parameter.value, '$.type')) AS target_key,
            record.row_id AS source_row_id
          FROM archive_records AS record INDEXED BY archive_records_collection_parent
          JOIN json_each(record.payload, '$.parameters_json') AS parameter
          WHERE record.collection = 'functions'
            AND ${exposed_function_condition("record")}
        )
        WHERE target_key <> ''
      `).run();
      this.database.prepare("INSERT OR REPLACE INTO archive_meta (key, value) VALUES ('type_references_version', ?)").run(type_references_version);
      this.database.exec("COMMIT");
      console.info(`Type-reference index ready in ${((Date.now() - started_at) / 1000).toFixed(1)}s.`);
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  private initialize_pe_export_functions() {
    const initialized = this.database.prepare("SELECT value FROM archive_meta WHERE key = 'pe_export_functions_version'").get() as unknown as RevisionRow | undefined;
    if (initialized?.value === pe_export_functions_version) { return; }

    this.database.exec("BEGIN IMMEDIATE");
    try {
      this.database.prepare("DELETE FROM archive_pe_export_functions").run();
      this.database.prepare(`
        INSERT OR IGNORE INTO archive_pe_export_functions (module_id, name, rva_key)
        SELECT
          module.id,
          json_extract(export.value, '$.name'),
          ${normalized_rva_sql("json_extract(export.value, '$.rva')")}
        FROM archive_records AS module INDEXED BY archive_records_collection_parent
        JOIN json_each(module.payload, '$.exports') AS export
        WHERE module.collection = 'modules'
          AND COALESCE(json_extract(export.value, '$.name'), '') <> ''
          AND COALESCE(json_extract(export.value, '$.rva'), '') <> ''
          AND COALESCE(json_extract(export.value, '$.forwarder'), '') = ''
      `).run();
      this.database.prepare("INSERT OR REPLACE INTO archive_meta (key, value) VALUES ('pe_export_functions_version', ?)").run(pe_export_functions_version);
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  private initialize_module_metadata() {
    const initialized = this.database.prepare("SELECT value FROM archive_meta WHERE key = 'module_metadata_initialized'").get() as unknown as RevisionRow | undefined;
    if (initialized?.value === "1") { return; }

    this.database.exec("BEGIN IMMEDIATE");
    try {
      this.database.prepare("DELETE FROM archive_module_metadata").run();
      this.database.prepare(`
        INSERT INTO archive_module_metadata (id, pdb_name, pdb_guid, sha256)
        SELECT
          id,
          json_extract(payload, '$.pdb_name'),
          json_extract(payload, '$.pdb_guid'),
          json_extract(payload, '$.sha256')
        FROM archive_records
        WHERE collection = 'modules'
      `).run();
      this.database.prepare("INSERT OR REPLACE INTO archive_meta (key, value) VALUES ('module_metadata_initialized', '1')").run();
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  private initialize_module_paths() {
    const initialized = this.database.prepare("SELECT value FROM archive_meta WHERE key = 'module_paths_initialized'").get() as unknown as RevisionRow | undefined;
    if (initialized?.value === "1") { return; }

    this.database.exec("BEGIN IMMEDIATE");
    try {
      this.database.prepare("DELETE FROM archive_module_paths").run();
      this.database.prepare(`
        INSERT INTO archive_module_paths (id, original_path)
        SELECT id, json_extract(payload, '$.original_path')
        FROM archive_records
        WHERE collection = 'modules'
      `).run();
      this.database.prepare("INSERT OR REPLACE INTO archive_meta (key, value) VALUES ('module_paths_initialized', '1')").run();
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  private initialize_module_revisions() {
    const initialized = this.database.prepare("SELECT value FROM archive_meta WHERE key = 'module_revisions_initialized'").get() as unknown as RevisionRow | undefined;
    if (initialized?.value === "1") { return; }

    this.database.exec("BEGIN IMMEDIATE");
    try {
      this.database.prepare("DELETE FROM archive_module_revisions").run();
      this.database.prepare(`
        INSERT INTO archive_module_revisions (build_id, revision)
        SELECT parent_id, COUNT(*)
        FROM archive_records
        WHERE collection = 'modules' AND parent_id IS NOT NULL
        GROUP BY parent_id
      `).run();
      this.database.prepare("INSERT OR REPLACE INTO archive_meta (key, value) VALUES ('module_revisions_initialized', '1')").run();
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  private migrate_legacy_index() {
    const row = this.database.prepare("SELECT 1 AS count FROM archive_records LIMIT 1").get() as unknown as CountRow | undefined;
    if (row || !existsSync(this.legacy_path)) { return; }

    const parsed = JSON.parse(readFileSync(this.legacy_path, "utf8")) as Partial<ArchiveSnapshot>;
    const changes = empty_snapshot();
    for (const collection of archive_collections) {
      const records = parsed[collection];
      changes[collection] = Array.isArray(records)
        ? records.filter((record): record is ArchiveRecord => Boolean(record && typeof record === "object" && typeof record.id === "string"))
        : [];
    }

    this.write_changes(changes, false);
    const legacy = statSync(this.legacy_path);
    const now = new Date().toISOString();
    this.database.prepare("INSERT OR REPLACE INTO archive_meta (key, value) VALUES ('migrated_from', ?)").run(this.legacy_path);
    this.database.prepare("INSERT OR REPLACE INTO archive_meta (key, value) VALUES ('migrated_at', ?)").run(now);
    this.database.prepare("INSERT OR REPLACE INTO archive_meta (key, value) VALUES ('legacy_mtime_ms', ?)").run(String(legacy.mtimeMs));
  }

  private prune_orphans_once() {
    const pruned = this.database.prepare("SELECT value FROM archive_meta WHERE key = 'orphans_pruned_version'").get() as unknown as RevisionRow | undefined;
    if (pruned?.value === schema_version) { return; }
    this.prune_orphans();
    this.database.prepare("INSERT OR REPLACE INTO archive_meta (key, value) VALUES ('orphans_pruned_version', ?)").run(schema_version);
  }

  revision() {
    const row = this.database.prepare("SELECT value FROM archive_meta WHERE key = 'revision'").get() as unknown as RevisionRow | undefined;
    const revision = Number.parseInt(row?.value ?? "0", 10);
    return Number.isFinite(revision) ? revision : 0;
  }

  module_revision(build_id: string) {
    const row = this.database.prepare("SELECT revision FROM archive_module_revisions WHERE build_id = ?").get(build_id) as unknown as { revision: number } | undefined;
    return Number(row?.revision ?? 0);
  }

  load(): ArchiveSnapshot {
    const snapshot = empty_snapshot();
    for (const collection of archive_collections) {
      snapshot[collection] = this.load_collection(collection);
    }
    return snapshot;
  }

  load_collection(collection: ArchiveCollection) {
    const rows = this.database.prepare(
      "SELECT payload FROM archive_records WHERE collection = ? ORDER BY row_id",
    ).all(collection) as unknown as PayloadRow[];
    return rows.map((row) => JSON.parse(row.payload) as ArchiveRecord);
  }

  load_by_parent(collection: ArchiveCollection, parent_id: string) {
    const rows = this.database.prepare(
      "SELECT payload FROM archive_records WHERE collection = ? AND parent_id = ? ORDER BY row_id",
    ).all(collection, parent_id) as unknown as PayloadRow[];
    return rows.map((row) => JSON.parse(row.payload) as ArchiveRecord);
  }

  load_by_name(collection: ArchiveCollection, name: string) {
    const visibility = collection === "functions" ? ` AND ${exposed_function_condition()}` : "";
    const rows = this.database.prepare(
      `SELECT payload FROM archive_records WHERE collection = ? AND name = ? COLLATE NOCASE${visibility} ORDER BY row_id`,
    ).all(collection, name) as unknown as PayloadRow[];
    return rows.map((row) => JSON.parse(row.payload) as ArchiveRecord);
  }

  load_types_by_name_and_module_name(name: string, module_name: string) {
    const rows = this.database.prepare(`
      SELECT type.payload
      FROM archive_records AS type
      JOIN archive_records AS module
        ON module.collection = 'modules' AND module.id = type.parent_id
      WHERE type.collection = 'types'
        AND type.name = ? COLLATE NOCASE
        AND module.name = ? COLLATE NOCASE
      ORDER BY type.row_id
    `).all(name, module_name) as unknown as PayloadRow[];
    return rows.map((row) => JSON.parse(row.payload) as ArchiveRecord);
  }

  load_modules_by_pdb_name(pdb_name: string) {
    const rows = this.database.prepare(`
      SELECT record.payload
      FROM archive_records AS record
      JOIN archive_module_metadata AS metadata ON metadata.id = record.id
      WHERE record.collection = 'modules' AND metadata.pdb_name = ? COLLATE NOCASE
      ORDER BY record.row_id
    `).all(pdb_name) as unknown as PayloadRow[];
    return rows.map((row) => JSON.parse(row.payload) as ArchiveRecord);
  }

  get(collection: ArchiveCollection, id: string) {
    const row = this.database.prepare(
      "SELECT payload FROM archive_records WHERE collection = ? AND id = ?",
    ).get(collection, id) as unknown as PayloadRow | undefined;
    return row ? JSON.parse(row.payload) as ArchiveRecord : undefined;
  }

  page(collection: ArchiveCollection, offset: number, limit: number, descending = false) {
    const direction = descending ? "DESC" : "ASC";
    const rows = this.database.prepare(
      `SELECT payload FROM archive_records WHERE collection = ? ORDER BY row_id ${direction} LIMIT ? OFFSET ?`,
    ).all(collection, Math.max(0, limit), Math.max(0, offset)) as unknown as PayloadRow[];
    return rows.map((row) => JSON.parse(row.payload) as ArchiveRecord);
  }

  module_summaries_page(parent_id: string, offset: number, limit: number, query = "") {
    const filters = ["record.collection = 'modules'", "record.parent_id = ?"];
    const parameters: Array<string | number> = [parent_id];
    const normalized_query = query.trim();
    if (normalized_query) {
      filters.push("(record.name LIKE ? COLLATE NOCASE OR EXISTS (SELECT 1 FROM archive_module_metadata AS metadata WHERE metadata.id = record.id AND metadata.pdb_name LIKE ? COLLATE NOCASE) OR EXISTS (SELECT 1 FROM archive_module_paths AS paths WHERE paths.id = record.id AND paths.original_path LIKE ? COLLATE NOCASE))");
      const pattern = `%${normalized_query}%`;
      parameters.push(pattern, pattern, pattern);
    }
    const where = filters.join(" AND ");
    const safe_limit = Math.max(1, limit);
    const safe_offset = Math.max(0, offset);
    const rows = this.database.prepare(`
      SELECT json_set(
        json_remove(record.payload, '$.source_path', '$.sections', '$.imports', '$.exports', '$.debug'),
        '$.binary_available',
        json(CASE WHEN COALESCE(json_extract(record.payload, '$.source_path'), '') <> '' THEN 'true' ELSE 'false' END),
        '$.function_count',
        (SELECT COALESCE(SUM(counts.function_count), 0)
         FROM archive_exposed_function_counts AS counts
         WHERE counts.module_id IN (
           SELECT record.id
           UNION
           SELECT alias.id
           FROM archive_module_metadata AS requested
           JOIN archive_module_metadata AS alias
             ON alias.sha256 = requested.sha256 COLLATE NOCASE
           WHERE requested.id = record.id
             AND NULLIF(requested.sha256, '') IS NOT NULL
         ))
      ) AS payload
      FROM archive_records AS record
      WHERE ${where}
      ORDER BY record.name COLLATE NOCASE, record.row_id
      LIMIT ? OFFSET ?
    `).all(...parameters, safe_limit, safe_offset) as unknown as PayloadRow[];
    const count = this.database.prepare(`
      SELECT COUNT(*) AS count
      FROM archive_records AS record
      WHERE ${where}
    `).get(...parameters) as unknown as CountRow;
    return { items: rows.map((row) => JSON.parse(row.payload) as ArchiveRecord), total: Number(count.count) };
  }

  // Kernel structures are shared across a build, but only a minority of public
  // PDBs ship type records. Aggregating types across every module in the build
  // gives the modules without types a usable library, deduplicated by name.
  build_types_page(build_id: string, offset: number, limit: number, query = "", known_total?: number) {
    const module_rows = this.database.prepare(`
      SELECT id FROM archive_records WHERE collection = 'modules' AND parent_id = ?
    `).all(build_id) as unknown as IdRow[];
    const module_ids = module_rows.map((row) => row.id);
    if (module_ids.length === 0) { return { items: [], total: 0 }; }

    const placeholders = module_ids.map(() => "?").join(", ");
    const filters = ["collection = 'types'", `parent_id IN (${placeholders})`];
    const parameters: Array<string | number> = [...module_ids];
    const normalized_query = query.trim();
    if (normalized_query) {
      filters.push("name LIKE ? ESCAPE '\\' COLLATE NOCASE");
      parameters.push(`%${escape_like(normalized_query)}%`);
    }
    const where = filters.join(" AND ");
    const rows = this.database.prepare(`
      SELECT payload, MAX(LENGTH(payload))
      FROM archive_records INDEXED BY archive_records_collection_parent_name
      WHERE ${where}
      GROUP BY name COLLATE NOCASE
      ORDER BY name COLLATE NOCASE
      LIMIT ? OFFSET ?
    `).all(...parameters, Math.max(1, limit), Math.max(0, offset)) as unknown as PayloadRow[];
    const total = known_total ?? Number((this.database.prepare(`
      SELECT COUNT(*) AS count FROM (
        SELECT 1
        FROM archive_records INDEXED BY archive_records_collection_parent_name
        WHERE ${where}
        GROUP BY name COLLATE NOCASE
      )
    `).get(...parameters) as unknown as CountRow).count);
    return { items: rows.map((row) => JSON.parse(row.payload) as ArchiveRecord), total };
  }

  private module_symbol_parent_ids(parent_id: string, collection?: "functions" | "types") {
    const rows = this.database.prepare(`
      WITH requested AS (
        SELECT NULLIF(sha256, '') AS sha256
        FROM archive_module_metadata
        WHERE id = ?
      )
      SELECT metadata.id
      FROM archive_module_metadata AS metadata
      WHERE metadata.id = ?
        OR metadata.sha256 = (SELECT sha256 FROM requested) COLLATE NOCASE
      ORDER BY CASE WHEN metadata.id = ? THEN 0 ELSE 1 END, metadata.id
    `).all(parent_id, parent_id, parent_id) as unknown as IdRow[];
    const ids = rows.map((row) => row.id);
    if (!ids.includes(parent_id)) { ids.unshift(parent_id); }
    if (!collection || ids.length < 2) { return ids; }

    // Identical binaries can each carry their own copy of the symbols, so pooling
    // every alias would list and count each symbol once per copy. Read from a
    // single owner: the requested module when it has rows, else the richest alias.
    const owners = ids
      .map((id) => ({ id, rows: Number((this.database.prepare(`
        SELECT COUNT(*) AS count
        FROM archive_records INDEXED BY archive_records_collection_parent
        WHERE collection = ? AND parent_id = ?
      `).get(collection, id) as unknown as CountRow).count) }))
      .filter((entry) => entry.rows > 0);
    if (owners.length === 0) { return ids; }
    const requested = owners.find((entry) => entry.id === parent_id);
    if (requested) { return [requested.id]; }
    return [owners.reduce((best, entry) => (entry.rows > best.rows ? entry : best)).id];
  }

  module_symbols_page(collection: "functions" | "types", parent_id: string, offset: number, limit: number, query = "") {
    const symbol_parent_ids = this.module_symbol_parent_ids(parent_id, collection);
    const parent_placeholders = symbol_parent_ids.map(() => "?").join(", ");
    const scope_filters = ["collection = ?", `parent_id IN (${parent_placeholders})`];
    if (collection === "functions") { scope_filters.push(exposed_function_condition()); }
    const scope_parameters: Array<string | number> = [collection, ...symbol_parent_ids];
    let filters = [...scope_filters];
    let parameters = [...scope_parameters];
    let known_total: number | undefined;
    const normalized_query = query.trim();
    if (normalized_query) {
      const pattern = `%${escape_like(normalized_query)}%`;
      const name_filters = [...scope_filters, "name LIKE ? ESCAPE '\\' COLLATE NOCASE"];
      const name_parameters = [...scope_parameters, pattern];
      const name_count = this.database.prepare(`
        SELECT COUNT(*) AS count
        FROM archive_records INDEXED BY archive_records_collection_parent_name
        WHERE ${name_filters.join(" AND ")}
      `).get(...name_parameters) as unknown as CountRow;
      known_total = Number(name_count.count);
      if (known_total > 0) {
        filters = name_filters;
        parameters = name_parameters;
      } else {
        // Falling back to a payload scan reads every blob in scope. node:sqlite is
        // synchronous, so on a large module that blocks the event loop for tens of
        // seconds and stalls every other request. Only scan payloads when the scope
        // is small enough to stay cheap; otherwise keep the indexed name result.
        const scope_rows = Number((this.database.prepare(`
          SELECT COUNT(*) AS count
          FROM archive_records INDEXED BY archive_records_collection_parent
          WHERE collection = ? AND parent_id IN (${parent_placeholders})
        `).get(collection, ...symbol_parent_ids) as unknown as CountRow).count);
        if (scope_rows <= payload_scan_row_limit) {
          filters.push("(name LIKE ? ESCAPE '\\' COLLATE NOCASE OR payload LIKE ? ESCAPE '\\' COLLATE NOCASE)");
          parameters.push(pattern, pattern);
          known_total = undefined;
        } else {
          filters = name_filters;
          parameters = name_parameters;
        }
      }
    }
    const where = filters.join(" AND ");
    const safe_limit = Math.max(1, limit);
    const safe_offset = Math.max(0, offset);
    const rows = this.database.prepare(`
      SELECT payload
      FROM archive_records INDEXED BY archive_records_collection_parent_name
      WHERE ${where}
      ORDER BY name COLLATE NOCASE, id
      LIMIT ? OFFSET ?
    `).all(...parameters, safe_limit, safe_offset) as unknown as PayloadRow[];
    const precomputed_total = known_total === undefined && collection === "functions" && !normalized_query
      ? Number((this.database.prepare(`
        SELECT COALESCE(SUM(function_count), 0) AS count
        FROM archive_exposed_function_counts
        WHERE module_id IN (${parent_placeholders})
      `).get(...symbol_parent_ids) as unknown as CountRow).count)
      : undefined;
    const total = known_total ?? precomputed_total ?? Number((this.database.prepare(`
      SELECT COUNT(*) AS count
      FROM archive_records INDEXED BY archive_records_collection_parent
      WHERE ${where}
    `).get(...parameters) as unknown as CountRow).count);
    return { items: rows.map((row) => JSON.parse(row.payload) as ArchiveRecord), total };
  }

  type_field_references_page(type_name: string, type_id: string, eligible_build_ids: string[], offset: number, limit: number, query = "") {
    const target_keys = type_reference_keys(type_name);
    if (target_keys.length === 0 || eligible_build_ids.length === 0) {
      return { items: [], total: 0 };
    }

    const target_placeholders = target_keys.map(() => "?").join(", ");
    const indexed_count = this.database.prepare(`SELECT COUNT(*) AS count FROM archive_type_field_references WHERE target_key IN (${target_placeholders})`).get(...target_keys) as unknown as CountRow;
    if (Number(indexed_count.count) === 0) {
      return { items: [], total: 0 };
    }
    const build_placeholders = eligible_build_ids.map(() => "?").join(", ");
    const field_path = "'$.fields[' || reference.field_index || ']'";
    const filters = [
      `reference.target_key IN (${target_placeholders})`,
      "source.id <> ?",
      `build.id IN (${build_placeholders})`,
    ];
    const parameters: Array<string | number> = [...target_keys, type_id, ...eligible_build_ids];
    const normalized_query = query.trim();
    if (normalized_query) {
      const pattern = `%${escape_like(normalized_query)}%`;
      filters.push(`(
        source.name LIKE ? ESCAPE '\\' COLLATE NOCASE
        OR json_extract(source.payload, ${field_path} || '.name') LIKE ? ESCAPE '\\' COLLATE NOCASE
        OR json_extract(source.payload, ${field_path} || '.field_type_name') LIKE ? ESCAPE '\\' COLLATE NOCASE
      )`);
      parameters.push(pattern, pattern, pattern);
    }
    const where = filters.join(" AND ");
    const count = this.database.prepare(`
      SELECT COUNT(*) AS count
      FROM archive_type_field_references AS reference
      CROSS JOIN archive_records AS source
        ON source.row_id = reference.source_row_id
        AND source.collection = 'types'
      CROSS JOIN archive_records AS module
        ON module.collection = 'modules'
        AND module.id = source.parent_id
      CROSS JOIN archive_records AS build
        ON build.collection = 'builds'
        AND build.id = module.parent_id
      WHERE ${where}
    `).get(...parameters) as unknown as CountRow;
    const rows = this.database.prepare(`
      SELECT
        build.payload AS build_payload,
        module.payload AS module_payload,
        source.payload AS type_payload,
        json_extract(source.payload, ${field_path}) AS field_payload
      FROM archive_type_field_references AS reference
      CROSS JOIN archive_records AS source
        ON source.row_id = reference.source_row_id
        AND source.collection = 'types'
      CROSS JOIN archive_records AS module
        ON module.collection = 'modules'
        AND module.id = source.parent_id
      CROSS JOIN archive_records AS build
        ON build.collection = 'builds'
        AND build.id = module.parent_id
      WHERE ${where}
      ORDER BY
        CAST(json_extract(build.payload, '$.build_number') AS INTEGER),
        CAST(json_extract(build.payload, '$.revision') AS INTEGER),
        json_extract(build.payload, '$.architecture') COLLATE NOCASE,
        module.name COLLATE NOCASE,
        source.name COLLATE NOCASE,
        reference.field_index
      LIMIT ? OFFSET ?
    `).all(...parameters, Math.max(1, limit), Math.max(0, offset)) as unknown as TypeFieldReferenceRow[];
    return {
      items: rows.map((row) => ({
        build: JSON.parse(row.build_payload) as ArchiveRecord,
        module: JSON.parse(row.module_payload) as ArchiveRecord,
        type: JSON.parse(row.type_payload) as ArchiveRecord,
        field: JSON.parse(row.field_payload) as ArchiveRecord,
      })),
      total: Number(count.count),
    };
  }

  type_function_references_page(type_name: string, eligible_build_ids: string[], offset: number, limit: number, query = "") {
    const target_keys = type_reference_keys(type_name);
    if (target_keys.length === 0 || eligible_build_ids.length === 0) {
      return { items: [], total: 0 };
    }

    const target_placeholders = target_keys.map(() => "?").join(", ");
    const indexed_count = this.database.prepare(`SELECT COUNT(*) AS count FROM archive_type_function_references WHERE target_key IN (${target_placeholders})`).get(...target_keys) as unknown as CountRow;
    if (Number(indexed_count.count) === 0) {
      return { items: [], total: 0 };
    }
    const build_placeholders = eligible_build_ids.map(() => "?").join(", ");
    const filters = [
      `reference.target_key IN (${target_placeholders})`,
      `build.id IN (${build_placeholders})`,
      exposed_function_condition("source"),
    ];
    const parameters: Array<string | number> = [...target_keys, ...eligible_build_ids];
    const normalized_query = query.trim();
    if (normalized_query) {
      const pattern = `%${escape_like(normalized_query)}%`;
      filters.push("(source.name LIKE ? ESCAPE '\\' COLLATE NOCASE OR json_extract(source.payload, '$.rva') = ? COLLATE NOCASE OR source.payload LIKE ? ESCAPE '\\' COLLATE NOCASE)");
      parameters.push(pattern, normalized_query, pattern);
    }
    const where = filters.join(" AND ");
    const count = this.database.prepare(`
      SELECT COUNT(*) AS count
      FROM archive_type_function_references AS reference
      CROSS JOIN archive_records AS source
        ON source.row_id = reference.source_row_id
        AND source.collection = 'functions'
      CROSS JOIN archive_records AS module
        ON module.collection = 'modules'
        AND module.id = source.parent_id
      CROSS JOIN archive_records AS build
        ON build.collection = 'builds'
        AND build.id = module.parent_id
      WHERE ${where}
    `).get(...parameters) as unknown as CountRow;
    const rows = this.database.prepare(`
      SELECT
        build.payload AS build_payload,
        module.payload AS module_payload,
        source.payload AS function_payload
      FROM archive_type_function_references AS reference
      CROSS JOIN archive_records AS source
        ON source.row_id = reference.source_row_id
        AND source.collection = 'functions'
      CROSS JOIN archive_records AS module
        ON module.collection = 'modules'
        AND module.id = source.parent_id
      CROSS JOIN archive_records AS build
        ON build.collection = 'builds'
        AND build.id = module.parent_id
      WHERE ${where}
      ORDER BY
        CAST(json_extract(build.payload, '$.build_number') AS INTEGER),
        CAST(json_extract(build.payload, '$.revision') AS INTEGER),
        json_extract(build.payload, '$.architecture') COLLATE NOCASE,
        module.name COLLATE NOCASE,
        source.name COLLATE NOCASE,
        json_extract(source.payload, '$.rva') COLLATE NOCASE
      LIMIT ? OFFSET ?
    `).all(...parameters, Math.max(1, limit), Math.max(0, offset)) as unknown as TypeFunctionReferenceRow[];
    return {
      items: rows.map((row) => ({
        build: JSON.parse(row.build_payload) as ArchiveRecord,
        module: JSON.parse(row.module_payload) as ArchiveRecord,
        function: JSON.parse(row.function_payload) as ArchiveRecord,
      })),
      total: Number(count.count),
    };
  }

  type_reference_counts(type_name: string, type_id: string, eligible_build_ids: string[]) {
    return {
      fields: this.type_field_references_page(type_name, type_id, eligible_build_ids, 0, 1).total,
      functions: this.type_function_references_page(type_name, eligible_build_ids, 0, 1).total,
    };
  }

  archive_files_page(offset: number, limit: number, query = "", status = "", pdb_status = "") {
    const filters = ["collection = 'archive_files'"];
    const parameters: Array<string | number> = [];
    const normalized_query = query.trim();
    if (normalized_query) {
      filters.push("(name LIKE ? COLLATE NOCASE OR json_extract(payload, '$.relative_path') LIKE ? COLLATE NOCASE OR json_extract(payload, '$.module_name') LIKE ? COLLATE NOCASE)");
      const pattern = `%${normalized_query}%`;
      parameters.push(pattern, pattern, pattern);
    }
    if (status) {
      filters.push("json_extract(payload, '$.status') = ?");
      parameters.push(status);
    }
    if (pdb_status) {
      filters.push("json_extract(payload, '$.pdb_status') = ?");
      parameters.push(pdb_status);
    }
    const where = filters.join(" AND ");
    const safe_limit = Math.max(1, limit);
    const safe_offset = Math.max(0, offset);
    const rows = this.database.prepare(`
      SELECT payload
      FROM archive_records
      WHERE ${where}
      ORDER BY row_id DESC
      LIMIT ? OFFSET ?
    `).all(...parameters, safe_limit, safe_offset) as unknown as PayloadRow[];
    const count = this.database.prepare(`
      SELECT COUNT(*) AS count
      FROM archive_records
      WHERE ${where}
    `).get(...parameters) as unknown as CountRow;
    return { items: rows.map((row) => JSON.parse(row.payload) as ArchiveRecord), total: Number(count.count) };
  }

  exposed_function_count(parent_id: string) {
    const symbol_parent_ids = this.module_symbol_parent_ids(parent_id);
    const parent_placeholders = symbol_parent_ids.map(() => "?").join(", ");
    const row = this.database.prepare(`
      SELECT COALESCE(SUM(function_count), 0) AS count
      FROM archive_exposed_function_counts
      WHERE module_id IN (${parent_placeholders})
    `).get(...symbol_parent_ids) as unknown as CountRow;
    return Number(row.count);
  }

  exposed_function_total() {
    const row = this.database.prepare("SELECT COALESCE(SUM(function_count), 0) AS count FROM archive_exposed_function_counts").get() as unknown as CountRow;
    return Number(row.count);
  }

  // Takes the field-reference index out of the write path for a bulk type rewrite,
  // and empties it so the delete trigger has nothing to chase. Everything that reads
  // "used by" returns nothing until restore_type_field_references puts it back, so
  // only call this with the API stopped.
  defer_type_field_references() {
    this.database.exec(`
      DROP TRIGGER IF EXISTS archive_type_field_references_insert;
      DROP TRIGGER IF EXISTS archive_type_field_references_delete;
      DROP TRIGGER IF EXISTS archive_type_field_references_update;
      DELETE FROM archive_type_field_references;
    `);
    // Clearing the version gate is the safety net. Opening this store recreates the
    // triggers from the schema either way, so a caller that dies here would leave an
    // empty index that looks healthy and silently answers "used by" with nothing.
    // Without the gate the next process to open the archive rebuilds it instead.
    this.database.prepare("DELETE FROM archive_meta WHERE key = 'type_references_version'").run();
  }

  // Rebuilds the field-reference index in one pass and puts the triggers back. One
  // sorted bulk insert is a fraction of the cost of the same rows arriving one type
  // at a time.
  restore_type_field_references() {
    const started_at = Date.now();
    this.database.exec("BEGIN IMMEDIATE");
    try {
      this.database.prepare(`
        INSERT OR IGNORE INTO archive_type_field_references (target_key, source_row_id, field_index)
        SELECT
          kernelarchive_type_reference(json_extract(field.value, '$.field_type_name')),
          record.row_id,
          CAST(field.key AS INTEGER)
        FROM archive_records AS record INDEXED BY archive_records_collection_parent
        JOIN json_each(record.payload, '$.fields') AS field
        WHERE record.collection = 'types'
          AND kernelarchive_type_reference(json_extract(field.value, '$.field_type_name')) <> ''
      `).run();
      this.database.prepare("INSERT OR REPLACE INTO archive_meta (key, value) VALUES ('type_references_version', ?)").run(type_references_version);
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
    this.database.exec(type_field_reference_triggers);
    const row = this.database.prepare("SELECT COUNT(*) AS count FROM archive_type_field_references").get() as unknown as CountRow | undefined;
    return { rows: Number(row?.count ?? 0), duration_ms: Date.now() - started_at };
  }

  // The modules a type re-extraction has to visit. Most of the archive has no type
  // records at all: a public PDB with only exports still gets a module row, so this
  // is a small fraction of the module table and worth asking the index for rather
  // than walking every module.
  type_record_owner_ids() {
    const rows = this.database.prepare(`
      SELECT DISTINCT parent_id AS id
      FROM archive_records INDEXED BY archive_records_collection_parent
      WHERE collection = 'types' AND parent_id IS NOT NULL
      ORDER BY parent_id
    `).all() as unknown as IdRow[];
    return rows.map((row) => row.id);
  }

  count(collection: ArchiveCollection, parent_id?: string) {
    const row = parent_id === undefined
      ? this.database.prepare("SELECT records AS count FROM archive_collection_counts WHERE collection = ?").get(collection)
      : this.database.prepare("SELECT COUNT(*) AS count FROM archive_records WHERE collection = ? AND parent_id = ?").get(collection, parent_id);
    return Number((row as unknown as CountRow | undefined)?.count ?? 0);
  }

  module_counts_by_build() {
    const rows = this.database.prepare(`
      SELECT
        counts.build_id,
        counts.module_count,
        counts.symbol_count,
        COALESCE((
          SELECT SUM(visible.function_count)
          FROM archive_records AS module_record
          LEFT JOIN archive_exposed_function_counts AS visible ON visible.module_id = module_record.id
          WHERE module_record.collection = 'modules'
            AND module_record.parent_id = counts.build_id
        ), 0) AS function_count,
        counts.type_count
      FROM archive_module_counts AS counts
      ORDER BY counts.build_id
    `).all() as unknown as ModuleCountsRow[];
    return rows.map((row) => ({
      build_id: row.build_id,
      module_count: Number(row.module_count),
      symbol_count: Number(row.symbol_count),
      function_count: Number(row.function_count),
      type_count: Number(row.type_count),
    }));
  }

  search(query: string, offset: number, limit: number, filters: ArchiveSearchFilters = {}) {
    const normalized = query.trim();
    if (!normalized) { return { items: [] as ArchiveSearchRow[], total: 0 }; }
    const core = normalized.replace(/^_+/, "") || normalized;
    const name_start = normalized;
    const name_end = `${normalized}\uffff`;
    const underscore_start = `_${core}`;
    const underscore_end = `${underscore_start}\uffff`;
    const score_prefix = `${escape_like(normalized)}%`;
    const score_underscore_prefix = `${escape_like(underscore_start)}%`;
    const contains = `%${escape_like(normalized)}%`;
    const metadata_search = normalized.toLowerCase().endsWith(".pdb") || /^[0-9a-f-]{8,}$/i.test(normalized);
    const kind_collection = filters.kind ? ({ module: "modules", function: "functions", type: "types" }[filters.kind] ?? "unsupported") : "";
    if (kind_collection === "unsupported") { return { items: [] as ArchiveSearchRow[], total: 0 }; }
    const module_filter = filters.module?.trim() ?? "";
    const build_filter = filters.build?.trim() ?? "";
    const architecture_filter = filters.architecture?.trim() ?? "";
    const eligible_build_ids = filters.eligible_build_ids;
    const eligible_build_filter = !eligible_build_ids
      ? ""
      : eligible_build_ids.length > 0
        ? `AND id IN (${eligible_build_ids.map(() => "?").join(", ")})`
        : "AND 0";
    const relation_filter_active = Boolean(module_filter || build_filter || architecture_filter || eligible_build_ids);
    const collection_filter = kind_collection ? "record.collection = ?" : "record.collection IN ('modules', 'functions', 'types')";
    const collection_parameters = kind_collection ? [kind_collection] : [];
    const same_range = name_start.toLowerCase() === underscore_start.toLowerCase();
    const name_filter = same_range
      ? "record.name >= ? COLLATE NOCASE AND record.name < ? COLLATE NOCASE"
      : "((record.name >= ? COLLATE NOCASE AND record.name < ? COLLATE NOCASE) OR (record.name >= ? COLLATE NOCASE AND record.name < ? COLLATE NOCASE))";
    const name_parameters = same_range
      ? [name_start, name_end]
      : [name_start, name_end, underscore_start, underscore_end];
    const eligibility_filter = relation_filter_active ? `
          AND (
            (record.collection = 'modules' AND record.id IN (SELECT id FROM eligible_modules))
            OR (record.collection IN ('functions', 'types') AND record.parent_id IN (SELECT id FROM eligible_modules))
          )` : "";
    const metadata_match = metadata_search && (!kind_collection || kind_collection === "modules") ? `
        UNION
        SELECT record.id, record.collection, record.name, record.parent_id
        FROM archive_records AS record
        JOIN archive_module_metadata AS metadata ON metadata.id = record.id
        WHERE record.collection = 'modules'
          AND (
            metadata.sha256 LIKE ? ESCAPE '\\' COLLATE NOCASE
            OR metadata.pdb_guid LIKE ? ESCAPE '\\' COLLATE NOCASE
            OR metadata.pdb_name LIKE ? ESCAPE '\\' COLLATE NOCASE
          )${eligibility_filter}` : "";
    const rows = this.database.prepare(`
      WITH eligible_builds AS (
        SELECT id
        FROM archive_records
        WHERE collection = 'builds'
          AND (? = '' OR id = ? OR json_extract(payload, '$.build_number') = ?)
          AND (? = '' OR json_extract(payload, '$.architecture') = ? COLLATE NOCASE)
          ${eligible_build_filter}
      ),
      eligible_modules AS (
        SELECT id
        FROM archive_records
        WHERE collection = 'modules'
          AND (? = '' OR name = ? COLLATE NOCASE)
          AND parent_id IN (SELECT id FROM eligible_builds)
      ),
      matched AS (
        SELECT record.id, record.collection, record.name, record.parent_id
        FROM archive_records AS record
        WHERE ${collection_filter}
          AND record.name IS NOT NULL
          AND (record.collection <> 'functions' OR ${exposed_function_condition("record")})
          AND ${name_filter}${eligibility_filter}${metadata_match}
        LIMIT ?
      ),
      ranked AS (
        SELECT
          matched.id,
          matched.collection,
          matched.name,
          matched.parent_id,
          CASE
            WHEN matched.name = ? COLLATE NOCASE OR ltrim(matched.name, '_') = ? COLLATE NOCASE THEN 1.0
            WHEN matched.name LIKE ? ESCAPE '\\' COLLATE NOCASE OR matched.name LIKE ? ESCAPE '\\' COLLATE NOCASE THEN
              CASE matched.collection WHEN 'types' THEN 0.90 WHEN 'functions' THEN 0.88 ELSE 0.85 END
            ELSE 0.68
          END AS score,
          COUNT(*) OVER() AS total
        FROM matched
      ),
      paged AS (
        SELECT *
        FROM ranked
        ORDER BY score DESC, LENGTH(name), name COLLATE NOCASE
        LIMIT ? OFFSET ?
      )
      SELECT
        paged.id,
        paged.collection,
        paged.name,
        CASE WHEN paged.collection = 'modules' THEN paged.name ELSE module_record.name END AS module_name,
        CASE WHEN paged.collection = 'modules' THEN paged.parent_id ELSE module_record.parent_id END AS build_id,
        json_extract(build_record.payload, '$.build_number') AS build_number,
        json_extract(build_record.payload, '$.architecture') AS architecture,
        paged.score,
        paged.total
      FROM paged
      LEFT JOIN archive_records AS module_record
        ON paged.collection IN ('functions', 'types')
        AND module_record.collection = 'modules'
        AND module_record.id = paged.parent_id
      LEFT JOIN archive_records AS build_record
        ON build_record.collection = 'builds'
        AND build_record.id = CASE WHEN paged.collection = 'modules' THEN paged.parent_id ELSE module_record.parent_id END
      ORDER BY paged.score DESC, LENGTH(paged.name), paged.name COLLATE NOCASE
    `).all(
      build_filter, build_filter, build_filter,
      architecture_filter, architecture_filter,
      ...(eligible_build_ids ?? []),
      module_filter, module_filter,
      ...collection_parameters,
      ...name_parameters,
      ...(metadata_match ? [contains, contains, contains] : []),
      search_candidate_limit,
      normalized, core, score_prefix, score_underscore_prefix,
      Math.max(1, limit), Math.max(0, offset),
    ) as unknown as ArchiveSearchRow[];
    return { items: rows, total: Number(rows[0]?.total ?? 0) };
  }

  archive_file_status_counts() {
    const rows = this.database.prepare(`
      SELECT json_extract(payload, '$.status') AS status, COUNT(*) AS records
      FROM archive_records
      WHERE collection = 'archive_files'
      GROUP BY json_extract(payload, '$.status')
    `).all() as unknown as ArchiveStatusCountRow[];
    return Object.fromEntries(rows.filter((row) => row.status).map((row) => [row.status as string, Number(row.records)]));
  }

  // Lets a caller drop a cached pattern so the next request regenerates it with
  // the current generator instead of replaying an older, weaker signature.
  remove_patterns_for_function(function_id: string, binary_sha256?: string) {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const removed = binary_sha256
        ? this.database.prepare("DELETE FROM archive_records WHERE collection = 'patterns' AND parent_id = ? AND json_extract(payload, '$.binary_sha256') = ?").run(function_id, binary_sha256)
        : this.database.prepare("DELETE FROM archive_records WHERE collection = 'patterns' AND parent_id = ?").run(function_id);
      this.database.prepare("UPDATE archive_meta SET value = CAST(value AS INTEGER) + 1 WHERE key = 'revision'").run();
      this.database.exec("COMMIT");
      return Number(removed.changes ?? 0);
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  upsert(changes: ArchiveChanges) {
    return this.write_changes(changes, true);
  }

  replace_module(module_id: string, changes: ArchiveChanges) {
    return this.write_changes(changes, true, module_id);
  }

  // Swaps out one module's type records and nothing else. replace_module cannot do
  // this: it also drops the module's functions and patterns, and a re-extraction of
  // types alone has nothing to put back in their place. Delete and insert share one
  // transaction because module_symbol_parent_ids treats a module with no type rows
  // as an alias and serves a sha256-identical sibling's types instead, so a module
  // caught mid-write would show another module's definitions rather than none.
  replace_module_types(module_id: string, types: ArchiveRecord[], options: { rollback?: boolean } = {}) {
    const statement = this.database.prepare(`
      INSERT INTO archive_records (collection, id, parent_id, name, payload, updated_at)
      VALUES ('types', ?, ?, ?, ?, ?)
      ON CONFLICT (collection, id) DO UPDATE SET
        parent_id = excluded.parent_id,
        name = excluded.name,
        payload = excluded.payload,
        updated_at = excluded.updated_at
    `);
    const now = Date.now();
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const removed = this.database.prepare("DELETE FROM archive_records WHERE collection = 'types' AND parent_id = ?").run(module_id);
      let inserted = 0;
      for (const record of types) {
        if (!record?.id) { continue; }
        const metadata = record_metadata("types", record);
        statement.run(record.id, metadata.parent_id, metadata.name, JSON.stringify(record), now);
        inserted += 1;
      }
      // Four caches in ingestion-cache.ts key on this counter and one of them has no
      // expiry, so without the bump a running API serves the old definitions forever.
      this.database.prepare("UPDATE archive_meta SET value = CAST(value AS INTEGER) + 1 WHERE key = 'revision'").run();
      this.database.exec(options.rollback ? "ROLLBACK" : "COMMIT");
      return { removed: Number(removed.changes), inserted };
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  private write_changes(changes: ArchiveChanges, increment_revision: boolean, replace_module_id?: string) {
    const before = this.revision();
    const statement = this.database.prepare(`
      INSERT INTO archive_records (collection, id, parent_id, name, payload, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT (collection, id) DO UPDATE SET
        parent_id = excluded.parent_id,
        name = excluded.name,
        payload = excluded.payload,
        updated_at = excluded.updated_at
    `);
    const now = Date.now();
    this.database.exec("BEGIN IMMEDIATE");
    try {
      if (replace_module_id) {
        this.database.prepare("DELETE FROM archive_records WHERE collection IN ('functions', 'types') AND parent_id = ?").run(replace_module_id);
        this.database.prepare("DELETE FROM archive_records WHERE collection = 'patterns' AND json_extract(payload, '$.module_id') = ?").run(replace_module_id);
      }
      for (const collection of archive_collections) {
        for (const record of changes[collection] ?? []) {
          if (!record?.id) { continue; }
          const metadata = record_metadata(collection, record);
          statement.run(collection, record.id, metadata.parent_id, metadata.name, JSON.stringify(record), now);
        }
      }
      if (increment_revision || before === 0) {
        this.database.prepare("UPDATE archive_meta SET value = CAST(value AS INTEGER) + 1 WHERE key = 'revision'").run();
      }
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
    return { previous_revision: before, revision: this.revision() };
  }

  stats() {
    const rows = this.database.prepare(`
      SELECT collection, COUNT(*) AS records, COALESCE(SUM(LENGTH(payload)), 0) AS bytes
      FROM archive_records
      GROUP BY collection
      ORDER BY collection
    `).all() as unknown as CollectionStatsRow[];
    return {
      path: this.path,
      revision: this.revision(),
      collections: rows,
    };
  }

  prune_orphans() {
    let removed = 0;
    this.database.exec("BEGIN IMMEDIATE");
    try {
      removed += Number(this.database.prepare(`
        DELETE FROM archive_records AS record
        WHERE record.collection = 'modules'
          AND NOT EXISTS (
            SELECT 1 FROM archive_records AS parent
            WHERE parent.collection = 'builds' AND parent.id = record.parent_id
          )
      `).run().changes);
      removed += Number(this.database.prepare(`
        DELETE FROM archive_records AS record
        WHERE record.collection IN ('functions', 'types')
          AND NOT EXISTS (
            SELECT 1 FROM archive_records AS parent
            WHERE parent.collection = 'modules' AND parent.id = record.parent_id
          )
      `).run().changes);
      removed += Number(this.database.prepare(`
        DELETE FROM archive_records AS record
        WHERE record.collection = 'patterns'
          AND (
            NOT EXISTS (
              SELECT 1 FROM archive_records AS fn
              WHERE fn.collection = 'functions' AND fn.id = json_extract(record.payload, '$.function_id')
            )
            OR NOT EXISTS (
              SELECT 1 FROM archive_records AS module
              WHERE module.collection = 'modules' AND module.id = json_extract(record.payload, '$.module_id')
            )
          )
      `).run().changes);
      removed += Number(this.database.prepare(`
        DELETE FROM archive_records AS record
        WHERE record.collection = 'ingestions'
          AND (
            NOT EXISTS (
              SELECT 1 FROM archive_records AS build
              WHERE build.collection = 'builds' AND build.id = json_extract(record.payload, '$.build_id')
            )
            OR NOT EXISTS (
              SELECT 1 FROM archive_records AS module
              WHERE module.collection = 'modules' AND module.id = json_extract(record.payload, '$.module_id')
            )
          )
      `).run().changes);
      if (removed > 0) {
        this.database.prepare("UPDATE archive_meta SET value = CAST(value AS INTEGER) + 1 WHERE key = 'revision'").run();
      }
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
    return removed;
  }

  close() {
    this.database.close();
  }
}
