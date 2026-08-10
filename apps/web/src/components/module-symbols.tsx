"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { ChevronLeft, ChevronRight, FileCode2, Library, Rows3, Search } from "lucide-react";
import { Badge, Button } from "@kernelarchive/ui";
import { function_signature } from "@kernelarchive/shared";
import { api_json, type KernelFunction, type KernelTypeSummary } from "@/lib/api";
import { LoadingState } from "./loading-state";

type SymbolView = "types" | "functions" | "build-types";

const page_size = 50;

export function ModuleSymbols({ buildHasTypes = false, buildId, functionCount, moduleId, typeCount }: { buildHasTypes?: boolean; buildId?: string; functionCount: number; moduleId: string; typeCount: number }) {
  const [view, set_view] = useState<SymbolView>(typeCount > 0 ? "types" : "functions");
  const [query, set_query] = useState("");
  const [page, set_page] = useState(1);
  const [total, set_total] = useState(view === "types" ? typeCount : functionCount);
  const [build_type_count, set_build_type_count] = useState(0);
  const [types, set_types] = useState<KernelTypeSummary[]>([]);
  const [functions, set_functions] = useState<KernelFunction[]>([]);
  const [loading, set_loading] = useState(true);
  const [error, set_error] = useState("");
  const [page_input, set_page_input] = useState("1");
  const build_type_count_key = useRef("");
  const pages = Math.max(1, Math.ceil(total / page_size));

  function commit_page_input() {
    const parsed = Number.parseInt(page_input, 10);
    if (!Number.isFinite(parsed)) {
      set_page_input(String(page));
      return;
    }
    const target = Math.min(Math.max(1, parsed), pages);
    set_page(target);
    set_page_input(String(target));
  }

  useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();
    const handle = window.setTimeout(() => {
      const params = new URLSearchParams({ page: String(page), limit: String(page_size) });
      if (query.trim()) { params.set("q", query.trim()); }
      set_loading(true);
      set_error("");
      const path = view === "build-types"
        ? `/api/v1/builds/${buildId}/types?${params.toString()}`
        : `/api/v1/modules/${moduleId}/${view}?${params.toString()}`;
      const request = view === "functions"
        ? api_json<KernelFunction[]>(path, { signal: controller.signal })
        : api_json<KernelTypeSummary[]>(path, { signal: controller.signal });
      void request
        .then((response) => {
          if (cancelled) { return; }
          const next_total = response.pagination?.total ?? response.data.length;
          set_total(next_total);
          if (view === "functions") {
            set_functions(response.data as KernelFunction[]);
          } else {
            set_types(response.data as KernelTypeSummary[]);
          }
        })
        .catch((reason: unknown) => {
          if (!cancelled) { set_error(reason instanceof Error ? reason.message : "Symbols unavailable"); }
        })
        .finally(() => {
          if (!cancelled) { set_loading(false); }
        });
    }, query ? 180 : 0);

    return () => {
      cancelled = true;
      window.clearTimeout(handle);
      controller.abort();
    };
  }, [buildId, moduleId, page, query, view]);

  // Deliberately not abortable. Selecting a module rewrites the URL, and the
  // resulting navigation used to abort this request a few ms after it started;
  // the deps had not changed, so it never re-fired and the tab lost its count.
  // The ref keeps it to one request per build instead, and a failure clears it
  // so the next render can retry.
  useEffect(() => {
    if (!buildId || !buildHasTypes) { return; }
    if (build_type_count_key.current === buildId) { return; }
    build_type_count_key.current = buildId;
    void api_json<KernelTypeSummary[]>(`/api/v1/builds/${buildId}/types?page=1&limit=1`)
      .then((response) => { set_build_type_count(response.pagination?.total ?? 0); })
      .catch(() => { build_type_count_key.current = ""; });
  }, [buildHasTypes, buildId]);

  useEffect(() => {
    set_page_input(String(page));
  }, [page]);

  function select_view(next_view: SymbolView) {
    set_view(next_view);
    set_page(1);
    set_query("");
    set_total(next_view === "functions" ? functionCount : next_view === "types" ? typeCount : build_type_count);
  }

  return (
    <section className="ka-panel min-w-0 rounded-xl p-4" data-testid="module-symbols">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div className="flex gap-2">
          <button className={`inline-flex h-9 items-center gap-2 rounded-md border px-3 text-sm ${view === "types" ? "border-cyan-300/60 bg-cyan-300/15 text-cyan-100" : "border-white/10 bg-black/30 text-zinc-400 hover:bg-white/5"}`} onClick={() => select_view("types")} type="button">
            <FileCode2 className="h-4 w-4" />
            Types
            <Badge tone="zinc">{typeCount.toLocaleString()}</Badge>
          </button>
          <button className={`inline-flex h-9 items-center gap-2 rounded-md border px-3 text-sm ${view === "functions" ? "border-cyan-300/60 bg-cyan-300/15 text-cyan-100" : "border-white/10 bg-black/30 text-zinc-400 hover:bg-white/5"}`} onClick={() => select_view("functions")} type="button">
            <Rows3 className="h-4 w-4" />
            Functions
            <Badge tone="zinc">{functionCount.toLocaleString()}</Badge>
          </button>
          {buildHasTypes && buildId && (
            <button className={`inline-flex h-9 items-center gap-2 rounded-md border px-3 text-sm ${view === "build-types" ? "border-cyan-300/60 bg-cyan-300/15 text-cyan-100" : "border-white/10 bg-black/30 text-zinc-400 hover:bg-white/5"}`} onClick={() => select_view("build-types")} type="button">
              <Library className="h-4 w-4" />
              Build types
              {build_type_count > 0 && <Badge tone="blue">{build_type_count.toLocaleString()}</Badge>}
            </button>
          )}
        </div>
        <span className="text-xs text-zinc-500">
          {view === "build-types" ? "Whole build" : "This module"}: {total.toLocaleString()} results
        </span>
      </div>

      {view === "types" && typeCount === 0 && (
        <div className="mb-4 rounded-md border border-amber-300/25 bg-amber-300/5 px-3 py-2 text-xs text-amber-100/80">
          This module&apos;s PDB ships public symbols only, so it contains no type records at all and there are no module-specific types to show. Use Build types for the shared kernel structures from this Windows version.
        </div>
      )}

      {view === "build-types" && (
        <div className="mb-4 rounded-md border border-cyan-300/25 bg-cyan-300/5 px-3 py-2 text-xs text-cyan-100/80">
          Shared library for this whole build, not this module specifically. The same {build_type_count.toLocaleString()} types apply to every module here. Layouts come from Microsoft&apos;s PDBs for this exact Windows version.
        </div>
      )}

      <div className="relative mb-4">
        <Search className="pointer-events-none absolute left-3 top-2.5 h-4 w-4 text-zinc-500" />
        <input
          className="h-10 w-full rounded-md border border-white/10 bg-black/30 pl-9 pr-3 text-sm text-zinc-100 outline-none placeholder:text-zinc-600 focus:border-cyan-300/70"
          onChange={(event) => {
            set_query(event.target.value);
            set_page(1);
          }}
          placeholder={view === "build-types" ? "Filter every type in this build" : view === "types" ? "Filter this module's types, fields, enums, or typedefs" : "Filter this module's functions, prototypes, or RVA"}
          value={query}
        />
      </div>

      {loading && <LoadingState detail="Reading this module's cached symbols" label={`Loading module ${view}`} rows={5} />}
      {!loading && error && <div className="rounded-md border border-red-400/20 bg-red-500/10 p-4 text-sm text-red-100">{error}</div>}

      {!loading && !error && view !== "functions" && (
        <div className="grid max-h-[62vh] gap-2 overflow-auto pr-1 md:grid-cols-2 ka-scroll">
          {types.map((type) => (
            <Link className="rounded-md border border-white/10 bg-black/30 px-3 py-3 transition-colors hover:border-cyan-400/60 hover:bg-cyan-300/10" href={`/types/${type.id}`} key={type.id}>
              <div className="flex items-center justify-between gap-3">
                <span className="truncate font-mono text-sm text-cyan-100">{type.name}</span>
                <Badge tone="blue">{type.kind}</Badge>
              </div>
              <div className="mt-2 text-xs text-zinc-500">
                0x{type.size.toString(16)} bytes / {type.kind === "enum" ? `${type.field_count} values` : type.kind === "typedef" ? "type alias" : `${type.field_count} members`}
              </div>
            </Link>
          ))}
        </div>
      )}

      {!loading && !error && view === "functions" && (
        <div className="max-h-[62vh] divide-y divide-white/10 overflow-auto rounded-md border border-white/10 bg-black/30 ka-scroll">
          {functions.map((fn) => (
            <div className="grid gap-3 px-3 py-3 transition-colors hover:bg-white/5 md:grid-cols-[1fr_110px_90px]" key={fn.id}>
              <Link className="min-w-0 hover:text-cyan-100" href={`/functions/${fn.id}`}>
                <div className="truncate font-mono text-sm text-zinc-100">{fn.name}</div>
                <div className="truncate text-xs text-zinc-500">{function_signature(fn)}</div>
              </Link>
              <span className="font-mono text-xs text-zinc-400">{fn.rva}</span>
              {fn.has_pattern ? (
                <Badge tone="green">pattern</Badge>
              ) : (
                <Link className="inline-flex items-center justify-center rounded border border-amber-300/40 bg-amber-300/10 px-2 py-1 text-xs font-medium text-amber-100 hover:bg-amber-300/20" href={`/patterns?function=${fn.id}`}>Pattern</Link>
              )}
            </div>
          ))}
        </div>
      )}

      {!loading && !error && total === 0 && <div className="rounded-md border border-white/10 bg-black/30 p-5 text-sm text-zinc-500">No matching {view}.</div>}

      {!loading && !error && total > 0 && (
        <div className="mt-4 flex flex-wrap items-center justify-between gap-3 border-t border-white/10 pt-4">
          <Button disabled={page <= 1} icon={<ChevronLeft className="h-4 w-4" />} onClick={() => set_page((value) => Math.max(1, value - 1))}>Previous</Button>
          <div className="flex items-center gap-2 font-mono text-xs text-zinc-500">
            <span>Page</span>
            <input
              aria-label="Jump to page"
              className="w-16 rounded border border-white/10 bg-black/40 px-2 py-1 text-center text-zinc-200 outline-none focus:border-cyan-300/50"
              inputMode="numeric"
              onBlur={commit_page_input}
              onChange={(event) => set_page_input(event.target.value)}
              onKeyDown={(event) => { if (event.key === "Enter") { commit_page_input(); } }}
              value={page_input}
            />
            <span>/ {pages.toLocaleString()}</span>
            <span className="text-zinc-600">({total.toLocaleString()} {view})</span>
          </div>
          <Button disabled={page >= pages} icon={<ChevronRight className="h-4 w-4" />} onClick={() => set_page((value) => Math.min(pages, value + 1))}>Next</Button>
        </div>
      )}
    </section>
  );
}
