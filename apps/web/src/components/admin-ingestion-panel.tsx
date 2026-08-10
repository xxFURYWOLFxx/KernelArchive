"use client";

import { useEffect, useState } from "react";
import { Activity, CheckCircle2, Database, FileUp, FolderArchive, RefreshCw, Settings2, UploadCloud } from "lucide-react";
import { Badge, Button } from "@kernelarchive/ui";
import type { BinaryIngestionRecord, BinaryIngestionResult } from "@kernelarchive/shared";
import { api_base, invalidate_api_cache, read_api_response, type AdminCacheData } from "@/lib/api";
import { AdminArchiveFiles } from "./admin-archive-files";
import { LoadingState } from "./loading-state";

type BadgeTone = "blue" | "green" | "yellow" | "red" | "zinc";

const initial_cache: AdminCacheData = {
  ingestions: [],
  archive: {
    status: {
      state: "idle",
      root: "Archive",
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
    },
    files: [],
    stats: {
      total: 0,
      indexed: 0,
      cached: 0,
      skipped: 0,
      failed: 0,
      pending: 0,
      missing: 0,
    },
  },
  stats: {
    builds: 0,
    modules: 0,
    functions: 0,
    types: 0,
    patterns: 0,
    ingestions: 0,
  },
  database: {
    path: "local-cache/archive.sqlite",
    revision: 0,
  },
  pagination: {
    page: 1,
    limit: 25,
    total: 0,
  },
};

function pdb_tone(status: BinaryIngestionRecord["pdb_status"]): BadgeTone {
  if (status === "cached" || status === "downloaded") { return "green"; }
  if (status === "missing") { return "yellow"; }
  if (status === "download-failed") { return "red"; }
  return "zinc";
}

function result_stages(result: BinaryIngestionResult): Array<{ label: string; tone: BadgeTone; status: string }> {
  return [
    { label: result.cache_hit ? "Loaded cached index" : "Stored binary", tone: "green" as const, status: result.cache_hit ? "instant" : "done" },
    { label: "Parsed PE", tone: "green" as const, status: result.cache_hit ? "cached" : "done" },
    { label: result.manual_identification_required ? "Detection required" : "Detected build", tone: result.manual_identification_required ? "yellow" as const : "green" as const, status: result.manual_identification_required ? "review" : "done" },
    { label: result.pdb_lookup.status === "missing" ? "PDB not found" : result.pdb_lookup.status === "download-failed" ? "PDB lookup failed" : result.pdb_lookup.status === "no-debug-info" ? "No PDB record" : result.cache_hit ? "Cached PDB" : "Resolved PDB", tone: pdb_tone(result.pdb_lookup.status), status: result.pdb_lookup.status === "missing" || result.pdb_lookup.status === "download-failed" ? "retry" : result.pdb_lookup.status === "no-debug-info" ? "skipped" : result.cache_hit ? "cached" : "done" },
    { label: `${result.type_count.toLocaleString()} types`, tone: result.type_count > 0 ? "green" as const : "yellow" as const, status: result.type_count > 0 ? "done" : "pending" },
    { label: `${result.function_count.toLocaleString()} functions`, tone: result.function_count > 0 ? "green" as const : "yellow" as const, status: result.function_count > 0 ? "done" : "pending" },
  ];
}


async function file_sha256(file: File) {
  const digest = await crypto.subtle.digest("SHA-256", await file.arrayBuffer());
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function AdminIngestionPanel() {
  const [cache, set_cache] = useState<AdminCacheData>(initial_cache);
  const [file, set_file] = useState<File | null>(null);
  const [show_manual, set_show_manual] = useState(false);
  const [product_name, set_product_name] = useState("");
  const [version, set_version] = useState("");
  const [build_number, set_build_number] = useState("");
  const [revision, set_revision] = useState("");
  const [result, set_result] = useState<BinaryIngestionResult | null>(null);
  const [error, set_error] = useState("");
  const [loading, set_loading] = useState(false);
  const [upload_status, set_upload_status] = useState("");
  const [page, set_page] = useState(1);
  const limit = 25;
  const total_pages = Math.max(1, Math.ceil(cache.pagination.total / cache.pagination.limit));
  const showing_from = cache.pagination.total === 0 ? 0 : ((cache.pagination.page - 1) * cache.pagination.limit) + 1;
  const showing_to = Math.min(cache.pagination.page * cache.pagination.limit, cache.pagination.total);
  const archive_found = Math.max(cache.archive.status.discovered_files, cache.archive.stats.total);
  const archive_completed = cache.archive.status.processed_files + cache.archive.status.unchanged_files;
  const archive_progress = cache.archive.status.discovered_files > 0 ? Math.min(100, Math.round((archive_completed / cache.archive.status.discovered_files) * 100)) : 0;

  const [archive_refresh, set_archive_refresh] = useState(0);
  const [archive_loading, set_archive_loading] = useState(false);
  async function load_cache(next_page = page) {
    try {
      const response = await fetch(`${api_base}/api/v1/admin/ingestions?page=${next_page}&limit=${limit}`, {
        credentials: "include",
      });
      if (response.status === 401) {
        window.location.assign("/admin/login?next=/admin");
        return;
      }
      const body = await read_api_response<{ data: AdminCacheData }>(response);
      set_cache(body.data);
      set_page(next_page);
    } catch (request_error) {
      set_error(request_error instanceof Error ? request_error.message : "Failed to load local cache");
    }
  }

  async function upload_file() {
    if (!file) { return; }
    set_loading(true);
    set_upload_status("Checking cache");
    set_error("");
    set_result(null);
    try {
      const params = new URLSearchParams({ filename: file.name });
      if (product_name.trim()) { params.set("product_name", product_name.trim()); }
      if (version.trim()) { params.set("version", version.trim()); }
      if (build_number.trim()) { params.set("build_number", build_number.trim()); }
      if (revision.trim()) { params.set("revision", revision.trim()); }
      const sha256 = await file_sha256(file);
      const cached_response = await fetch(`${api_base}/api/v1/admin/cache/binaries/${sha256}?${params.toString()}`, {
        credentials: "include",
      });
      if (cached_response.status === 401) {
        window.location.assign("/admin/login?next=/admin");
        return;
      }
      if (cached_response.ok) {
        const cached_body = await read_api_response<{ data: BinaryIngestionResult }>(cached_response);
        set_archive_refresh((value) => value + 1);
        set_result(cached_body.data);
        invalidate_api_cache();
        await load_cache(1);
        return;
      }
      if (cached_response.status !== 404) {
        await read_api_response<unknown>(cached_response);
      }

      set_upload_status("Indexing");
      const response = await fetch(`${api_base}/api/v1/admin/uploads/binary?${params.toString()}`, {
        method: "POST",
        credentials: "include",
        headers: {
          "content-type": "application/octet-stream",
          "x-filename": file.name,
        },
        body: file,
      });
      const body = await read_api_response<{ data: BinaryIngestionResult }>(response);
      set_archive_refresh((value) => value + 1);
      set_result(body.data);
      invalidate_api_cache();
      await load_cache(1);
    } catch (request_error) {
      set_error(request_error instanceof Error ? request_error.message : "Upload failed");
    } finally {
      set_loading(false);
      set_upload_status("");
    }
  }

  async function scan_archive() {
    set_archive_loading(true);
    set_error("");
    try {
      const response = await fetch(api_base + "/api/v1/admin/archive/scan", {
        method: "POST",
        credentials: "include",
      });
      if (response.status === 401) {
        window.location.assign("/admin/login?next=/admin");
        return;
      }
      const body = await read_api_response<{ data: AdminCacheData["archive"]["status"] }>(response);
      set_cache((current) => ({
        ...current,
        archive: { ...current.archive, status: body.data },
      }));
      set_archive_refresh((value) => value + 1);
      await load_cache(1);
    } catch (request_error) {
      set_error(request_error instanceof Error ? request_error.message : "Archive scan failed");
    } finally {
      set_archive_loading(false);
    }
  }

  useEffect(() => {
    void load_cache(1);
  }, []);

  useEffect(() => {
    if (cache.archive.status.state !== "scanning" && !cache.archive.status.queued) { return; }
    const timer = window.setInterval(() => {
      if (document.visibilityState !== "visible") { return; }
      void load_cache(page);
    }, 5000);
    return () => window.clearInterval(timer);
  }, [cache.archive.status.state, cache.archive.status.queued, page]);

  return (
    <div className="relative grid gap-4 lg:grid-cols-[380px_1fr]">
      {(loading || archive_loading) && <LoadingState className="lg:col-span-2" compact detail={loading ? "Checking the binary cache and indexing symbols" : "Starting the Archive scan"} label={loading ? (upload_status || "Processing binary") : "Preparing Archive scan"} rows={1} />}
      <aside className="rounded-md border border-line bg-panel p-4">
        <div className="mb-4 flex items-center gap-2">
          <FolderArchive className="h-4 w-4 text-cyan-300" />
          <h1 className="text-base font-semibold">Archive ingestion</h1>
        </div>
        <div className="space-y-3">
          <div className="space-y-3 border-b border-zinc-800 pb-4">
            <div className="flex items-center justify-between gap-3">
              <span className="text-sm font-medium text-zinc-200">Archive folder</span>
              <div className="flex items-center gap-2">
                <Badge tone={cache.archive.status.watching ? "green" : "yellow"}>{cache.archive.status.watching ? "watching" : "polling"}</Badge>
                <Badge tone={cache.archive.status.state === "failed" ? "red" : cache.archive.status.state === "scanning" ? "blue" : "zinc"}>{cache.archive.status.state}</Badge>
              </div>
            </div>
            <code className="block break-all rounded border border-zinc-800 bg-zinc-950 px-3 py-2 font-mono text-xs text-zinc-300">{cache.archive.status.root}</code>
            <div className="grid grid-cols-3 gap-2 text-center">
              <div>
                <div className="font-mono text-base text-zinc-100">{archive_found.toLocaleString()}</div>
                <div className="text-xs text-zinc-500">Found</div>
              </div>
              <div>
                <div className="font-mono text-base text-emerald-300">{(cache.archive.stats.indexed + cache.archive.stats.cached).toLocaleString()}</div>
                <div className="text-xs text-zinc-500">Ready</div>
              </div>
              <div>
                <div className="font-mono text-base text-red-300">{cache.archive.stats.failed.toLocaleString()}</div>
                <div className="text-xs text-zinc-500">Failed</div>
              </div>
            </div>
            {(cache.archive.status.state === "scanning" || cache.archive.status.queued) && (
              <div aria-busy="true" className="rounded-md border border-cyan-300/30 bg-cyan-300/[0.07] p-3" role="status">
                <div className="mb-2 flex items-center justify-between gap-3 text-xs">
                  <span className="font-medium text-cyan-100">Scanning Archive</span>
                  <span className="font-mono text-cyan-100">{archive_progress}%</span>
                </div>
                <div aria-label="Archive scan progress" aria-valuemax={100} aria-valuemin={0} aria-valuenow={archive_progress} className="h-2 overflow-hidden rounded bg-black/40" role="progressbar">
                  <div className="h-full bg-cyan-400 transition-[width] duration-300" style={{ width: archive_progress + "%" }} />
                </div>
                <div className="mt-2 truncate font-mono text-xs text-zinc-300">{cache.archive.status.current_file ?? "Preparing scan"}</div>
              </div>
            )}
            <Button className="w-full" disabled={archive_loading || cache.archive.status.state === "scanning"} icon={<RefreshCw className={"h-4 w-4 " + (cache.archive.status.state === "scanning" ? "animate-spin" : "")} />} onClick={scan_archive} variant="primary">
              {cache.archive.status.state === "scanning" ? "Scanning " + archive_progress + "%" : "Scan Archive"}
            </Button>
          </div>
          <div className="flex items-center gap-2 pt-1 text-xs font-medium text-zinc-400">
            <UploadCloud className="h-4 w-4" />
            Single file
          </div>
          <label className="block">
            <span className="mb-1 block text-xs text-zinc-500">Binary</span>
            <input className="block w-full rounded-md border border-zinc-800 bg-zinc-950 px-3 py-2 text-sm text-zinc-100 file:mr-3 file:rounded file:border-0 file:bg-zinc-800 file:px-2 file:py-1 file:text-zinc-100" onChange={(event) => set_file(event.target.files?.[0] ?? null)} type="file" />
          </label>
          <Button className="w-full" icon={<Settings2 className="h-4 w-4" />} onClick={() => set_show_manual((value) => !value)}>
            {show_manual ? "Hide detection fix" : "Fix detection"}
          </Button>
          {show_manual && (
            <div className="grid grid-cols-2 gap-2 rounded-md border border-zinc-800 bg-zinc-950 p-3">
              <input className="h-9 rounded-md border border-zinc-800 bg-panel px-3 text-sm text-zinc-100" onChange={(event) => set_product_name(event.target.value)} placeholder="Product" value={product_name} />
              <input className="h-9 rounded-md border border-zinc-800 bg-panel px-3 text-sm text-zinc-100" onChange={(event) => set_version(event.target.value)} placeholder="Version" value={version} />
              <input className="h-9 rounded-md border border-zinc-800 bg-panel px-3 text-sm text-zinc-100" onChange={(event) => set_build_number(event.target.value)} placeholder="Build" value={build_number} />
              <input className="h-9 rounded-md border border-zinc-800 bg-panel px-3 text-sm text-zinc-100" onChange={(event) => set_revision(event.target.value)} placeholder="Revision" value={revision} />
            </div>
          )}
          <Button className="w-full" disabled={!file || loading} icon={<FileUp className="h-4 w-4" />} onClick={upload_file} variant="primary">
            {loading ? upload_status : "Upload and index"}
          </Button>
          <Button className="w-full" icon={<RefreshCw className="h-4 w-4" />} onClick={() => void load_cache(page)}>Refresh cache</Button>
        </div>
        {error && <div className="mt-4 rounded-md border border-red-400/40 bg-red-500/10 p-3 text-sm text-red-200">{error}</div>}
        {result && (
          <div className="mt-4 rounded-md border border-zinc-800 bg-zinc-950 p-3">
            <div className="mb-2 flex flex-wrap items-center gap-2">
              <Badge tone={result.cache_hit ? "green" : "blue"}>{result.cache_hit ? "cache hit" : "indexed now"}</Badge>
              <Badge tone={result.manual_identification_required ? "yellow" : "green"}>{result.build_detection_source}</Badge>
              <Badge tone={pdb_tone(result.ingestion.pdb_status)}>{result.ingestion.pdb_status}</Badge>
            </div>
            <div className="mb-3 grid gap-2">
              {result_stages(result).map((stage) => (
                <div className="flex items-center justify-between gap-3 rounded border border-zinc-800 bg-panel px-3 py-2 text-sm" key={stage.label}>
                  <span className="flex items-center gap-2 text-zinc-200">
                    <CheckCircle2 className="h-4 w-4 text-emerald-300" />
                    {stage.label}
                  </span>
                  <Badge tone={stage.tone}>{stage.status}</Badge>
                </div>
              ))}
            </div>
            <div className="space-y-1 font-mono text-xs text-zinc-300">
              <div>{result.module.name}</div>
              <div>{result.build.build_number}.{result.build.revision} / {result.build.architecture}</div>
              <div className="break-all text-zinc-500">{result.ingestion.sha256}</div>
            </div>
          </div>
        )}
      </aside>
      <section className="rounded-md border border-line bg-panel p-4">
        <div className="mb-4 flex items-center gap-2">
          <Activity className="h-4 w-4 text-emerald-300" />
          <h2 className="text-base font-semibold">Local cache</h2>
        </div>
        <AdminArchiveFiles on_changed={() => void load_cache(page)} refresh_key={archive_refresh} />
        <div className="mb-4 grid gap-3 md:grid-cols-6">
          <div className="rounded border border-zinc-800 bg-zinc-950 p-3">
            <div className="text-xs text-zinc-500">Builds</div>
            <div className="font-mono text-lg text-zinc-100">{cache.stats.builds}</div>
          </div>
          <div className="rounded border border-zinc-800 bg-zinc-950 p-3">
            <div className="text-xs text-zinc-500">Modules</div>
            <div className="font-mono text-lg text-zinc-100">{cache.stats.modules}</div>
          </div>
          <div className="rounded border border-zinc-800 bg-zinc-950 p-3">
            <div className="text-xs text-zinc-500">Functions</div>
            <div className="font-mono text-lg text-zinc-100">{cache.stats.functions.toLocaleString()}</div>
          </div>
          <div className="rounded border border-zinc-800 bg-zinc-950 p-3">
            <div className="text-xs text-zinc-500">Types</div>
            <div className="font-mono text-lg text-zinc-100">{cache.stats.types.toLocaleString()}</div>
          </div>
          <div className="rounded border border-zinc-800 bg-zinc-950 p-3">
            <div className="text-xs text-zinc-500">Patterns</div>
            <div className="font-mono text-lg text-zinc-100">{cache.stats.patterns.toLocaleString()}</div>
          </div>
          <div className="rounded border border-zinc-800 bg-zinc-950 p-3">
            <div className="text-xs text-zinc-500">Uploads</div>
            <div className="font-mono text-lg text-zinc-100">{cache.stats.ingestions.toLocaleString()}</div>
          </div>
        </div>
        <div className="mb-3 flex items-center justify-between gap-3 text-sm text-zinc-500">
          <span>Showing {showing_from.toLocaleString()}-{showing_to.toLocaleString()} of {cache.pagination.total.toLocaleString()} uploads</span>
          <div className="flex items-center gap-2">
            <Button disabled={cache.pagination.page <= 1} onClick={() => void load_cache(cache.pagination.page - 1)}>Previous</Button>
            <span className="font-mono text-xs text-zinc-400">{cache.pagination.page}/{total_pages}</span>
            <Button disabled={cache.pagination.page >= total_pages} onClick={() => void load_cache(cache.pagination.page + 1)}>Next</Button>
          </div>
        </div>
        <div className="divide-y divide-zinc-800">
          {cache.ingestions.map((item) => (
            <div key={item.id} className="grid gap-2 py-3 md:grid-cols-[190px_120px_1fr_140px]">
              <span className="font-mono text-sm text-zinc-200">{item.module_name}</span>
              <Badge tone={pdb_tone(item.pdb_status)}>{item.pdb_status}</Badge>
              <span className="break-all font-mono text-xs text-zinc-100">{item.cache_path}</span>
              <span className="text-sm text-zinc-500">{item.build_label}</span>
            </div>
          ))}
          {cache.ingestions.length === 0 && (
            <div className="rounded-md border border-zinc-800 bg-zinc-950 p-6 text-sm text-zinc-500">
              No local uploads indexed.
            </div>
          )}
        </div>
        <div className="mt-4 rounded-md border border-zinc-800 bg-zinc-950 p-3">
          <div className="mb-2 flex items-center justify-between gap-3 text-sm text-zinc-100">
            <span className="flex items-center gap-2">
            <Database className="h-4 w-4 text-cyan-300" />
            Shared database cache
            </span>
            <Badge tone="green">revision {cache.database.revision}</Badge>
          </div>
          <code className="break-all font-mono text-xs text-zinc-400">{cache.database.path}</code>
        </div>
      </section>
    </div>
  );
}
