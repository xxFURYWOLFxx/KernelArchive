// Pool of read-only SQLite replicas.
//
// Every query used to run synchronously on the single Fastify thread. Warm queries
// are 27-88ms, but the archive is a 14 GB file and a cold page read costs seconds of
// disk I/O; while that ran, nothing else on the server could be served, including
// /health. Query tuning cannot fix I/O latency, so the reads move to worker threads
// instead. WAL lets any number of readers run alongside the writer.
//
// Only the expensive reads route through here. Cheap indexed lookups stay on the
// main thread, where a round trip through a worker would cost more than the query.
import { Worker } from "node:worker_threads";
import { availableParallelism } from "node:os";
import type { ArchiveReadOperation, ArchiveReadRequest, ArchiveReadResponse } from "./archive-read-worker";

interface Pending {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
}

interface Replica {
  worker: Worker;
  inflight: number;
}

const pending = new Map<number, Pending>();
let replicas: Replica[] = [];
let next_id = 1;
let started = false;
let disabled = false;

function spawn(path: string, legacy_path: string): Replica {
  const worker = new Worker(new URL("./archive-read-worker-bootstrap.mjs", import.meta.url), {
    workerData: { path, legacy_path },
    execArgv: [],
  });
  const replica: Replica = { worker, inflight: 0 };
  worker.on("message", (response: ArchiveReadResponse) => {
    replica.inflight = Math.max(0, replica.inflight - 1);
    const entry = pending.get(response.id);
    if (!entry) { return; }
    pending.delete(response.id);
    if (response.error) { entry.reject(new Error(response.error)); return; }
    entry.resolve(response.result);
  });
  // A dead replica must not strand its callers. Fail them so the request layer can
  // fall back to a main-thread read rather than hanging forever.
  const fail_all = (reason: Error) => {
    replicas = replicas.filter((item) => item !== replica);
    for (const [id, entry] of pending) {
      pending.delete(id);
      entry.reject(reason);
    }
    if (replicas.length === 0) { disabled = true; }
  };
  worker.on("error", (error) => fail_all(error instanceof Error ? error : new Error(String(error))));
  worker.on("exit", (code) => { if (code !== 0) { fail_all(new Error(`archive read replica exited with code ${code}`)); } });
  worker.unref();
  return replica;
}

export function start_archive_read_pool(path: string, legacy_path: string, size?: number) {
  if (started) { return replicas.length; }
  started = true;
  // Readers are I/O bound, so a couple more than cores is fine, but each holds its
  // own page cache; four covers the concurrency this serves without wasting memory.
  const count = Math.max(1, Math.min(size ?? Math.max(2, Math.min(4, availableParallelism() - 2)), 8));
  try {
    replicas = Array.from({ length: count }, () => spawn(path, legacy_path));
  } catch {
    disabled = true;
    replicas = [];
  }
  return replicas.length;
}

export function archive_read_pool_ready() {
  return !disabled && replicas.length > 0;
}

// Raised when the replicas are busy but healthy. Callers must not fall back to an
// inline read here: that would put the slow query back on the event loop, which is
// exactly what the pool exists to prevent. Shed the request instead.
export class ArchiveReadBusyError extends Error {
  constructor() {
    super("archive read pool is saturated");
    this.name = "ArchiveReadBusyError";
  }
}

// Bounds the backlog. Past this, queueing only converts a slow response into a slow
// response plus unbounded memory growth.
const max_queue_depth = 48;

// Rejects if the pool is unavailable so callers can run the query inline instead.
export function run_archive_read<T>(operation: ArchiveReadOperation): Promise<T> {
  if (!archive_read_pool_ready()) { return Promise.reject(new Error("archive read pool unavailable")); }
  if (pending.size >= max_queue_depth) { return Promise.reject(new ArchiveReadBusyError()); }
  const replica = replicas.reduce((best, item) => (item.inflight < best.inflight ? item : best));
  const id = next_id++;
  replica.inflight += 1;
  return new Promise<T>((resolve, reject) => {
    pending.set(id, { resolve: resolve as (value: unknown) => void, reject });
    replica.worker.postMessage({ id, operation } satisfies ArchiveReadRequest);
  });
}

export function stop_archive_read_pool() {
  for (const replica of replicas) { void replica.worker.terminate(); }
  replicas = [];
  started = false;
}
