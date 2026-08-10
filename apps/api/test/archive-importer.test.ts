import assert from "node:assert/strict";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test, { after, before } from "node:test";
import { is_supported_kernel_build, type ArchiveScanStatus, type WindowsBuild } from "@kernelarchive/shared";

const root = mkdtempSync(join(tmpdir(), "kernelarchive-importer-"));
const cache_root = join(root, "cache");
const archive_root = join(root, "Archive");
const nested_root = join(archive_root, "Windows Test", "System32");
const source_binary = resolve(process.cwd(), "..", "..", "tools", "pdb-dump", "pdb_dump.exe");
const archive_binary = join(nested_root, "dynamic-name.exe");
let importer: typeof import("../src/archive-importer");
let cache: typeof import("../src/ingestion-cache");
let first_scan: ArchiveScanStatus;

async function wait_for_scan(previous_scan_id?: string) {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    const current = importer.archive_scan_status();
    if (current.state === "failed") {
      throw new Error(current.last_error ?? "Archive scan failed");
    }
    if (current.state === "completed" && (!previous_scan_id || current.scan_id !== previous_scan_id)) {
      return current;
    }
    await delay(100);
  }
  throw new Error("Timed out waiting for Archive scan");
}

before(async () => {
  mkdirSync(cache_root, { recursive: true });
  mkdirSync(nested_root, { recursive: true });
  copyFileSync(source_binary, archive_binary);

  process.env.KERNELARCHIVE_LOCAL_CACHE_DIR = cache_root;
  process.env.KERNELARCHIVE_DATA_DB_PATH = join(cache_root, "archive.sqlite");
  process.env.KERNELARCHIVE_AUTH_DB_PATH = join(cache_root, "auth.sqlite");
  process.env.KERNELARCHIVE_ARCHIVE_DIR = archive_root;
  process.env.KERNELARCHIVE_ARCHIVE_IMPORT_CONCURRENCY = "1";
  process.env.KERNELARCHIVE_ARCHIVE_SCAN_INTERVAL_MS = "60000";
  process.env.KERNELARCHIVE_SYMBOL_SERVER_URLS = "http://127.0.0.1:9";
  process.env.KERNELARCHIVE_PDB_DUMP_PATH = source_binary;
  process.env.KERNELARCHIVE_DIA_DLL_PATH = join(root, "missing-msdia.dll");
  process.env.PDB_DOWNLOAD_TIMEOUT_MS = "1000";
  process.env.PDB_FAILURE_CACHE_MINUTES = "1";
  process.env.PUBLIC_APP_URL = "http://localhost:3003";

  [importer, cache] = await Promise.all([
    import("../src/archive-importer"),
    import("../src/ingestion-cache"),
  ]);
  importer.start_archive_importer();
  first_scan = await wait_for_scan();
});

after(async () => {
  await importer.stop_archive_importer();
  cache.close_local_cache();
  rmSync(root, { force: true, recursive: true });
});


test("canonicalizes Windows enablement-package release folders", () => {
  assert.equal(importer.canonical_archive_build("Windows 10 20H2", 19041), 19042);
  assert.equal(importer.canonical_archive_build("Windows 10 21H1", 19041), 19043);
  assert.equal(importer.canonical_archive_build("Windows 10 21H2", 19041), 19044);
  assert.equal(importer.canonical_archive_build("Windows 10 22H2", 19041), 19045);
  assert.equal(importer.canonical_archive_build("Windows 10 1909", 18362), 18363);
  assert.equal(importer.canonical_archive_build("Windows 11 23H2", 22621), 22631);
  assert.equal(importer.canonical_archive_build("Windows 11 25H2", 26100), 26200);
  assert.equal(importer.canonical_archive_build("Unlabeled folder", 26100), 26100);
});

test("separates archive build architecture from compatibility binary architecture", () => {
  assert.equal(importer.archive_group_architecture("Windows 11 24H2", ["x86", "x86"]), "x64");
  assert.equal(importer.archive_group_architecture("Windows 11 24H2 ARM64", ["x86"]), "arm64");
  assert.equal(importer.archive_group_architecture("Windows 10 22H2 x86", ["x64"]), "x86");
  assert.equal(importer.archive_group_architecture("Windows 10 22H2", ["x86"]), "x64");
  assert.equal(importer.archive_group_architecture("Unlabeled archive", ["x64", "x64", "x86"]), "x64");
});

test("rejects x86 records classified as Windows 11 builds", () => {
  const build: WindowsBuild = {
    id: "build_windows_11_x86",
    product_name: "Windows 11",
    version: "24H2",
    build_number: "26100",
    revision: "1",
    architecture: "x86",
    release_channel: "test",
    published: true,
    created_at: new Date(0).toISOString(),
  };
  assert.equal(is_supported_kernel_build(build), false);
  assert.equal(is_supported_kernel_build({ ...build, architecture: "x64" }), true);
  assert.equal(is_supported_kernel_build({ ...build, product_name: "Windows 10", build_number: "19045" }), true);
});

test("recursively indexes Portable Executables from the Archive folder", () => {
  const records = cache.all_archive_files();
  assert.equal(first_scan.discovered_files, 1);
  assert.equal(first_scan.portable_executables, 1);
  assert.equal(first_scan.indexed_files, 1, JSON.stringify(records));
  assert.equal(first_scan.failed_files, 0);
  assert.equal(records.length, 1);
  assert.equal(records[0]?.relative_path, "Windows Test/System32/dynamic-name.exe");
  assert.equal(records[0]?.source_group, "Windows Test");
  assert.equal(records[0]?.module_name, basename(archive_binary));
  assert.equal(records[0]?.status, "indexed");
});

test("skips unchanged Archive files without reading or indexing them again", async () => {
  const previous_scan_id = importer.archive_scan_status().scan_id;
  importer.request_archive_scan("interval");
  const second_scan = await wait_for_scan(previous_scan_id);
  assert.equal(second_scan.processed_files, 0);
  assert.equal(second_scan.unchanged_files, 1);
  assert.equal(second_scan.indexed_files, 0);
  assert.equal(second_scan.cached_files, 0);
});
