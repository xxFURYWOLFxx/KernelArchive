import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after, before } from "node:test";
import type { FastifyInstance } from "fastify";

const root = mkdtempSync(join(tmpdir(), "kernelarchive-api-"));
const cache_root = join(root, "cache");
const archive_root = join(root, "Archive");
const binary_path = join(root, "kernel.exe");
const cached_binary_path = join(cache_root, "binaries", "0".repeat(64), "kernel.exe");
const temporary_password = "Temporary1!KernelArchivePassword";
const permanent_password = "Permanent2!KernelArchivePassword";
let server: FastifyInstance;

function session_cookie(value: string | string[] | undefined) {
  return String(Array.isArray(value) ? value[0] : value).split(";", 1)[0] ?? "";
}

before(async () => {
  mkdirSync(cache_root, { recursive: true });
  mkdirSync(archive_root, { recursive: true });
  writeFileSync(binary_path, Buffer.alloc(8192, 0x90));
  mkdirSync(join(cache_root, "binaries", "0".repeat(64)), { recursive: true });
  writeFileSync(cached_binary_path, Buffer.alloc(8192, 0x90));
  process.env.KERNELARCHIVE_LOCAL_CACHE_DIR = cache_root;
  process.env.KERNELARCHIVE_DATA_DB_PATH = join(cache_root, "archive.sqlite");
  process.env.KERNELARCHIVE_AUTH_DB_PATH = join(cache_root, "auth.sqlite");
  process.env.KERNELARCHIVE_ARCHIVE_DIR = archive_root;
  process.env.KERNELARCHIVE_ARCHIVE_SCAN_INTERVAL_MS = "60000";
  process.env.PUBLIC_APP_URL = "http://localhost:3003";
  process.env.KERNELARCHIVE_API_KEY = "test-api-key-with-at-least-32-characters";
  process.env.RATE_LIMIT_PUBLIC_PER_MINUTE = "1000";
  process.env.RATE_LIMIT_AUTH_PER_MINUTE = "1000";

  const legacy_index = {
    builds: [{
      id: "build_test",
      product_name: "Windows 11",
      version: "24H2",
      build_number: "26100",
      revision: "1",
      architecture: "x64",
      release_channel: "test",
      published: true,
      created_at: new Date(0).toISOString(),
    }, {
      id: "build_test_previous",
      product_name: "Windows 10",
      version: "22H2",
      build_number: "19045",
      revision: "1",
      architecture: "x64",
      release_channel: "test",
      published: true,
      created_at: new Date(0).toISOString(),
    }, {
      id: "build_test_unrelated",
      product_name: "Windows 11",
      version: "23H2",
      build_number: "22621",
      revision: "1",
      architecture: "x64",
      release_channel: "test",
      published: true,
      created_at: new Date(0).toISOString(),
    }, {
      id: "build_invalid_windows_11_x86",
      product_name: "Windows 11",
      version: "24H2",
      build_number: "26100",
      revision: "1",
      architecture: "x86",
      release_channel: "test",
      published: true,
      created_at: new Date(0).toISOString(),
    }],
    modules: [{
      id: "module_test",
      build_id: "build_test",
      name: "kernel.exe",
      source_path: cached_binary_path,
      original_path: "\\SystemRoot\\System32\\kernel.exe",
      image_base: "0x140000000",
      image_size: 8192,
      entry_point: "0x1000",
      machine: "AMD64",
      timestamp: "0x0",
      checksum: "0x0",
      sha256: "0".repeat(64),
      pdb_name: "kernel.pdb",
      pdb_guid: "TEST",
      pdb_age: 1,
      symbol_count: 1,
      type_count: 1,
      function_count: 2,
      sections: [{ name: ".text", virtual_address: "0x1000", raw_offset: "0x1000", virtual_size: 4096, raw_size: 4096, characteristics: "0x60000020" }],
      imports: [],
      exports: [
        { name: "FunctionOne", ordinal: 1, rva: "0x1000" },
        { name: "LegacyExport", ordinal: 2, rva: "0x1008" },
      ],
      debug: null,
      created_at: new Date(0).toISOString(),
    }, {
      id: "module_test_previous",
      build_id: "build_test_previous",
      name: "kernel.exe",
      source_path: binary_path,
      original_path: "\\SystemRoot\\System32\\kernel.exe",
      image_base: "0x140000000",
      image_size: 8192,
      entry_point: "0x1000",
      machine: "AMD64",
      timestamp: "0x0",
      checksum: "0x0",
      sha256: "2".repeat(64),
      pdb_name: "kernel.pdb",
      pdb_guid: "PREVIOUS",
      pdb_age: 1,
      symbol_count: 0,
      type_count: 1,
      function_count: 0,
      sections: [{ name: ".text", virtual_address: "0x1000", raw_offset: "0x1000", virtual_size: 4096, raw_size: 4096, characteristics: "0x60000020" }],
      imports: [],
      exports: [],
      debug: null,
      created_at: new Date(0).toISOString(),
    }, {
      id: "module_test_unrelated",
      build_id: "build_test_unrelated",
      name: "other.sys",
      source_path: binary_path,
      original_path: "\\SystemRoot\\System32\\drivers\\other.sys",
      image_base: "0xfffff80000000000",
      image_size: 8192,
      entry_point: "0x1000",
      machine: "AMD64",
      timestamp: "0x0",
      checksum: "0x0",
      sha256: "3".repeat(64),
      pdb_name: "other.pdb",
      pdb_guid: "UNRELATED",
      pdb_age: 1,
      symbol_count: 0,
      type_count: 1,
      function_count: 0,
      sections: [{ name: ".text", virtual_address: "0x1000", raw_offset: "0x1000", virtual_size: 4096, raw_size: 4096, characteristics: "0x60000020" }],
      imports: [],
      exports: [],
      debug: null,
      created_at: new Date(0).toISOString(),
    }, {
      id: "module_invalid_windows_11_x86",
      build_id: "build_invalid_windows_11_x86",
      name: "compatibility.sys",
      source_path: binary_path,
      original_path: "\\SystemRoot\\SysWOW64\\drivers\\compatibility.sys",
      image_base: "0x10000000",
      image_size: 8192,
      entry_point: "0x1000",
      machine: "I386",
      timestamp: "0x0",
      checksum: "0x0",
      sha256: "1".repeat(64),
      pdb_name: "compatibility.pdb",
      pdb_guid: "INVALID",
      pdb_age: 1,
      symbol_count: 1,
      type_count: 0,
      function_count: 1,
      sections: [{ name: ".text", virtual_address: "0x1000", raw_offset: "0x1000", virtual_size: 4096, raw_size: 4096, characteristics: "0x60000020" }],
      imports: [],
      exports: [],
      debug: null,
      created_at: new Date(0).toISOString(),
    }],
    functions: [{
      id: "function_test",
      symbol_id: "symbol_test",
      module_id: "module_test",
      name: "FunctionOne",
      symbol_kind: "pdb-function",
      return_type: "void",
      calling_convention: "NTAPI",
      parameters_json: [],
      rva: "0x1000",
      size: 32,
      confidence: 1,
      has_pattern: false,
      is_exported: true,
      created_at: new Date(0).toISOString(),
    }, {
      id: "function_legacy_export",
      symbol_id: "symbol_legacy_export",
      module_id: "module_test",
      name: "LegacyExport",
      return_type: "PDB symbol",
      calling_convention: "PDB public",
      parameters_json: [],
      rva: "0x1008",
      size: 4,
      confidence: 0.84,
      has_pattern: false,
      is_exported: true,
      created_at: new Date(0).toISOString(),
    }, {
      id: "function_legacy_export_alias",
      symbol_id: "symbol_legacy_export_alias",
      module_id: "module_test",
      name: "NoisyLegacyAlias",
      return_type: "PDB symbol",
      calling_convention: "PDB public",
      parameters_json: [],
      rva: "0x1008",
      size: 4,
      confidence: 0.84,
      has_pattern: false,
      is_exported: true,
      created_at: new Date(0).toISOString(),
    }, {
      id: "function_public_symbol",
      symbol_id: "symbol_public_symbol",
      module_id: "module_test",
      name: "NoisyPublicSymbol",
      symbol_kind: "pdb-public",
      return_type: "PDB symbol",
      calling_convention: "PDB public",
      parameters_json: [],
      rva: "0x1004",
      size: 4,
      confidence: 0.84,
      has_pattern: false,
      is_exported: false,
      created_at: new Date(0).toISOString(),
    }, {
      id: "function_invalid_windows_11_x86",
      symbol_id: "symbol_invalid_windows_11_x86",
      module_id: "module_invalid_windows_11_x86",
      name: "HiddenFunction",
      return_type: "void",
      symbol_kind: "pdb-function",
      calling_convention: "NTAPI",
      parameters_json: [],
      rva: "0x1000",
      size: 32,
      confidence: 1,
      has_pattern: false,
      is_exported: false,
      created_at: new Date(0).toISOString(),
    }],
    types: [{
      id: "type_test",
      module_id: "module_test",
      name: "_TYPE",
      kind: "struct",
      size: 8,
      alignment: 8,
      reconstructed_c: "struct _TYPE { void* Value; };",
      hash: "hash",
      fields: [{ id: "field_test", type_id: "type_test", name: "Value", field_type_name: "void*", offset_bits: 0, size_bits: 64, flags_json: {} }],
      created_at: new Date(0).toISOString(),
    }, {
      id: "type_test_previous",
      module_id: "module_test_previous",
      name: "_TYPE",
      kind: "struct",
      size: 16,
      alignment: 8,
      reconstructed_c: "struct _TYPE { void* Value; uint64_t Count; };",
      hash: "hash-previous",
      fields: [
        { id: "field_test_previous_value", type_id: "type_test_previous", name: "Value", field_type_name: "void*", offset_bits: 0, size_bits: 64, flags_json: {} },
        { id: "field_test_previous_count", type_id: "type_test_previous", name: "Count", field_type_name: "uint64_t", offset_bits: 64, size_bits: 64, flags_json: {} },
      ],
      created_at: new Date(0).toISOString(),
    }, {
      id: "type_test_unrelated",
      module_id: "module_test_unrelated",
      name: "_TYPE",
      kind: "struct",
      size: 32,
      alignment: 8,
      reconstructed_c: "struct _TYPE { uint8_t Other[32]; };",
      hash: "hash-unrelated",
      fields: [{ id: "field_test_unrelated", type_id: "type_test_unrelated", name: "Other", field_type_name: "uint8_t[32]", offset_bits: 0, size_bits: 256, flags_json: {} }],
      created_at: new Date(0).toISOString(),
    }],
    patterns: [{
      id: "pattern_public_symbol",
      function_id: "function_public_symbol",
      module_id: "module_test",
      binary_sha256: "0".repeat(64),
      pattern: "90",
      mask: "x",
      format: "ida",
      length: 1,
      confidence: 1,
      collision_count: 0,
      tested_builds_json: ["build_test"],
      status: "excellent",
      created_at: new Date(0).toISOString(),
    }],
    pdb_lookups: [],
    ingestions: [],
    archive_files: [{
      id: "archive_file_test",
      relative_path: "Windows 11 24H2/System32/drivers/testdriver.sys",
      source_group: "Windows 11 24H2",
      identity_version: "test",
      identity_key: "test",
      group_fingerprint: "test",
      size: 8192,
      modified_at: new Date(0).toISOString(),
      fingerprint: "8192:0:0",
      status: "missing",
      message: "Indexed test driver.",
      build_id: "build_test",
      module_id: "module_test",
      module_name: "testdriver.sys",
      pdb_status: "missing",
      function_count: 1,
      type_count: 1,
      created_at: new Date(0).toISOString(),
      updated_at: new Date(0).toISOString(),
    }],
  };
  writeFileSync(join(cache_root, "index.json"), JSON.stringify(legacy_index), { flag: "w" });

  const [{ create_app }, { provision_admin }] = await Promise.all([
    import("../src/app"),
    import("../src/auth-store"),
  ]);
  await provision_admin("admin", temporary_password);
  server = await create_app();
});

after(async () => {
  await server?.close();
  rmSync(root, { force: true, recursive: true });
});

test("serves the database-backed catalog and indexed entities", async () => {
  const catalog = await server.inject({ method: "GET", url: "/api/v1/catalog" });
  assert.equal(catalog.statusCode, 200);
  assert.equal(catalog.json().data.builds.length, 3);
  assert.equal(catalog.json().data.stats.types, 3);
  assert.equal(catalog.json().data.stats.patterns, 0);

  const functions = await server.inject({ method: "GET", url: "/api/v1/modules/module_test/functions?page=1&limit=100" });
  assert.equal(functions.statusCode, 200);
  assert.equal(functions.json().pagination.total, 2);
  const public_symbols = await server.inject({ method: "GET", url: "/api/v1/modules/module_test/functions?page=1&limit=100&q=NoisyPublicSymbol" });
  assert.equal(public_symbols.statusCode, 200);
  assert.equal(public_symbols.json().pagination.total, 0);
  assert.deepEqual(public_symbols.json().data, []);
  const legacy_aliases = await server.inject({ method: "GET", url: "/api/v1/modules/module_test/functions?page=1&limit=100&q=NoisyLegacyAlias" });
  assert.equal(legacy_aliases.statusCode, 200);
  assert.equal(legacy_aliases.json().pagination.total, 0);
  assert.equal((await server.inject({ method: "GET", url: "/api/v1/functions/function_legacy_export" })).statusCode, 200);
  assert.equal((await server.inject({ method: "GET", url: "/api/v1/functions/function_legacy_export_alias" })).statusCode, 404);
  const public_symbol_pattern = await server.inject({
    method: "POST",
    url: "/api/v1/patterns/request",
    payload: { function_id: "function_public_symbol", binary_sha256: "0".repeat(64) },
  });
  assert.equal(public_symbol_pattern.statusCode, 404);


  const types = await server.inject({ method: "GET", url: "/api/v1/modules/module_test/types?page=1&limit=100" });
  assert.equal(types.statusCode, 200);
  assert.equal(types.json().pagination.total, 1);

  const generated_pattern = await server.inject({
    method: "POST",
    url: "/api/v1/patterns/request",
    payload: { function_id: "function_test", binary_sha256: "0".repeat(64) },
  });
  assert.equal(generated_pattern.statusCode, 200);
  assert.equal(generated_pattern.json().meta.source, "local-binary");

  const cached_pattern = await server.inject({
    method: "POST",
    url: "/api/v1/patterns/request",
    payload: { function_id: "function_test", binary_sha256: "0".repeat(64) },
  });
  assert.equal(cached_pattern.statusCode, 200);
  assert.equal(cached_pattern.json().meta.source, "pattern-cache");

  const pattern_xrefs = await server.inject({ method: "GET", url: "/api/v1/functions/function_test/pattern/xrefs" });
  assert.equal(pattern_xrefs.statusCode, 200);
  assert.equal(pattern_xrefs.json().data.rows.length, 3);

  const modules = await server.inject({ method: "GET", url: "/api/v1/builds/build_test/modules?page=1&limit=100" });
  assert.equal(modules.statusCode, 200);
  assert.equal(modules.json().data[0].binary_available, true);
  assert.equal("source_path" in modules.json().data[0], false);
  assert.equal(modules.headers["x-kernelarchive-cache"], "MISS");
  const cached_modules = await server.inject({ method: "GET", url: "/api/v1/builds/build_test/modules?page=1&limit=100" });
  assert.equal(cached_modules.headers["x-kernelarchive-cache"], "HIT");
  const filtered_modules = await server.inject({ method: "GET", url: "/api/v1/builds/build_test/modules?page=1&limit=100&q=kernel.pdb" });
  assert.equal(filtered_modules.json().pagination.total, 1);
  const missing_modules = await server.inject({ method: "GET", url: "/api/v1/builds/build_test/modules?page=1&limit=100&q=missing-driver" });
  assert.equal(missing_modules.json().pagination.total, 0);


  const module_detail = await server.inject({ method: "GET", url: "/api/v1/modules/module_test" });
  assert.equal(module_detail.statusCode, 200);
  assert.equal("source_path" in module_detail.json().data, false);
  assert.equal(module_detail.json().data.function_count, 2);

  const module_download = await server.inject({ method: "GET", url: "/api/v1/modules/module_test/download" });
  assert.equal(module_download.statusCode, 200);
  assert.equal(module_download.headers["content-type"], "application/octet-stream");
  assert.match(String(module_download.headers["content-disposition"]), /filename="kernel\.exe"/);
  assert.equal(module_download.headers["content-length"], "8192");
  assert.equal(module_download.rawPayload.length, 8192);
  assert.equal(module_download.rawPayload[0], 0x90);

  assert.equal((await server.inject({ method: "GET", url: "/api/v1/builds/build_invalid_windows_11_x86" })).statusCode, 404);
  assert.equal((await server.inject({ method: "GET", url: "/api/v1/modules/module_invalid_windows_11_x86" })).statusCode, 404);
  assert.equal((await server.inject({ method: "GET", url: "/api/v1/modules/module_invalid_windows_11_x86/download" })).statusCode, 404);
  assert.equal((await server.inject({ method: "GET", url: "/api/v1/functions/function_invalid_windows_11_x86" })).statusCode, 404);
  assert.equal((await server.inject({ method: "GET", url: "/api/v1/functions/function_public_symbol" })).statusCode, 404);
  assert.equal((await server.inject({ method: "GET", url: "/api/v1/functions/function_public_symbol/context" })).statusCode, 404);
  assert.equal((await server.inject({ method: "GET", url: "/api/v1/functions/function_public_symbol/pattern" })).statusCode, 404);
  assert.equal((await server.inject({ method: "GET", url: "/api/v1/functions/function_public_symbol/pattern/xrefs" })).statusCode, 404);
  assert.equal((await server.inject({ method: "GET", url: "/api/v1/patterns/pattern_public_symbol" })).statusCode, 404);

  const module_context = await server.inject({ method: "GET", url: "/api/v1/modules/module_test/context" });
  assert.equal(module_context.statusCode, 200);
  assert.equal(module_context.json().data.pdb.status, "missing");
  assert.equal(module_context.json().data.pdb.available, false);
  assert.equal(module_context.json().data.pdb.checking, false);
  assert.equal(module_context.json().data.pdb.can_retry, false);
  assert.equal(module_context.json().data.pdb.provider, "Microsoft Symbol Server");

  const module_pdb = await server.inject({ method: "GET", url: "/api/v1/modules/module_test/pdb" });
  assert.equal(module_pdb.statusCode, 200);
  assert.equal(module_pdb.json().data.status, "missing");

  const type_xrefs = await server.inject({ method: "GET", url: "/api/v1/types/type_test/xrefs" });
  assert.equal(type_xrefs.statusCode, 200);
  assert.deepEqual(type_xrefs.json().data.occurrences.map((occurrence: { build_id: string }) => occurrence.build_id), ["build_test_previous", "build_test"]);
  assert.deepEqual(type_xrefs.json().data.occurrences.map((occurrence: { module_name: string }) => occurrence.module_name), ["kernel.exe", "kernel.exe"]);
  assert.equal(type_xrefs.json().data.steps.length, 1);
  assert.equal(type_xrefs.json().data.steps[0].from.type_id, "type_test_previous");
  assert.equal(type_xrefs.json().data.steps[0].to.type_id, "type_test");
  assert.equal(type_xrefs.json().data.steps[0].additions, 0);
  assert.equal(type_xrefs.json().data.steps[0].removals, 1);
  assert.equal(type_xrefs.json().data.steps[0].modifications, 1);
  assert.equal(type_xrefs.json().data.occurrences.some((occurrence: { type_id: string }) => occurrence.type_id === "type_test_unrelated"), false);

  const reference_counts = await server.inject({ method: "GET", url: "/api/v1/types/type_test/references" });
  assert.equal(reference_counts.statusCode, 200);
  assert.deepEqual(reference_counts.json().data, { fields: 0, functions: 0 });
  const field_references = await server.inject({ method: "GET", url: "/api/v1/types/type_test/references/fields?page=1&limit=50" });
  assert.equal(field_references.statusCode, 200);
  assert.equal(field_references.json().pagination.total, 0);
  assert.equal(field_references.json().meta.source, "archive-reference-index");
  const function_references = await server.inject({ method: "GET", url: "/api/v1/types/type_test/references/functions?page=1&limit=50" });
  assert.equal(function_references.statusCode, 200);
  assert.equal(function_references.json().pagination.total, 0);
  assert.equal(function_references.json().meta.source, "archive-reference-index");

  const search = await server.inject({ method: "GET", url: "/api/v1/search?q=Function&kind=function&page=1&limit=20" });
  assert.equal(search.statusCode, 200);
  assert.equal(search.json().pagination.total, 1);
  assert.equal(search.json().data[0].id, "function_test");
  const public_search = await server.inject({ method: "GET", url: "/api/v1/search?q=NoisyPublicSymbol&kind=function&page=1&limit=20" });
  assert.equal(public_search.statusCode, 200);
  assert.equal(public_search.json().pagination.total, 0);
  assert.deepEqual(public_search.json().data, []);
});

test("enforces temporary password rotation, trusted origins, and session revocation", async () => {
  const unauthorized_upload = await server.inject({
    method: "POST",
    url: "/api/v1/admin/uploads/binary",
    headers: { origin: "http://localhost:3003", "content-type": "application/octet-stream" },
    payload: Buffer.from("MZ"),
  });
  assert.equal(unauthorized_upload.statusCode, 401);

  const unauthorized_pdb_retry = await server.inject({
    method: "POST",
    url: "/api/v1/admin/modules/module_test/pdb/retry",
    headers: { origin: "http://localhost:3003" },
  });
  assert.equal(unauthorized_pdb_retry.statusCode, 401);

  const invalid = await server.inject({
    method: "POST",
    url: "/api/v1/auth/login",
    headers: { origin: "http://localhost:3003" },
    payload: { username: "admin", password: "not-the-password" },
  });
  assert.equal(invalid.statusCode, 401);

  const login = await server.inject({
    method: "POST",
    url: "/api/v1/auth/login",
    headers: { origin: "http://localhost:3003" },
    payload: { username: "admin", password: temporary_password },
  });
  assert.equal(login.statusCode, 200);
  assert.equal(login.json().data.user.must_change_password, true);
  const temporary_cookie = session_cookie(login.headers["set-cookie"]);

  const blocked = await server.inject({ method: "GET", url: "/api/v1/admin/ingestions", headers: { cookie: temporary_cookie } });
  assert.equal(blocked.statusCode, 403);
  assert.equal(blocked.json().error.code, "PASSWORD_CHANGE_REQUIRED");

  const rejected_origin = await server.inject({
    method: "POST",
    url: "/api/v1/auth/change-password",
    headers: { cookie: temporary_cookie, origin: "https://example.invalid" },
    payload: { current_password: temporary_password, new_password: permanent_password },
  });
  assert.equal(rejected_origin.statusCode, 403);

  const changed = await server.inject({
    method: "POST",
    url: "/api/v1/auth/change-password",
    headers: { cookie: temporary_cookie, origin: "http://localhost:3003" },
    payload: { current_password: temporary_password, new_password: permanent_password },
  });
  assert.equal(changed.statusCode, 200);
  assert.equal(changed.json().data.user.must_change_password, false);
  const permanent_cookie = session_cookie(changed.headers["set-cookie"]);

  const admin = await server.inject({ method: "GET", url: "/api/v1/admin/ingestions", headers: { cookie: permanent_cookie } });
  assert.equal(admin.statusCode, 200);

  const archive_files = await server.inject({ method: "GET", url: "/api/v1/admin/archive/files?page=1&limit=25&q=testdriver", headers: { cookie: permanent_cookie } });
  assert.equal(archive_files.statusCode, 200);
  assert.equal(archive_files.json().pagination.total, 1);
  assert.equal(archive_files.json().data[0].module_name, "testdriver.sys");

  const missing_source_retry = await server.inject({
    method: "POST",
    url: "/api/v1/admin/archive/files/archive_file_test/pdb/retry",
    headers: { cookie: permanent_cookie, origin: "http://localhost:3003" },
  });
  assert.equal(missing_source_retry.statusCode, 409);
  assert.equal(missing_source_retry.json().error.code, "SOURCE_MISSING");

  const missing_module_source_retry = await server.inject({
    method: "POST",
    url: "/api/v1/admin/modules/module_test/pdb/retry",
    headers: { cookie: permanent_cookie, origin: "http://localhost:3003" },
  });
  assert.equal(missing_module_source_retry.statusCode, 409);
  assert.equal(missing_module_source_retry.json().error.code, "SOURCE_MISSING");
  assert.match(admin.json().data.database.path, /archive\.sqlite$/);

  const audit = await server.inject({ method: "GET", url: "/api/v1/admin/audit-logs?page=1&limit=100", headers: { cookie: permanent_cookie } });
  assert.equal(audit.statusCode, 200);
  assert.ok(audit.json().data.some((event: { action: string; success: boolean }) => event.action === "auth.password_changed" && event.success));

  const logout = await server.inject({
    method: "POST",
    url: "/api/v1/auth/logout",
    headers: { cookie: permanent_cookie, origin: "http://localhost:3003" },
  });
  assert.equal(logout.statusCode, 200);
  const revoked = await server.inject({ method: "GET", url: "/api/v1/auth/session", headers: { cookie: permanent_cookie } });
  assert.equal(revoked.statusCode, 401);
});
