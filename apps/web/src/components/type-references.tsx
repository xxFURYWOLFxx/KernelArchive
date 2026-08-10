"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { Braces, ChevronDown, ChevronLeft, ChevronRight, Rows3, Search, Share2 } from "lucide-react";
import { Badge, Button } from "@kernelarchive/ui";
import type { TypeFieldReference, TypeFunctionReference } from "@kernelarchive/shared";
import { api_json } from "@/lib/api";
import { LoadingState } from "./loading-state";

type ReferenceView = "fields" | "functions";

const page_size = 50;

function offset_label(offset_bits: number) {
  const byte_offset = Math.floor(offset_bits / 8);
  const bit_offset = offset_bits % 8;
  return bit_offset === 0 ? `0x${byte_offset.toString(16)}` : `0x${byte_offset.toString(16)}:${bit_offset}`;
}

export function TypeReferences({ typeId }: { typeId: string }) {
  const [open, set_open] = useState(false);
  const [view, set_view] = useState<ReferenceView>("fields");
  const [query, set_query] = useState("");
  const [page, set_page] = useState(1);
  const [field_total, set_field_total] = useState<number | null>(null);
  const [function_total, set_function_total] = useState<number | null>(null);
  const [fields, set_fields] = useState<TypeFieldReference[]>([]);
  const [functions, set_functions] = useState<TypeFunctionReference[]>([]);
  const [loading, set_loading] = useState(false);
  const [error, set_error] = useState("");
  const active_total = view === "fields" ? field_total : function_total;
  const total = active_total ?? 0;
  const pages = Math.max(1, Math.ceil(total / page_size));

  useEffect(() => {
    if (!open) { return; }
    let cancelled = false;
    const handle = window.setTimeout(() => {
      const params = new URLSearchParams({ page: String(page), limit: String(page_size) });
      if (query.trim()) { params.set("q", query.trim()); }
      set_loading(true);
      set_error("");
      const path = `/api/v1/types/${typeId}/references/${view}?${params.toString()}`;
      const request = view === "fields" ? api_json<TypeFieldReference[]>(path) : api_json<TypeFunctionReference[]>(path);
      void request.then((response) => {
        if (cancelled) { return; }
        if (view === "fields") {
          set_fields(response.data as TypeFieldReference[]);
          set_field_total(response.pagination?.total ?? response.data.length);
        } else {
          set_functions(response.data as TypeFunctionReference[]);
          set_function_total(response.pagination?.total ?? response.data.length);
        }
      }).catch((reason: unknown) => {
        if (!cancelled) { set_error(reason instanceof Error ? reason.message : "References unavailable"); }
      }).finally(() => {
        if (!cancelled) { set_loading(false); }
      });
    }, query ? 180 : 0);

    return () => {
      cancelled = true;
      window.clearTimeout(handle);
    };
  }, [open, page, query, typeId, view]);

  function select_view(next_view: ReferenceView) {
    set_view(next_view);
    set_page(1);
    set_query("");
  }

  return (
    <details className="group ka-panel rounded-xl" data-testid="type-references" onToggle={(event) => set_open(event.currentTarget.open)}>
      <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-4 py-3">
        <span className="flex items-center gap-2 text-sm font-semibold text-zinc-100">
          <Share2 className="h-4 w-4 text-cyan-300" />
          Cross-references
          <ChevronDown className="h-4 w-4 text-zinc-500 transition-transform group-open:rotate-180" />
        </span>
        {open && <Badge tone={loading ? "blue" : "zinc"}>{loading ? "Loading" : active_total === null ? "--" : active_total.toLocaleString()}</Badge>}
      </summary>

      {open && (
        <div className="border-t border-white/10 p-4">
          <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
            <div className="flex gap-2">
              <button className={`inline-flex h-9 items-center gap-2 rounded-md border px-3 text-sm ${view === "fields" ? "border-cyan-300/60 bg-cyan-300/15 text-cyan-100" : "border-white/10 bg-black/30 text-zinc-400 hover:bg-white/5"}`} disabled={loading} onClick={() => select_view("fields")} type="button">
                <Braces className="h-4 w-4" />Fields <Badge tone="zinc">{view === "fields" && loading ? "..." : field_total === null ? "--" : field_total.toLocaleString()}</Badge>
              </button>
              <button className={`inline-flex h-9 items-center gap-2 rounded-md border px-3 text-sm ${view === "functions" ? "border-cyan-300/60 bg-cyan-300/15 text-cyan-100" : "border-white/10 bg-black/30 text-zinc-400 hover:bg-white/5"}`} disabled={loading} onClick={() => select_view("functions")} type="button">
                <Rows3 className="h-4 w-4" />Functions <Badge tone="zinc">{view === "functions" && loading ? "..." : function_total === null ? "--" : function_total.toLocaleString()}</Badge>
              </button>
            </div>
            <span className="text-xs text-zinc-500">{loading ? "Loading references" : active_total === null ? "Not loaded" : `${active_total.toLocaleString()} results`}</span>
          </div>

          <div className="relative mb-4">
            <Search className="pointer-events-none absolute left-3 top-2.5 h-4 w-4 text-zinc-500" />
            <input className="h-10 w-full rounded-md border border-white/10 bg-black/30 pl-9 pr-3 text-sm text-zinc-100 outline-none placeholder:text-zinc-600 focus:border-cyan-300/70" disabled={loading} onChange={(event) => { set_query(event.target.value); set_page(1); }} placeholder="Filter cross-references" value={query} />
          </div>

          {loading && <LoadingState detail="Reading the shared reference index" label={`Loading ${view === "fields" ? "field" : "function"} cross-references`} rows={4} />}
          {!loading && error && <div className="rounded-md border border-red-400/20 bg-red-500/10 p-4 text-sm text-red-100">{error}</div>}

          {!loading && !error && view === "fields" && (
            <div className="max-h-[480px] divide-y divide-white/10 overflow-auto rounded-md border border-white/10 bg-black/30 ka-scroll">
              {fields.map((reference) => (
                <Link className="grid gap-2 px-3 py-3 transition-colors hover:bg-white/5 md:grid-cols-[1fr_150px_110px]" href={`/types/${reference.type_id}`} key={reference.field_id}>
                  <div className="min-w-0">
                    <div className="truncate font-mono text-sm text-zinc-100">{reference.type_name}.{reference.field_name}</div>
                    <div className="truncate text-xs text-zinc-500">{reference.field_type_name}</div>
                  </div>
                  <span className="truncate text-xs text-zinc-400">{reference.module_name}</span>
                  <span className="font-mono text-xs text-zinc-400">{offset_label(reference.offset_bits)}</span>
                </Link>
              ))}
            </div>
          )}

          {!loading && !error && view === "functions" && (
            <div className="max-h-[480px] divide-y divide-white/10 overflow-auto rounded-md border border-white/10 bg-black/30 ka-scroll">
              {functions.map((reference) => (
                <Link className="grid gap-2 px-3 py-3 transition-colors hover:bg-white/5 md:grid-cols-[1fr_150px_110px]" href={`/functions/${reference.function_id}`} key={reference.function_id}>
                  <div className="min-w-0">
                    <div className="truncate font-mono text-sm text-zinc-100">{reference.function_name}</div>
                    <div className="truncate text-xs text-zinc-500">{reference.signature}</div>
                  </div>
                  <span className="truncate text-xs text-zinc-400">{reference.module_name}</span>
                  <span className="font-mono text-xs text-zinc-400">{reference.rva}</span>
                </Link>
              ))}
            </div>
          )}

          {!loading && !error && active_total !== null && total === 0 && <div className="rounded-md border border-white/10 bg-black/30 p-4 text-sm text-zinc-500">No {view} reference this type.</div>}
          {!loading && !error && active_total !== null && total > 0 && (
            <div className="mt-4 flex items-center justify-between gap-3">
              <Button disabled={page <= 1} icon={<ChevronLeft className="h-4 w-4" />} onClick={() => set_page((value) => Math.max(1, value - 1))}>Previous</Button>
              <span className="font-mono text-xs text-zinc-500">{page} / {pages}</span>
              <Button disabled={page >= pages} icon={<ChevronRight className="h-4 w-4" />} onClick={() => set_page((value) => Math.min(pages, value + 1))}>Next</Button>
            </div>
          )}
        </div>
      )}
    </details>
  );
}
