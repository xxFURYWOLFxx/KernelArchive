import { Worker } from "node:worker_threads";
import type { ArchiveFileRecord, PdbLookupResult } from "@kernelarchive/shared";
import { env } from "./env";
import type { IngestOptions } from "./ingestion-cache";

export interface ArchiveIngestSummary {
  cache_hit: boolean;
  ingestion_id: string;
  sha256: string;
  build_id: string;
  module_id: string;
  module_name: string;
  pdb_status: PdbLookupResult["status"];
  function_count: number;
  type_count: number;
}

export interface ArchiveIngestTask {
  kind: "ingest";
  id: number;
  filename: string;
  data: Uint8Array;
  options: IngestOptions;
}

export interface ArchiveCacheFilesTask {
  kind: "cache-files";
  id: number;
  records: ArchiveFileRecord[];
}

export type ArchiveWorkerTask = ArchiveIngestTask | ArchiveCacheFilesTask;

export interface ArchiveIngestStop {
  kind: "stop";
}

export interface ArchiveIngestResponse {
  id: number;
  result?: ArchiveIngestSummary;
  ok?: true;
  error?: string;
}

interface PendingTask {
  task: ArchiveWorkerTask;
  resolve: (result?: ArchiveIngestSummary) => void;
  reject: (error: Error) => void;
  timer?: ReturnType<typeof setTimeout>;
}

const worker_heap_mb = 4096;
const ingest_timeout_ms = 1800000;
const cache_files_timeout_ms = 600000;

interface WorkerSlot {
  worker: Worker;
  active?: PendingTask;
  failed: boolean;
  writer: boolean;
}

const slots: WorkerSlot[] = [];
const queue: PendingTask[] = [];
const writer_queue: PendingTask[] = [];
let writer_slot: WorkerSlot | undefined;
let next_id = 1;
let closing = false;

function error_message(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function remove_slot(slot: WorkerSlot) {
  if (slot.writer) {
    if (writer_slot === slot) { writer_slot = undefined; }
    return;
  }
  const index = slots.indexOf(slot);
  if (index >= 0) { slots.splice(index, 1); }
}

function fail_slot(slot: WorkerSlot, error: unknown) {
  if (slot.failed) { return; }
  slot.failed = true;
  const active = slot.active;
  slot.active = undefined;
  if (active?.timer) { clearTimeout(active.timer); }
  active?.reject(new Error(error_message(error)));
  remove_slot(slot);
  if (!closing) {
    create_slot(slot.writer);
    dispatch();
  }
}

function create_slot(writer = false) {
  const worker = new Worker(new URL("./archive-ingest-worker.mjs", import.meta.url), {
    execArgv: [],
    resourceLimits: {
      maxOldGenerationSizeMb: worker_heap_mb,
      maxYoungGenerationSizeMb: 64,
    },
  });
  worker.unref();
  const slot: WorkerSlot = { worker, failed: false, writer };
  if (writer) { writer_slot = slot; } else { slots.push(slot); }
  worker.on("message", (message: ArchiveIngestResponse) => {
    const active = slot.active;
    if (!active || active.task.id !== message.id) { return; }
    slot.active = undefined;
    if (active.timer) { clearTimeout(active.timer); }
    if (message.error) {
      active.reject(new Error(message.error));
    } else {
      active.resolve(message.result);
    }
    dispatch();
  });
  worker.on("error", (error) => fail_slot(slot, error));
  worker.on("exit", (code) => {
    if (!closing && code !== 0) { fail_slot(slot, new Error(`Archive ingestion worker exited with code ${code}.`)); }
  });
}

function ensure_pool() {
  while (!closing && slots.length < env.KERNELARCHIVE_ARCHIVE_IMPORT_CONCURRENCY) {
    create_slot();
  }
  if (!closing && !writer_slot) { create_slot(true); }
}

function assign_slot(slot: WorkerSlot, pending: PendingTask) {
  slot.active = pending;
  pending.timer = setTimeout(
    () => fail_slot(slot, new Error("Archive ingestion task timed out.")),
    pending.task.kind === "ingest" ? ingest_timeout_ms : cache_files_timeout_ms,
  );
  pending.timer.unref();
  if (pending.task.kind === "ingest") {
    const bytes = pending.task.data;
    slot.worker.postMessage(pending.task, [bytes.buffer as ArrayBuffer]);
  } else {
    slot.worker.postMessage(pending.task);
  }
}

function dispatch() {
  if (closing) { return; }
  ensure_pool();
  if (writer_slot && !writer_slot.active && !writer_slot.failed) {
    const pending = writer_queue.shift();
    if (pending) { assign_slot(writer_slot, pending); }
  }
  for (const slot of slots) {
    if (slot.active || slot.failed) { continue; }
    const pending = queue.shift();
    if (!pending) { return; }
    assign_slot(slot, pending);
  }
}

export function ingest_archive_binary(filename: string, data: Buffer, options: IngestOptions, priority = false) {
  if (closing) { return Promise.reject(new Error("Archive ingestion pool is stopping.")); }
  const bytes = data.buffer instanceof ArrayBuffer && data.byteOffset === 0 && data.byteLength === data.buffer.byteLength
    ? new Uint8Array(data.buffer)
    : Uint8Array.from(data);
  return new Promise<ArchiveIngestSummary>((resolve, reject) => {
    const pending: PendingTask = {
      task: {
        kind: "ingest",
        id: next_id,
        filename,
        data: bytes,
        options,
      },
      resolve: (result) => {
        if (result) { resolve(result); }
        else { reject(new Error("Archive ingestion worker returned no result.")); }
      },
      reject,
    };
    if (priority) { queue.unshift(pending); } else { queue.push(pending); }
    next_id += 1;
    dispatch();
  });
}

export function cache_archive_records(records: ArchiveFileRecord[], priority = false) {
  if (records.length === 0) { return Promise.resolve(); }
  if (closing) { return Promise.reject(new Error("Archive ingestion pool is stopping.")); }
  return new Promise<void>((resolve, reject) => {
    const pending: PendingTask = {
      task: {
        kind: "cache-files",
        id: next_id,
        records,
      },
      resolve: () => resolve(),
      reject,
    };
    if (priority) { writer_queue.unshift(pending); } else { writer_queue.push(pending); }
    next_id += 1;
    dispatch();
  });
}

export async function stop_archive_ingest_pool() {
  closing = true;
  const stopped = new Error("Archive ingestion pool stopped.");
  while (queue.length > 0) { queue.shift()?.reject(stopped); }
  while (writer_queue.length > 0) { writer_queue.shift()?.reject(stopped); }
  const workers = slots.splice(0, slots.length);
  if (writer_slot) {
    workers.push(writer_slot);
    writer_slot = undefined;
  }
  for (const slot of workers) {
    const active = slot.active;
    slot.active = undefined;
    slot.failed = true;
    if (active?.timer) { clearTimeout(active.timer); }
    active?.reject(stopped);
  }
  await Promise.all(workers.map((slot) => slot.worker.terminate()));
  closing = false;
}
