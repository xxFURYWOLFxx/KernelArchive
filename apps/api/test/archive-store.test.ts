import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ArchiveStore } from "../src/archive-store";

test("migrates the legacy archive and shares atomic updates across store instances", () => {
  const root = mkdtempSync(join(tmpdir(), "kernelarchive-store-"));
  const legacy_path = join(root, "index.json");
  const database_path = join(root, "archive.sqlite");
  writeFileSync(legacy_path, JSON.stringify({
    builds: [{ id: "build_1", product_name: "Windows", build_number: "1" }],
    modules: [{ id: "module_1", build_id: "build_1", name: "kernel.exe", sha256: "shared-binary", symbol_count: 3, function_count: 2, type_count: 1, exports: [] }],
    functions: [{ id: "function_1", module_id: "module_1", name: "FunctionOne", symbol_kind: "pdb-function" }],
    types: [{ id: "type_1", module_id: "module_1", name: "_TYPE" }],
    patterns: [{ id: "orphan_pattern", function_id: "missing", module_id: "missing", pattern: "90", mask: "x" }],
    pdb_lookups: [],
    ingestions: [],
    archive_files: [{ id: "archive_file_1", relative_path: "Windows/Test/System32/drivers/alpha.sys", module_name: "alpha.sys", status: "indexed", pdb_status: "missing" }],

  }));

  const first = new ArchiveStore(database_path, legacy_path);
  const migrated = first.load();
  assert.equal(migrated.builds.length, 1);
  assert.equal(migrated.functions[0]?.name, "FunctionOne");
  assert.equal(migrated.patterns.length, 0);
  assert.equal(first.count("builds"), 1);
  assert.equal(first.count("functions"), 1);
  assert.equal(first.count("patterns"), 0);
  const module_counts = first.module_counts_by_build();
  assert.equal(module_counts[0]?.build_id, "build_1");
  assert.equal(module_counts[0]?.module_count, 1);
  assert.equal(module_counts[0]?.symbol_count, 3);
  assert.equal(module_counts[0]?.function_count, 1);
  assert.equal(module_counts[0]?.type_count, 1);
  first.upsert({
    modules: [{ id: "module_1", build_id: "build_1", name: "kernel.exe", sha256: "shared-binary", symbol_count: 7, function_count: 4, type_count: 2, exports: [] }],
  });
  const updated_module_counts = first.module_counts_by_build();
  assert.equal(updated_module_counts[0]?.module_count, 1);
  assert.equal(updated_module_counts[0]?.symbol_count, 7);
  assert.equal(updated_module_counts[0]?.function_count, 1);
  assert.equal(updated_module_counts[0]?.type_count, 2);
  first.upsert({
    modules: [
      { id: "module_alpha", build_id: "build_1", name: "alpha.sys", original_path: "\\SystemRoot\\System32\\drivers\\alpha.sys", pdb_name: "alpha.pdb" },
      { id: "module_beta", build_id: "build_1", name: "beta.sys", original_path: "\\SystemRoot\\System32\\drivers\\beta.sys", pdb_name: "beta.pdb" },
    ],
  });
  const first_module_page = first.module_summaries_page("build_1", 0, 1);
  assert.equal(first_module_page.total, 3);
  assert.equal(first_module_page.items[0]?.id, "module_alpha");
  const filtered_module_page = first.module_summaries_page("build_1", 0, 10, "beta.pdb");
  assert.equal(filtered_module_page.total, 1);
  assert.equal(filtered_module_page.items[0]?.id, "module_beta");
  const path_module_page = first.module_summaries_page("build_1", 0, 10, "drivers\\beta");
  assert.equal(path_module_page.total, 1);
  assert.equal(path_module_page.items[0]?.id, "module_beta");
  first.upsert({
    modules: [{ id: "module_alias", build_id: "build_1", name: "kernel.exe", sha256: "shared-binary" }],
  });

  const archive_files = first.archive_files_page(0, 10, "alpha", "indexed", "missing");
  assert.equal(archive_files.total, 1);
  assert.equal(archive_files.items[0]?.id, "archive_file_1");
  const function_search = first.search("Function", 0, 10, { kind: "function" });
  assert.equal(function_search.total, 1);
  assert.equal(function_search.items[0]?.name, "FunctionOne");
  assert.equal(function_search.items[0]?.collection, "functions");
  const type_search = first.search("TYPE", 0, 10, { kind: "type" });
  assert.equal(type_search.total, 1);
  assert.equal(type_search.items[0]?.name, "_TYPE");
  assert.equal(type_search.items[0]?.collection, "types");
  const initial_revision = first.revision();
  const module_revision = first.module_revision("build_1");

  const second = new ArchiveStore(database_path, legacy_path);
  const write = second.upsert({
    patterns: [{ id: "pattern_1", function_id: "function_1", module_id: "module_1", pattern: "48 89", mask: "xx" }],
  });
  assert.equal(write.previous_revision, initial_revision);
  assert.equal(first.revision(), write.revision);
  assert.equal(first.module_revision("build_1"), module_revision);
  assert.equal(first.load().patterns[0]?.id, "pattern_1");
  assert.equal(first.count("patterns"), 1);

  second.replace_module("module_1", {
    functions: [{ id: "function_2", module_id: "module_1", name: "FunctionTwo", symbol_kind: "pdb-function" }],
    types: [{ id: "type_2", module_id: "module_1", name: "_TYPE_TWO" }],
  });
  const replaced = first.load();
  assert.deepEqual(replaced.functions.map((item) => item.id), ["function_2"]);
  assert.deepEqual(replaced.types.map((item) => item.id), ["type_2"]);
  assert.equal(replaced.patterns.length, 0);
  assert.equal(first.count("functions"), 1);
  assert.equal(first.count("types"), 1);
  assert.equal(first.count("patterns"), 0);
  const aliased_functions = first.module_symbols_page("functions", "module_alias", 0, 10);
  assert.equal(aliased_functions.total, 1);
  assert.equal(aliased_functions.items[0]?.id, "function_2");
  first.upsert({
    modules: [{ id: "module_other", build_id: "build_1", name: "other.exe", sha256: "other-binary", exports: [{ name: "LegacyExport", rva: "0x00001000" }] }],
    types: [{ id: "type_reference_container", module_id: "module_other", name: "_CONTAINER", kind: "struct", fields: [{ id: "field_type_two", type_id: "type_reference_container", name: "Target", field_type_name: "const _TYPE_TWO*", offset_bits: 64, size_bits: 64, flags_json: {} }] }],
    functions: [
      { id: "function_thread_alias", module_id: "module_alias", name: "ThreadFromSameBinary", symbol_kind: "pdb-function" },
      { id: "function_thread_other", module_id: "module_other", name: "ThreadFromOtherBinary", symbol_kind: "pdb-function", return_type: "_TYPE_TWO*", calling_convention: "NTAPI", parameters_json: [], rva: "0x2000" },
      { id: "function_legacy_unknown", module_id: "module_alias", name: "LegacyUnknownFunction", return_type: "unknown", calling_convention: "unknown" },
      { id: "function_public_tagged", module_id: "module_alias", name: "PublicOnlyTagged", symbol_kind: "pdb-public", return_type: "PDB symbol", calling_convention: "PDB public", is_exported: false },
      { id: "function_public_legacy", module_id: "module_alias", name: "PublicOnlyLegacy", return_type: "PDB symbol", calling_convention: "PDB public", is_exported: false },
      { id: "function_legacy_export", module_id: "module_other", name: "LegacyExport", rva: "0x1000", return_type: "PDB symbol", calling_convention: "PDB public", is_exported: true },
      { id: "function_legacy_export_alias", module_id: "module_other", name: "PublicAliasAtExport", rva: "0x00001000", return_type: "PDB symbol", calling_convention: "PDB public", is_exported: true },
    ],
  });
  const field_references = first.type_field_references_page("_TYPE_TWO", "type_2", ["build_1"], 0, 10);
  assert.equal(field_references.total, 1);
  assert.equal(field_references.items[0]?.type.id, "type_reference_container");
  assert.equal(field_references.items[0]?.field.id, "field_type_two");
  const filtered_field_references = first.type_field_references_page("_TYPE_TWO", "type_2", ["build_1"], 0, 10, "Target");
  assert.equal(filtered_field_references.total, 1);
  const function_references = first.type_function_references_page("_TYPE_TWO", ["build_1"], 0, 10);
  assert.equal(function_references.total, 1);
  assert.equal(function_references.items[0]?.function.id, "function_thread_other");
  assert.deepEqual(first.type_reference_counts("_TYPE_TWO", "type_2", ["build_1"]), { fields: 1, functions: 1 });

  const complete_alias = first.module_symbols_page("functions", "module_alias", 0, 10);
  assert.equal(complete_alias.total, 3);
  assert.deepEqual(complete_alias.items.map((item) => item.id), ["function_2", "function_legacy_unknown", "function_thread_alias"]);
  const scoped_functions = first.module_symbols_page("functions", "module_1", 0, 10, "Thread");
  assert.equal(scoped_functions.total, 1);
  assert.equal(scoped_functions.items[0]?.id, "function_thread_alias");
  assert.equal(first.load_by_name("functions", "PublicOnlyTagged").length, 0);
  assert.equal(first.load_by_name("functions", "PublicOnlyLegacy").length, 0);
  assert.equal(first.load_by_name("functions", "LegacyExport").length, 1);
  assert.equal(first.load_by_name("functions", "PublicAliasAtExport").length, 0);
  assert.equal(first.load_by_name("functions", "LegacyUnknownFunction").length, 1);
  assert.equal(first.search("PublicOnly", 0, 10, { kind: "function" }).total, 0);
  assert.equal(first.exposed_function_count("module_alias"), 3);
  const corrected_module_page = first.module_summaries_page("build_1", 0, 10, "kernel.exe");
  const corrected_alias = corrected_module_page.items.find((item) => item.id === "module_alias");
  assert.equal(corrected_alias?.function_count, 3);
  assert.equal(first.module_counts_by_build()[0]?.function_count, 5);
  first.upsert({
    modules: [{ id: "module_other", build_id: "build_1", name: "other.exe", sha256: "other-binary", exports: [] }],
  });
  assert.equal(first.load_by_name("functions", "LegacyExport").length, 0);
  assert.equal(first.module_counts_by_build()[0]?.function_count, 4);
  first.upsert({
    modules: [{ id: "module_other", build_id: "build_1", name: "other.exe", sha256: "other-binary", exports: [{ name: "LegacyExport", rva: "0x00001000" }] }],
  });
  assert.equal(first.load_by_name("functions", "LegacyExport").length, 1);
  assert.equal(first.module_counts_by_build()[0]?.function_count, 5);
  first.upsert({
    functions: [{ id: "function_transition", module_id: "module_other", name: "TransitionFunction", symbol_kind: "pdb-function" }],
  });
  assert.equal(first.module_counts_by_build()[0]?.function_count, 6);
  first.upsert({
    functions: [{ id: "function_transition", module_id: "module_other", name: "TransitionFunction", symbol_kind: "pdb-public", return_type: "PDB symbol", calling_convention: "PDB public" }],
  });
  assert.equal(first.module_counts_by_build()[0]?.function_count, 5);
  assert.equal(first.load_by_name("functions", "TransitionFunction").length, 0);

  second.close();
  first.close();
  rmSync(root, { force: true, recursive: true });
});
