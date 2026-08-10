import { Worker } from "node:worker_threads";
import type { KernelFunction, KernelModule, PatternCrossReferenceResult, PatternCrossReferenceTarget, PatternResult } from "@kernelarchive/shared";
import type { PatternWorkerRequest, PatternWorkerResponse } from "./pattern-worker-protocol";

interface PendingRequest {
  resolve: (response: PatternWorkerResponse) => void;
  reject: (error: Error) => void;
}

let worker_instance: Worker | undefined;
let next_request_id = 1;
const pending_requests = new Map<number, PendingRequest>();
const generation_inflight = new Map<string, Promise<PatternResult>>();
const cross_reference_inflight = new Map<string, Promise<{ result: PatternCrossReferenceResult; patterns: PatternResult[] }>>();

function reject_pending(error: Error) {
  for (const request of pending_requests.values()) { request.reject(error); }
  pending_requests.clear();
}

function pattern_worker() {
  if (worker_instance) { return worker_instance; }
  const worker = new Worker(new URL("./pattern-worker-bootstrap.mjs", import.meta.url), { execArgv: [] });
  worker.unref();
  worker.on("message", (response: PatternWorkerResponse) => {
    const pending = pending_requests.get(response.id);
    if (!pending) { return; }
    pending_requests.delete(response.id);
    pending.resolve(response);
  });
  worker.on("error", (error) => {
    if (worker_instance === worker) { worker_instance = undefined; }
    reject_pending(error);
  });
  worker.on("exit", (code) => {
    if (worker_instance === worker) { worker_instance = undefined; }
    if (code !== 0) { reject_pending(new Error(`Pattern worker stopped with code ${code}`)); }
  });
  worker_instance = worker;
  return worker;
}

function send_request(request: PatternWorkerRequest) {
  return new Promise<PatternWorkerResponse>((resolve, reject) => {
    pending_requests.set(request.id, { resolve, reject });
    try {
      pattern_worker().postMessage(request);
    } catch (error) {
      pending_requests.delete(request.id);
      reject(error instanceof Error ? error : new Error("Pattern worker request failed"));
    }
  });
}

export function generate_pattern_background(module: KernelModule, fn: KernelFunction, binary_sha256: string, targets: PatternCrossReferenceTarget[] = []) {
  const key = `${fn.id}:${binary_sha256}`;
  const existing = generation_inflight.get(key);
  if (existing) { return existing; }
  const request = send_request({
    id: next_request_id++,
    operation: "generate",
    module,
    fn,
    binary_sha256,
    targets,
  }).then((response) => {
    if (!response.ok) { throw new Error(response.error); }
    if (response.operation !== "generate") { throw new Error("Pattern worker returned an unexpected response"); }
    return response.pattern;
  }).finally(() => {
    generation_inflight.delete(key);
  });
  generation_inflight.set(key, request);
  return request;
}

export function cross_reference_pattern_background(module: KernelModule | undefined, fn: KernelFunction, targets: PatternCrossReferenceTarget[], source_pattern?: PatternResult) {
  const key = fn.id;
  const existing = cross_reference_inflight.get(key);
  if (existing) { return existing; }
  const request = send_request({
    id: next_request_id++,
    operation: "cross-reference",
    module,
    fn,
    targets,
    source_pattern,
  }).then((response) => {
    if (!response.ok) { throw new Error(response.error); }
    if (response.operation !== "cross-reference") { throw new Error("Pattern worker returned an unexpected response"); }
    return { result: response.result, patterns: response.patterns };
  }).finally(() => {
    cross_reference_inflight.delete(key);
  });
  cross_reference_inflight.set(key, request);
  return request;
}

export async function close_pattern_worker() {
  const worker = worker_instance;
  worker_instance = undefined;
  generation_inflight.clear();
  cross_reference_inflight.clear();
  reject_pending(new Error("Pattern worker closed"));
  if (worker) { await worker.terminate(); }
}
