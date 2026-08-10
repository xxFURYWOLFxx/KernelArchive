import { createHash } from "node:crypto";
import { mkdirSync, watch, type FSWatcher, type Stats } from "node:fs";
import { open, readFile, readdir, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { windows_product_label, windows_release_label } from "@kernelarchive/shared";
import type { Architecture, ArchiveFileRecord, ArchiveScanReason, ArchiveScanStatus, WindowsBuild } from "@kernelarchive/shared";
import { env } from "./env";
import { cache_archive_records, ingest_archive_binary, stop_archive_ingest_pool } from "./archive-ingest-pool";
import { all_archive_files, find_build_record_any, stale_parser_sha_set, type IngestOptions } from "./ingestion-cache";
import { parse_pe } from "./pe";

interface ProcessOutcome {
  record: ArchiveFileRecord;
  outcome: "unchanged" | "indexed" | "cached" | "skipped" | "failed" | "pending";
  portable_executable: boolean;
}

interface DiscoveredArchiveFile {
  path: string;
  relative_path: string;
  source_group: string;
  file_stat: Stats;
}

interface ArchiveIdentity {
  options: IngestOptions;
  key: string;
  group_fingerprint: string;
}

interface BuildCandidate {
  build: number;
  revision: number;
  architecture: Architecture;
}

const repo_root = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const root_path = isAbsolute(env.KERNELARCHIVE_ARCHIVE_DIR)
  ? env.KERNELARCHIVE_ARCHIVE_DIR
  : join(repo_root, env.KERNELARCHIVE_ARCHIVE_DIR);
const flush_batch_size = 25;
const flush_interval_ms = 5000;
const scan_yield_interval = 64;
const startup_scan_delay_ms = 1000;
const scan_cooldown_ms = 5000;
const scan_cooldown_max_ms = 300000;
const archive_identity_version = "folder-consensus-v2";
const identity_sample_limit = 48;
const identity_sample_max_bytes = Math.min(env.UPLOAD_MAX_BYTES, 32 * 1024 * 1024);
let watcher: FSWatcher | undefined;
let interval: ReturnType<typeof setInterval> | undefined;
let debounce: ReturnType<typeof setTimeout> | undefined;
let startup_scan: ReturnType<typeof setTimeout> | undefined;
let scan_inflight: Promise<void> | undefined;
let queued_reason: ArchiveScanReason | undefined;
let rescan_timer: ReturnType<typeof setTimeout> | undefined;
let consecutive_failures = 0;
let started = false;
let stopping = false;
const pdb_retry_inflight = new Map<string, Promise<void>>();
let status: ArchiveScanStatus = {
  state: "idle",
  root: root_path,
  watching: false,
  queued: false,
  discovered_files: 0,
  portable_executables: 0,
  processed_files: 0,
  unchanged_files: 0,
  indexed_files: 0,
  cached_files: 0,
  skipped_files: 0,
  failed_files: 0,
};

function error_message(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function yield_to_event_loop() {
  return new Promise<void>((resolve) => setImmediate(resolve));
}

function archive_relative_path(path: string) {
  return relative(root_path, path).replace(/\\/g, "/");
}

function archive_file_id(relative_path: string) {
  const digest = createHash("sha256").update(relative_path.toLowerCase()).digest("hex").slice(0, 24);
  return "archive_file_" + digest;
}

function source_group(relative_path: string) {
  return relative_path.split("/").filter(Boolean)[0] ?? "Archive";
}

const architecture_order: Record<Architecture, number> = {
  x64: 0,
  arm64: 1,
  x86: 2,
};

export function archive_group_architecture(source_group_name: string, candidates: Architecture[]) {
  if (/\b(?:arm64|aarch64)\b/i.test(source_group_name)) { return "arm64"; }
  if (/\b(?:x64|amd64|64[-\s]?bit)\b/i.test(source_group_name)) { return "x64"; }
  if (/\b(?:x86|i[3-6]86|32[-\s]?bit)\b/i.test(source_group_name)) { return "x86"; }
  if (/\bwindows\s+(?:10|11)\b/i.test(source_group_name)) { return "x64"; }

  const counts = new Map<Architecture, number>();
  for (const architecture of candidates) {
    counts.set(architecture, (counts.get(architecture) ?? 0) + 1);
  }
  return Array.from(counts.entries()).sort((left, right) =>
    right[1] - left[1] ||
    architecture_order[left[0]] - architecture_order[right[0]])[0]?.[0];
}

export function canonical_archive_build(source_group_name: string, detected_build: number) {
  const product_match = source_group_name.match(/\bwindows\s+(10|11)\b/i);
  const release_match = source_group_name.match(/\b(?:\d{2}h\d|\d{4})\b/i);
  if (!product_match?.[1] || !release_match?.[0]) { return detected_build; }

  const product_name = "Windows " + product_match[1];
  const release = release_match[0].toUpperCase();
  const first_candidate = Math.max(10240, detected_build);
  const last_candidate = Math.min(30000, detected_build + 2000);
  for (let candidate = first_candidate; candidate <= last_candidate; candidate += 1) {
    const identity: WindowsBuild = {
      id: "",
      product_name,
      version: release,
      build_number: String(candidate),
      revision: "0",
      architecture: "x64",
      release_channel: "archive",
      published: true,
      created_at: "",
    };
    if (windows_product_label(identity) === product_name && windows_release_label(identity) === release) {
      return candidate;
    }
  }
  return detected_build;
}

function file_fingerprint(file_stat: Stats) {
  return [file_stat.size, file_stat.mtimeMs.toFixed(3), file_stat.ctimeMs.toFixed(3)].join(":");
}

function record_base(relative_path: string, file_stat: Stats | undefined, existing: ArchiveFileRecord | undefined, identity: ArchiveIdentity) {
  const now = new Date().toISOString();
  return {
    id: archive_file_id(relative_path),
    relative_path,
    source_group: source_group(relative_path),
    identity_version: archive_identity_version,
    identity_key: identity.key,
    group_fingerprint: identity.group_fingerprint,
    size: file_stat?.size ?? existing?.size ?? 0,
    modified_at: file_stat?.mtime.toISOString() ?? existing?.modified_at ?? now,
    fingerprint: file_stat ? file_fingerprint(file_stat) : existing?.fingerprint ?? "",
    created_at: existing?.created_at ?? now,
    updated_at: now,
  };
}

function pdb_retryable(record: ArchiveFileRecord) {
  return record.pdb_status === "download-failed" || record.pdb_status === "missing";
}

function pdb_retry_due(record: ArchiveFileRecord) {
  if (!pdb_retryable(record)) { return false; }
  const updated_at = Date.parse(record.updated_at);
  if (!Number.isFinite(updated_at)) { return true; }
  return Date.now() - updated_at >= env.PDB_FAILURE_CACHE_MINUTES * 60 * 1000;
}

function unchanged_record(record: ArchiveFileRecord, fingerprint: string, identity: ArchiveIdentity, reason: ArchiveScanReason, stale_parser: Set<string>) {
  if (record.fingerprint !== fingerprint) { return false; }
  if (record.status === "indexed" || record.status === "cached") {
    if (record.sha256 && stale_parser.has(record.sha256)) { return false; }
    return !pdb_retry_due(record) && !(reason === "manual" && pdb_retryable(record));
  }
  if (record.identity_version !== archive_identity_version) { return false; }
  if (record.identity_key !== identity.key || record.group_fingerprint !== identity.group_fingerprint) { return false; }
  if (record.status === "skipped") { return true; }
  if (record.status !== "failed") { return false; }
  if (reason === "manual") { return false; }
  const failed_at = Date.parse(record.updated_at);
  if (!Number.isFinite(failed_at)) { return false; }
  return Date.now() - failed_at < env.PDB_FAILURE_CACHE_MINUTES * 60 * 1000;
}

async function portable_executable(path: string, size: number) {
  if (size < 64) { return false; }
  const handle = await open(path, "r");
  try {
    const dos_header = Buffer.alloc(64);
    const dos_read = await handle.read(dos_header, 0, dos_header.length, 0);
    if (dos_read.bytesRead !== dos_header.length || dos_header[0] !== 0x4d || dos_header[1] !== 0x5a) { return false; }
    const pe_offset = dos_header.readUInt32LE(0x3c);
    if (pe_offset < 64 || pe_offset + 4 > size) { return false; }
    const signature = Buffer.alloc(4);
    const pe_read = await handle.read(signature, 0, signature.length, pe_offset);
    return pe_read.bytesRead === signature.length && signature.equals(Buffer.from([0x50, 0x45, 0x00, 0x00]));
  } finally {
    await handle.close();
  }
}

function archive_source_path(relative_path: string) {
  const source = resolve(root_path, relative_path);
  const source_relative = relative(root_path, source);
  if (!source_relative || source_relative === ".." || source_relative.startsWith(`..${sep}`) || isAbsolute(source_relative)) {
    throw new Error("Archive source path is outside the configured Archive folder.");
  }
  return source;
}

function pdb_refresh_message(status_value: ArchiveFileRecord["pdb_status"]) {
  if (status_value === "missing") { return "PDB was not found; PE exports and metadata remain cached."; }
  if (status_value === "download-failed") { return "PDB lookup failed; PE exports and metadata remain cached."; }
  if (status_value === "no-debug-info") { return "No CodeView PDB record is present; PE exports and metadata remain cached."; }
  return "PDB, functions, and types were refreshed in the persistent cache.";
}

async function retry_archive_pdb(record: ArchiveFileRecord) {
  const pending: ArchiveFileRecord = {
    ...record,
    status: "pending",
    message: "Refreshing PDB and cached symbols.",
    updated_at: new Date().toISOString(),
  };
  await cache_archive_records([pending], true);

  try {
    const source = archive_source_path(record.relative_path);
    const file_stat = await stat(source);
    if (!file_stat.isFile()) { throw new Error("Archive source is not a file."); }
    if (file_stat.size > env.UPLOAD_MAX_BYTES) { throw new Error("Portable Executable exceeds the configured ingestion size limit."); }
    if (!(await portable_executable(source, file_stat.size))) { throw new Error("Archive source is not a Portable Executable file."); }
    const build = record.build_id ? find_build_record_any(record.build_id) : undefined;
    if (!build) { throw new Error("Indexed build metadata is unavailable for this archive file."); }
    const fingerprint = file_fingerprint(file_stat);
    const data = await readFile(source);
    const after_read = await stat(source);
    if (file_fingerprint(after_read) !== fingerprint) { throw new Error("Archive source changed while it was being read."); }
    const result = await ingest_archive_binary(basename(source), data, {
      product_name: build.product_name,
      version: build.version,
      build_number: build.build_number,
      revision: build.revision,
      architecture: archive_group_architecture(record.source_group, [build.architecture]) ?? build.architecture,
      force_pdb_retry: true,
    }, true);
    const updated: ArchiveFileRecord = {
      ...record,
      size: after_read.size,
      modified_at: after_read.mtime.toISOString(),
      fingerprint: file_fingerprint(after_read),
      status: result.cache_hit ? "cached" : "indexed",
      message: pdb_refresh_message(result.pdb_status),
      sha256: result.sha256,
      ingestion_id: result.ingestion_id,
      build_id: result.build_id,
      module_id: result.module_id,
      module_name: result.module_name,
      pdb_status: result.pdb_status,
      function_count: result.function_count,
      type_count: result.type_count,
      updated_at: new Date().toISOString(),
    };
    await cache_archive_records([updated], true);
  } catch (error) {
    await cache_archive_records([{
      ...record,
      status: "failed",
      message: error_message(error),
      updated_at: new Date().toISOString(),
    }], true);
    throw error;
  }
}

async function discover_files() {
  const files: DiscoveredArchiveFile[] = [];
  const directories = [root_path];
  let discovery_failures = 0;
  while (directories.length > 0) {
    const directory = directories.pop();
    if (!directory) { continue; }
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        directories.push(path);
      } else if (entry.isFile()) {
        try {
          const file_stat = await stat(path);
          const relative_path = archive_relative_path(path);
          files.push({
            path,
            relative_path,
            source_group: source_group(relative_path),
            file_stat,
          });
        } catch {
          discovery_failures += 1;
        }
      }
    }
  }
  if (discovery_failures > 0) {
    status = { ...status, last_error: `${discovery_failures} archive files could not be read during discovery.` };
  }
  files.sort((left, right) => {
    const depth = left.relative_path.split("/").length - right.relative_path.split("/").length;
    return depth || left.relative_path.localeCompare(right.relative_path);
  });
  const groups = new Map<string, DiscoveredArchiveFile[]>();
  for (const file of files) {
    const group = groups.get(file.source_group) ?? [];
    group.push(file);
    groups.set(file.source_group, group);
  }
  const queues = Array.from(groups.entries())
    .sort((left, right) => left[0].localeCompare(right[0]))
    .map((entry) => entry[1]);
  const ordered: DiscoveredArchiveFile[] = [];
  const longest_queue = Math.max(0, ...queues.map((queue) => queue.length));
  for (let index = 0; index < longest_queue; index += 1) {
    for (const queue of queues) {
      const file = queue[index];
      if (file) { ordered.push(file); }
    }
  }
  return ordered;
}

function fingerprint_group(files: DiscoveredArchiveFile[]) {
  const hash = createHash("sha256");
  for (const file of files.slice().sort((left, right) => left.relative_path.localeCompare(right.relative_path))) {
    hash.update(file.relative_path.toLowerCase());
    hash.update("\0");
    hash.update(file_fingerprint(file.file_stat));
    hash.update("\0");
  }
  return hash.digest("hex");
}

function cached_group_identity(group: string, group_fingerprint: string, records: ArchiveFileRecord[]) {
  const cached = records.find((record) =>
    record.source_group === group &&
    record.identity_version === archive_identity_version &&
    record.group_fingerprint === group_fingerprint &&
    record.identity_key.startsWith(archive_identity_version + ":") &&
    Boolean(record.build_id));
  const build = cached?.build_id ? find_build_record_any(cached.build_id) : undefined;
  if (!build) { return undefined; }
  return {
    options: {
      product_name: build.product_name,
      version: build.version,
      build_number: build.build_number,
      revision: build.revision,
      architecture: archive_group_architecture(group, [build.architecture]) ?? build.architecture,
    },
    key: archive_identity_version + ":" + build.build_number + "." + build.revision,
    group_fingerprint,
  } satisfies ArchiveIdentity;
}

async function infer_group_identity(group: string, files: DiscoveredArchiveFile[], records: ArchiveFileRecord[]) {
  const group_fingerprint = fingerprint_group(files);
  const cached = cached_group_identity(group, group_fingerprint, records);
  if (cached) { return cached; }

  const candidates: BuildCandidate[] = [];
  let inspected = 0;
  for (const file of files) {
    if (inspected >= identity_sample_limit) { break; }
    if (file.file_stat.size > identity_sample_max_bytes) { continue; }
    try {
      if (!await portable_executable(file.path, file.file_stat.size)) { continue; }
      inspected += 1;
      const parsed = parse_pe(await readFile(file.path));
      await yield_to_event_loop();
      const version = parsed.version;
      if (!version || version.major < 6 || version.build < 7600 || version.build > 99999) { continue; }
      candidates.push({ build: version.build, revision: version.revision, architecture: parsed.architecture });
    } catch {
      continue;
    }
  }

  const consensus = new Map<number, { count: number; revision: number }>();
  for (const candidate of candidates) {
    const current = consensus.get(candidate.build) ?? { count: 0, revision: 0 };
    consensus.set(candidate.build, {
      count: current.count + 1,
      revision: Math.max(current.revision, candidate.revision),
    });
  }
  const selected = Array.from(consensus.entries()).sort((left, right) =>
    right[1].count - left[1].count ||
    right[0] - left[0] ||
    right[1].revision - left[1].revision)[0];
  if (!selected) {
    const architecture = archive_group_architecture(group, []);
    return {
      options: architecture ? { architecture } : {},
      key: "file-metadata-v1",
      group_fingerprint,
    } satisfies ArchiveIdentity;
  }

  const [build, details] = selected;
  const canonical_build = canonical_archive_build(group, build);
  const architecture = archive_group_architecture(
    group,
    candidates.filter((candidate) => candidate.build === build).map((candidate) => candidate.architecture),
  );
  return {
    options: {
      build_number: String(canonical_build),
      revision: String(details.revision),
      ...(architecture ? { architecture } : {}),
    },
    key: archive_identity_version + ":" + canonical_build + "." + details.revision,
    group_fingerprint,
  } satisfies ArchiveIdentity;
}

async function infer_archive_identities(files: DiscoveredArchiveFile[], records: ArchiveFileRecord[]) {
  const groups = new Map<string, DiscoveredArchiveFile[]>();
  for (const file of files) {
    const group = groups.get(file.source_group) ?? [];
    group.push(file);
    groups.set(file.source_group, group);
  }
  const identities = new Map<string, ArchiveIdentity>();
  for (const [group, group_files] of Array.from(groups.entries()).sort((left, right) => left[0].localeCompare(right[0]))) {
    status = { ...status, current_file: "Detecting build metadata for " + group };
    identities.set(group, await infer_group_identity(group, group_files, records));
    await yield_to_event_loop();
  }
  return identities;
}

async function process_file(file: DiscoveredArchiveFile, existing: ArchiveFileRecord | undefined, identity: ArchiveIdentity, reason: ArchiveScanReason, stale_parser: Set<string>): Promise<ProcessOutcome> {
  const { path, relative_path } = file;
  const file_stat = file.file_stat;
  try {
    if (existing && pdb_retry_inflight.has(existing.id)) {
      return {
        record: existing,
        outcome: "unchanged",
        portable_executable: true,
      };
    }
    const fingerprint = file_fingerprint(file_stat);
    if (existing && unchanged_record(existing, fingerprint, identity, reason, stale_parser)) {
      return {
        record: existing,
        outcome: "unchanged",
        portable_executable: existing.status !== "skipped",
      };
    }

    const is_pe = await portable_executable(path, file_stat.size);
    if (!is_pe) {
      return {
        record: {
          ...record_base(relative_path, file_stat, existing, identity),
          status: "skipped",
          message: "Not a Portable Executable file.",
        },
        outcome: "skipped",
        portable_executable: false,
      };
    }

    if (file_stat.size > env.UPLOAD_MAX_BYTES) {
      return {
        record: {
          ...record_base(relative_path, file_stat, existing, identity),
          status: "skipped",
          message: "Portable Executable exceeds the configured ingestion size limit.",
        },
        outcome: "skipped",
        portable_executable: true,
      };
    }

    const data = await readFile(path);
    const after_read = await stat(path);
    if (file_fingerprint(after_read) !== fingerprint) {
      queue_reason("watch");
      return {
        record: {
          ...record_base(relative_path, after_read, existing, identity),
          status: "pending",
          message: "File changed while it was being read and will be retried.",
        },
        outcome: "pending",
        portable_executable: true,
      };
    }

    const force_pdb_retry = Boolean(existing && pdb_retryable(existing) && (reason === "manual" || pdb_retry_due(existing)));
    const result = await ingest_archive_binary(basename(path), data, { ...identity.options, force_pdb_retry });
    const cache_hit = result.cache_hit;
    return {
      record: {
        ...record_base(relative_path, after_read, existing, identity),
        status: cache_hit ? "cached" : "indexed",
        message: cache_hit ? "Loaded from the persistent archive cache." : "Indexed into the persistent archive database.",
        sha256: result.sha256,
        ingestion_id: result.ingestion_id,
        build_id: result.build_id,
        module_id: result.module_id,
        module_name: result.module_name,
        pdb_status: result.pdb_status,
        function_count: result.function_count,
        type_count: result.type_count,
      },
      outcome: cache_hit ? "cached" : "indexed",
      portable_executable: true,
    };
  } catch (error) {
    return {
      record: {
        ...record_base(relative_path, file_stat, existing, identity),
        status: "failed",
        message: error_message(error),
      },
      outcome: "failed",
      portable_executable: Boolean(file_stat),
    };
  }
}

function update_counters(outcome: ProcessOutcome) {
  const next = { ...status };
  if (outcome.portable_executable) { next.portable_executables += 1; }
  if (outcome.outcome === "unchanged") {
    next.unchanged_files += 1;
  } else {
    next.processed_files += 1;
  }
  if (outcome.outcome === "indexed") { next.indexed_files += 1; }
  if (outcome.outcome === "cached") { next.cached_files += 1; }
  if (outcome.outcome === "skipped") { next.skipped_files += 1; }
  if (outcome.outcome === "failed") { next.failed_files += 1; }
  status = next;
}

async function run_scan(reason: ArchiveScanReason) {
  const started_at = new Date().toISOString();
  status = {
    state: "scanning",
    reason,
    root: root_path,
    watching: Boolean(watcher),
    queued: false,
    scan_id: crypto.randomUUID(),
    started_at,
    discovered_files: 0,
    portable_executables: 0,
    processed_files: 0,
    unchanged_files: 0,
    indexed_files: 0,
    cached_files: 0,
    skipped_files: 0,
    failed_files: 0,
  };

  const files = await discover_files();
  status = { ...status, discovered_files: files.length };
  const stored_records = all_archive_files();
  const records = new Map(stored_records.map((record) => [record.id, record]));
  const stale_parser = stale_parser_sha_set();
  const identities = await infer_archive_identities(files, stored_records);
  status = { ...status, current_file: undefined };
  const seen = new Set<string>();
  let pending: ArchiveFileRecord[] = [];
  let cursor = 0;
  let last_flush_at = Date.now();

  const flush = async () => {
    if (pending.length === 0) { return; }
    const batch = pending;
    pending = [];
    last_flush_at = Date.now();
    try {
      await cache_archive_records(batch);
    } catch {
      try {
        await cache_archive_records(batch);
      } catch (error) {
        status = { ...status, last_error: error_message(error) };
      }
    }
  };

  const process_next = async () => {
    let processed_since_yield = 0;
    while (!stopping) {
      const index = cursor;
      cursor += 1;
      const file = files[index];
      if (!file) { return; }
      const { relative_path } = file;
      const id = archive_file_id(relative_path);
      const identity = identities.get(file.source_group);
      if (!identity) { continue; }
      seen.add(id);
      status = { ...status, current_file: relative_path };
      const outcome = await process_file(file, records.get(id), identity, reason, stale_parser);
      records.set(id, outcome.record);
      if (outcome.outcome !== "unchanged") {
        pending.push(outcome.record);
        if (pending.length >= flush_batch_size) { await flush(); }
      }
      update_counters(outcome);
      if (pending.length > 0 && Date.now() - last_flush_at >= flush_interval_ms) { await flush(); }
      processed_since_yield += 1;
      if (processed_since_yield >= scan_yield_interval) {
        processed_since_yield = 0;
        await yield_to_event_loop();
      }
    }
  };

  const workers = Array.from(
    { length: Math.min(env.KERNELARCHIVE_ARCHIVE_IMPORT_CONCURRENCY, Math.max(files.length, 1)) },
    () => process_next(),
  );
  await Promise.all(workers);

  if (!stopping && cursor >= files.length) {
    const missing: ArchiveFileRecord[] = [];
    const now = new Date().toISOString();
    let reconciled_since_yield = 0;
    for (const record of records.values()) {
      if (!seen.has(record.id) && record.status !== "missing") {
        missing.push({
          ...record,
          status: "missing",
          message: "Source file is no longer present in the Archive folder.",
          updated_at: now,
        });
      }
      reconciled_since_yield += 1;
      if (reconciled_since_yield >= scan_yield_interval) {
        reconciled_since_yield = 0;
        await yield_to_event_loop();
      }
    }
    pending.push(...missing);
  }
  await flush();

  status = {
    ...status,
    state: "completed",
    watching: Boolean(watcher),
    queued: Boolean(queued_reason),
    completed_at: new Date().toISOString(),
    current_file: undefined,
  };
}

function reason_priority(reason: ArchiveScanReason) {
  if (reason === "manual") { return 4; }
  if (reason === "watch") { return 3; }
  if (reason === "startup") { return 2; }
  return 1;
}

function queue_reason(reason: ArchiveScanReason) {
  if (!queued_reason || reason_priority(reason) > reason_priority(queued_reason)) {
    queued_reason = reason;
  }
  status = { ...status, queued: true };
}

export function request_archive_pdb_retry(record: ArchiveFileRecord) {
  const pending: ArchiveFileRecord = {
    ...record,
    status: "pending",
    message: "Refreshing PDB and cached symbols.",
    updated_at: new Date().toISOString(),
  };
  if (pdb_retry_inflight.has(record.id)) { return { queued: false, record: pending }; }
  const task = retry_archive_pdb(record)
    .catch((error) => {
      status = { ...status, last_error: error_message(error) };
    })
    .finally(() => {
      if (pdb_retry_inflight.get(record.id) === task) { pdb_retry_inflight.delete(record.id); }
    });
  pdb_retry_inflight.set(record.id, task);
  return { queued: true, record: pending };
}

export function request_archive_scan(reason: ArchiveScanReason = "manual") {
  // Also guarded here, not only at startup. On a mirror an admin pressing rescan
  // would otherwise re-index files whose timestamps changed in transit and
  // overwrite the shipped archive.
  if (!env.KERNELARCHIVE_ARCHIVE_IMPORT_ENABLED) { return archive_scan_status(); }
  if (scan_inflight) {
    if (reason !== "interval") { queue_reason(reason); }
    return archive_scan_status();
  }

  scan_inflight = run_scan(reason)
    .then(() => {
      consecutive_failures = 0;
    })
    .catch((error) => {
      consecutive_failures += 1;
      status = {
        ...status,
        state: "failed",
        queued: Boolean(queued_reason),
        completed_at: new Date().toISOString(),
        current_file: undefined,
        last_error: error_message(error),
      };
    })
    .finally(() => {
      scan_inflight = undefined;
      const next_reason = queued_reason;
      queued_reason = undefined;
      if (next_reason && !stopping) {
        const delay = Math.min(scan_cooldown_ms * 2 ** consecutive_failures, scan_cooldown_max_ms);
        if (rescan_timer) { clearTimeout(rescan_timer); }
        rescan_timer = setTimeout(() => {
          rescan_timer = undefined;
          if (!stopping) { request_archive_scan(next_reason); }
        }, delay);
        rescan_timer.unref();
      }
    });
  return archive_scan_status();
}

function schedule_watch_scan() {
  if (stopping) { return; }
  if (debounce) { clearTimeout(debounce); }
  debounce = setTimeout(() => request_archive_scan("watch"), 2000);
  debounce.unref();
}

export function archive_scan_status(): ArchiveScanStatus {
  return { ...status, watching: Boolean(watcher), queued: Boolean(queued_reason) || status.queued };
}

export function start_archive_importer() {
  if (started) { return archive_scan_status(); }
  // A read-only mirror never indexes. Nothing is watched, scanned or written, so the
  // shipped archive cannot be overwritten by a re-index of files whose timestamps
  // changed in transit. Downloads still resolve, they do not go through the importer.
  if (!env.KERNELARCHIVE_ARCHIVE_IMPORT_ENABLED) {
    status = { ...status, state: "idle", watching: false, queued: false };
    return archive_scan_status();
  }
  started = true;
  stopping = false;
  mkdirSync(root_path, { recursive: true });
  try {
    watcher = watch(root_path, { recursive: true }, schedule_watch_scan);
  } catch {
    watcher = watch(root_path, schedule_watch_scan);
  }
  watcher.on("error", (error) => {
    status = { ...status, watching: false, last_error: error_message(error) };
    watcher?.close();
    watcher = undefined;
  });
  interval = setInterval(() => request_archive_scan("interval"), env.KERNELARCHIVE_ARCHIVE_SCAN_INTERVAL_MS);
  interval.unref();
  startup_scan = setTimeout(() => {
    startup_scan = undefined;
    if (!stopping) { request_archive_scan("startup"); }
  }, startup_scan_delay_ms);
  startup_scan.unref();
  return archive_scan_status();
}

export async function stop_archive_importer() {
  stopping = true;
  started = false;
  queued_reason = undefined;
  if (debounce) { clearTimeout(debounce); }
  if (startup_scan) { clearTimeout(startup_scan); }
  if (rescan_timer) { clearTimeout(rescan_timer); }
  if (interval) { clearInterval(interval); }
  debounce = undefined;
  startup_scan = undefined;
  rescan_timer = undefined;
  interval = undefined;
  watcher?.close();
  watcher = undefined;
  await scan_inflight;
  await stop_archive_ingest_pool();
  await Promise.all(pdb_retry_inflight.values());
  status = { ...status, watching: false, queued: false, current_file: undefined };
}
