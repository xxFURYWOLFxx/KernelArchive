"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { ChevronLeft, ChevronRight, FileCode2, RefreshCw, RotateCcw, Search } from "lucide-react";
import { Badge, Button } from "@kernelarchive/ui";
import type { ArchiveFileRecord, PdbLookupStatus } from "@kernelarchive/shared";
import { api_base, read_api_response } from "@/lib/api";
import { LoadingState } from "./loading-state";

type BadgeTone = "blue" | "green" | "yellow" | "red" | "zinc";

const page_size = 25;

function archive_tone(status: ArchiveFileRecord["status"]): BadgeTone {
  if (status === "indexed" || status === "cached") { return "green"; }
  if (status === "failed" || status === "missing") { return "red"; }
  if (status === "pending") { return "blue"; }
  return "zinc";
}

function pdb_tone(status: PdbLookupStatus | undefined): BadgeTone {
  if (status === "cached" || status === "downloaded") { return "green"; }
  if (status === "missing") { return "yellow"; }
  if (status === "download-failed") { return "red"; }
  return "zinc";
}

function pdb_label(status: PdbLookupStatus | undefined) {
  if (status === "cached") { return "PDB cached"; }
  if (status === "downloaded") { return "PDB downloaded"; }
  if (status === "missing") { return "PDB missing"; }
  if (status === "download-failed") { return "PDB error"; }
  if (status === "no-debug-info") { return "No PDB record"; }
  return "PDB unchecked";
}

export function AdminArchiveFiles({ refresh_key, on_changed }: { refresh_key: number; on_changed: () => void }) {
  const [items, set_items] = useState<ArchiveFileRecord[]>([]);
  const [page, set_page] = useState(1);
  const [total, set_total] = useState(0);
  const [query, set_query] = useState("");
  const [status, set_status] = useState("");
  const [pdb_status, set_pdb_status] = useState("");
  const [loading, set_loading] = useState(true);
  const [error, set_error] = useState("");
  const [retrying, set_retrying] = useState<Set<string>>(new Set());
  const [refresh_tick, set_refresh_tick] = useState(0);
  const total_pages = Math.max(1, Math.ceil(total / page_size));
  const has_pending = items.some((item) => item.status === "pending");

  const request_path = useMemo(() => {
    const params = new URLSearchParams({ page: String(page), limit: String(page_size) });
    if (query.trim()) { params.set("q", query.trim()); }
    if (status) { params.set("status", status); }
    if (pdb_status) { params.set("pdb_status", pdb_status); }
    return `/api/v1/admin/archive/files?${params.toString()}`;
  }, [page, query, status, pdb_status]);

  useEffect(() => {
    const controller = new AbortController();
    const timer = window.setTimeout(async () => {
      set_loading(true);
      set_error("");
      try {
        const response = await fetch(api_base + request_path, { credentials: "include", signal: controller.signal });
        if (response.status === 401) {
          window.location.assign("/admin/login?next=/admin");
          return;
        }
        const body = await read_api_response<{ data: ArchiveFileRecord[]; pagination?: { total?: number } }>(response);
        set_items(body.data);
        set_total(body.pagination?.total ?? body.data.length);
      } catch (request_error) {
        if (!controller.signal.aborted) { set_error(request_error instanceof Error ? request_error.message : "Failed to load archive files"); }
      } finally {
        if (!controller.signal.aborted) { set_loading(false); }
      }
    }, query.trim() ? 250 : 0);
    return () => {
      controller.abort();
      window.clearTimeout(timer);
    };
  }, [request_path, refresh_key, refresh_tick]);

  useEffect(() => {
    if (!has_pending) { return; }
    const timer = window.setInterval(() => {
      if (document.visibilityState !== "visible") { return; }
      set_refresh_tick((value) => value + 1);
    }, 5000);
    return () => window.clearInterval(timer);
  }, [has_pending]);

  useEffect(() => {
    if (page > total_pages) { set_page(total_pages); }
  }, [page, total_pages]);

  async function retry_pdb(item: ArchiveFileRecord) {
    set_retrying((current) => new Set(current).add(item.id));
    set_error("");
    try {
      const response = await fetch(`${api_base}/api/v1/admin/archive/files/${encodeURIComponent(item.id)}/pdb/retry`, {
        method: "POST",
        credentials: "include",
      });
      if (response.status === 401) {
        window.location.assign("/admin/login?next=/admin");
        return;
      }
      const body = await read_api_response<{ data: { record: ArchiveFileRecord } }>(response);
      set_items((current) => current.map((entry) => entry.id === item.id ? body.data.record : entry));
      set_refresh_tick((value) => value + 1);
      on_changed();
    } catch (request_error) {
      set_error(request_error instanceof Error ? request_error.message : "PDB refresh failed");
    } finally {
      set_retrying((current) => {
        const next = new Set(current);
        next.delete(item.id);
        return next;
      });
    }
  }

  return (
    <div className="relative mb-5 border-y border-zinc-800">
      <div className="flex flex-col gap-3 py-3 lg:flex-row lg:items-center lg:justify-between">
        <div className="flex items-center gap-2">
          <FileCode2 className="h-4 w-4 text-cyan-300" />
          <span className="text-sm font-medium text-zinc-200">Archive files</span>
          <Badge tone="blue">{total.toLocaleString()}</Badge>
        </div>
        <div className="flex min-w-0 flex-1 flex-col gap-2 sm:flex-row lg:max-w-3xl">
          <label className="relative min-w-0 flex-1">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-zinc-500" />
            <input
              aria-label="Search archive files"
              className="h-9 w-full rounded-md border border-zinc-800 bg-zinc-950 pl-9 pr-3 text-sm text-zinc-100 outline-none transition-colors focus:border-cyan-400/60"
              onChange={(event) => { set_query(event.target.value); set_page(1); }}
              placeholder="Search files or modules"
              value={query}
            />
          </label>
          <select aria-label="File status" className="ka-select h-9 rounded-md border border-zinc-800 px-3 text-sm text-zinc-200" onChange={(event) => { set_status(event.target.value); set_page(1); }} value={status}>
            <option value="">All files</option>
            <option value="indexed">Indexed</option>
            <option value="cached">Cached</option>
            <option value="pending">Pending</option>
            <option value="failed">Failed</option>
            <option value="missing">Source missing</option>
            <option value="skipped">Skipped</option>
          </select>
          <select aria-label="PDB status" className="ka-select h-9 rounded-md border border-zinc-800 px-3 text-sm text-zinc-200" onChange={(event) => { set_pdb_status(event.target.value); set_page(1); }} value={pdb_status}>
            <option value="">All PDB states</option>
            <option value="cached">Cached</option>
            <option value="downloaded">Downloaded</option>
            <option value="missing">Missing</option>
            <option value="download-failed">Error</option>
            <option value="no-debug-info">No PDB record</option>
          </select>
          <Button aria-label="Refresh archive files" className="w-9 shrink-0 px-0" icon={<RefreshCw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} />} onClick={() => set_refresh_tick((value) => value + 1)} title="Refresh archive files" />
        </div>
      </div>

      {error && <div className="mb-3 rounded-md border border-red-400/30 bg-red-500/10 p-3 text-sm text-red-100">{error}</div>}
      {(loading || retrying.size > 0) && <LoadingState className="mb-3" compact={items.length > 0} detail={retrying.size > 0 ? "Updating cached Microsoft Symbol Server status" : "Reading ingestion and PDB status"} label={retrying.size > 0 ? "Refreshing PDB metadata" : "Loading Archive files"} rows={items.length > 0 ? 0 : 4} />}

      <div className={`divide-y divide-zinc-800 transition-opacity ${loading && items.length > 0 ? "opacity-55" : "opacity-100"}`}>
        {items.map((item) => {
          const can_retry = Boolean(item.build_id && item.status !== "missing" && item.status !== "skipped" && item.pdb_status !== "no-debug-info");
          const negative_pdb = item.pdb_status === "missing" || item.pdb_status === "download-failed";
          return (
            <div className="grid gap-3 py-3 md:grid-cols-[minmax(0,1fr)_140px_170px_auto] md:items-center" key={item.id}>
              <div className="min-w-0">
                <div className="truncate font-mono text-xs text-zinc-200" title={item.relative_path}>{item.relative_path}</div>
                <div className="mt-1 flex min-w-0 flex-wrap items-center gap-2 text-xs text-zinc-500">
                  {item.module_id ? <Link className="truncate text-cyan-300 hover:text-cyan-200" href={`/modules/${item.module_id}`}>{item.module_name ?? item.source_group}</Link> : <span className="truncate">{item.module_name ?? item.source_group}</span>}
                  {item.function_count !== undefined && <span>{item.function_count.toLocaleString()} functions</span>}
                  {item.type_count !== undefined && <span>{item.type_count.toLocaleString()} types</span>}
                </div>
              </div>
              <Badge className="w-fit" tone={archive_tone(item.status)}>{item.status}</Badge>
              <div className="min-w-0">
                <Badge className="w-fit" tone={pdb_tone(item.pdb_status)}>{pdb_label(item.pdb_status)}</Badge>
                <div className="mt-1 truncate text-xs text-zinc-600" title={item.message}>{item.message}</div>
              </div>
              {can_retry ? (
                <Button
                  disabled={item.status === "pending" || retrying.has(item.id)}
                  icon={<RotateCcw className={`h-4 w-4 ${retrying.has(item.id) ? "animate-spin" : ""}`} />}
                  onClick={() => void retry_pdb(item)}
                >
                  {negative_pdb ? "Retry" : item.pdb_status ? "Refresh" : "Check PDB"}
                </Button>
              ) : <span />}
            </div>
          );
        })}
        {!loading && items.length === 0 && <div className="py-8 text-center text-sm text-zinc-500">No archive files match.</div>}
      </div>

      <div className="flex items-center justify-between gap-3 py-3 text-xs text-zinc-500">
        <span>{total === 0 ? "0 files" : `${((page - 1) * page_size + 1).toLocaleString()}-${Math.min(page * page_size, total).toLocaleString()} of ${total.toLocaleString()}`}</span>
        <div className="flex items-center gap-2">
          <Button aria-label="Previous page" className="w-9 px-0" disabled={page <= 1 || loading} icon={<ChevronLeft className="h-4 w-4" />} onClick={() => set_page((value) => Math.max(1, value - 1))} title="Previous page" />
          <span className="min-w-16 text-center font-mono text-zinc-400">{page}/{total_pages}</span>
          <Button aria-label="Next page" className="w-9 px-0" disabled={page >= total_pages || loading} icon={<ChevronRight className="h-4 w-4" />} onClick={() => set_page((value) => Math.min(total_pages, value + 1))} title="Next page" />
        </div>
      </div>
    </div>
  );
}
