// One read replica of the archive. Holds its own read-only SQLite connection and
// answers a fixed set of expensive queries so the main thread never blocks on them.
// The archive is a 14 GB file, so the dominant cost is cold page reads from disk,
// not query planning; moving that off the event loop is the only thing that stops a
// single uncached read from stalling every other request.
import { parentPort, workerData } from "node:worker_threads";
import { ArchiveStore } from "./archive-store";
import type { ArchiveSearchFilters } from "./archive-store";

export type ArchiveReadOperation =
  | { kind: "search"; query: string; offset: number; limit: number; filters: ArchiveSearchFilters }
  | { kind: "build_types_page"; build_id: string; offset: number; limit: number; query: string; known_total?: number }
  | { kind: "module_symbols_page"; collection: "functions" | "types"; parent_id: string; offset: number; limit: number; query: string }
  | { kind: "type_field_references_page"; type_name: string; type_id: string; eligible_build_ids: string[]; offset: number; limit: number; query: string }
  | { kind: "type_function_references_page"; type_name: string; eligible_build_ids: string[]; offset: number; limit: number; query: string };

export interface ArchiveReadRequest {
  id: number;
  operation: ArchiveReadOperation;
}

export interface ArchiveReadResponse {
  id: number;
  result?: unknown;
  error?: string;
}

const { path, legacy_path } = workerData as { path: string; legacy_path: string };
const store = new ArchiveStore(path, legacy_path, { read_only: true });

function run(operation: ArchiveReadOperation) {
  switch (operation.kind) {
    case "search":
      return store.search(operation.query, operation.offset, operation.limit, operation.filters);
    case "build_types_page":
      return store.build_types_page(operation.build_id, operation.offset, operation.limit, operation.query, operation.known_total);
    case "module_symbols_page":
      return store.module_symbols_page(operation.collection, operation.parent_id, operation.offset, operation.limit, operation.query);
    case "type_field_references_page":
      return store.type_field_references_page(operation.type_name, operation.type_id, operation.eligible_build_ids, operation.offset, operation.limit, operation.query);
    case "type_function_references_page":
      return store.type_function_references_page(operation.type_name, operation.eligible_build_ids, operation.offset, operation.limit, operation.query);
    default:
      throw new Error("unknown read operation");
  }
}

parentPort?.on("message", (request: ArchiveReadRequest) => {
  try {
    parentPort?.postMessage({ id: request.id, result: run(request.operation) } satisfies ArchiveReadResponse);
  } catch (error) {
    parentPort?.postMessage({ id: request.id, error: error instanceof Error ? error.message : String(error) } satisfies ArchiveReadResponse);
  }
});
