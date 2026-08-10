import { parentPort } from "node:worker_threads";
import type { ArchiveIngestResponse, ArchiveIngestStop, ArchiveIngestSummary, ArchiveWorkerTask } from "./archive-ingest-pool";
import { cache_archive_files, close_local_cache, ingest_binary } from "./ingestion-cache";

const port = parentPort;
if (!port) { throw new Error("Archive ingestion worker requires a parent port."); }

port.on("message", async (message: ArchiveWorkerTask | ArchiveIngestStop) => {
  if (message.kind === "stop") {
    close_local_cache();
    port.close();
    return;
  }

  try {
    if (message.kind === "cache-files") {
      cache_archive_files(message.records);
      port.postMessage({ id: message.id, ok: true } satisfies ArchiveIngestResponse);
      return;
    }

    const data = Buffer.from(message.data.buffer, message.data.byteOffset, message.data.byteLength);
    const result = await ingest_binary(message.filename, data, message.options);
    const summary: ArchiveIngestSummary = {
      cache_hit: result.cache_hit,
      ingestion_id: result.ingestion.id,
      sha256: result.ingestion.sha256,
      build_id: result.build.id,
      module_id: result.module.id,
      module_name: result.module.name,
      pdb_status: result.pdb_lookup.status,
      function_count: result.function_count,
      type_count: result.type_count,
    };
    const response: ArchiveIngestResponse = { id: message.id, result: summary };
    port.postMessage(response);
  } catch (error) {
    const response: ArchiveIngestResponse = {
      id: message.id,
      error: error instanceof Error ? error.message : String(error),
    };
    port.postMessage(response);
  }
});
