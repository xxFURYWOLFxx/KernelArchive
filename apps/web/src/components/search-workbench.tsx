"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { ChevronLeft, ChevronRight, Search, SlidersHorizontal } from "lucide-react";
import { Badge, Button } from "@kernelarchive/ui";
import { grouped_builds } from "@/lib/build-family";
import { api_json, api_list_all, type SearchResult, type WindowsBuild } from "@/lib/api";
import type { EntityKind } from "@kernelarchive/shared";
import { LoadingState } from "./loading-state";

const kinds: Array<"all" | EntityKind> = ["all", "module", "function", "type"];
const page_size = 50;

export function SearchWorkbench() {
  const [query, set_query] = useState("");
  const [build, set_build] = useState("all");
  const [kind, set_kind] = useState<(typeof kinds)[number]>("all");
  const [builds, set_builds] = useState<WindowsBuild[]>([]);
  const [results, set_results] = useState<SearchResult[]>([]);
  const [page, set_page] = useState(1);
  const [total, set_total] = useState(0);
  const [loading, set_loading] = useState(false);
  const [error, set_error] = useState("");
  const build_groups = useMemo(() => grouped_builds(builds), [builds]);
  const pages = Math.max(1, Math.ceil(total / page_size));

  useEffect(() => {
    void api_list_all<WindowsBuild>("/api/v1/builds").then(set_builds);
  }, []);

  useEffect(() => {
    const normalized = query.trim();
    if (normalized.length < 2) {
      set_results([]);
      set_total(0);
      set_error("");
      set_loading(false);
      return;
    }

    const controller = new AbortController();
    const handle = window.setTimeout(() => {
      const params = new URLSearchParams({ q: normalized, page: String(page), limit: String(page_size) });
      if (build !== "all") { params.set("build", build); }
      if (kind !== "all") { params.set("kind", kind); }
      set_loading(true);
      set_error("");
      void api_json<SearchResult[]>(`/api/v1/search?${params.toString()}`, { signal: controller.signal })
        .then((response) => {
          if (!controller.signal.aborted) {
            set_results(response.data);
            set_total(response.pagination?.total ?? response.data.length);
          }
        })
        .catch((reason: unknown) => {
          if (!controller.signal.aborted) {
            set_results([]);
            set_total(0);
            set_error(reason instanceof Error ? reason.message : "Search unavailable");
          }
        })
        .finally(() => {
          if (!controller.signal.aborted) { set_loading(false); }
        });
    }, 180);

    return () => { window.clearTimeout(handle); controller.abort(); };
  }, [build, kind, page, query]);

  return (
    <div className="grid min-w-0 gap-4 lg:grid-cols-[320px_minmax(0,1fr)]">
      <aside className="ka-panel min-w-0 rounded-xl p-4">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-sm font-semibold text-zinc-100">Filters</h2>
          <SlidersHorizontal className="h-4 w-4 text-zinc-500" />
        </div>
        <div className="space-y-3 text-sm">
          <label className="block">
            <span className="mb-1 block text-xs text-zinc-500">Build</span>
            <select className="ka-select h-9 w-full rounded-md border border-white/10 px-2 text-zinc-100 outline-none focus:border-cyan-300/60" onChange={(event) => { set_build(event.target.value); set_page(1); }} value={build}>
              <option value="all">All builds</option>
              {build_groups.map((group) => (
                <optgroup key={group.family} label={group.family}>
                  {group.builds.map((item) => (
                    <option key={item.id} value={item.id}>{item.build_number}.{item.revision} / {item.architecture}</option>
                  ))}
                </optgroup>
              ))}
            </select>
          </label>
          <div>
            <span className="mb-1 block text-xs text-zinc-500">Kind</span>
            <div className="grid grid-cols-2 gap-1 rounded-md border border-white/10 bg-black/35 p-1">
              {kinds.map((item) => (
                <button
                  aria-pressed={kind === item}
                  className={`h-8 rounded text-xs font-medium capitalize transition-colors ${kind === item ? "bg-cyan-300/20 text-cyan-100 ring-1 ring-cyan-300/50" : "text-zinc-400 hover:bg-white/5 hover:text-zinc-100"}`}
                  key={item}
                  onClick={() => { set_kind(item); set_page(1); }}
                  type="button"
                >
                  {item === "all" ? "All" : `${item}s`}
                </button>
              ))}
            </div>
          </div>
        </div>
      </aside>
      <section className="ka-panel min-w-0 rounded-xl p-4">
        <div className="mb-4 flex items-center gap-2">
          <Search className="h-4 w-4 text-cyan-300" />
          <input
            className="h-10 w-full rounded-md border border-white/10 bg-black/35 px-3 font-mono text-sm text-zinc-100 outline-none placeholder:text-zinc-600 focus:border-cyan-400/60"
            onChange={(event) => { set_query(event.target.value); set_page(1); }}
            placeholder="Search symbols, structures, RVAs, hashes, or PDB GUIDs"
            value={query}
          />
        </div>
        <div className="mb-2 flex min-h-5 items-center justify-between gap-3 text-xs text-zinc-500">
          <span>{query.trim().length >= 2 && !error ? `${total.toLocaleString()} results` : ""}</span>
          {pages > 1 && <span className="font-mono">{page} / {pages}</span>}
        </div>
        <div className="min-w-0 max-h-[62vh] divide-y divide-white/10 overflow-auto ka-scroll">
          {!loading && results.map((result) => (
            <Link className="flex items-center justify-between gap-4 px-3 py-3 transition-colors hover:bg-white/5" href={result.web_url} key={`${result.kind}_${result.id}`}>
              <div>
                <div className="font-mono text-sm text-zinc-50">{result.name}</div>
                <div className="mt-1 text-xs text-zinc-500">{result.module} / build {result.build} / {result.architecture}</div>
              </div>
              <Badge tone={result.kind === "type" ? "blue" : result.kind === "function" ? "green" : "zinc"}>{result.kind}</Badge>
            </Link>
          ))}
          {loading && <LoadingState compact detail="Matching modules, functions, structures, and PDB metadata" label="Searching KernelArchive" rows={4} />}
          {!loading && error && <div className="m-2 rounded-md border border-red-400/30 bg-red-500/10 p-4 text-sm text-red-100">{error}</div>}
          {!loading && query.trim().length < 2 && <div className="py-10 text-center text-sm text-zinc-500">Start typing</div>}
          {!loading && !error && query.trim().length >= 2 && results.length === 0 && <div className="py-10 text-center text-sm text-zinc-500">No results</div>}
        </div>
        {!loading && !error && pages > 1 && (
          <div className="mt-4 flex items-center justify-between border-t border-white/10 pt-4">
            <Button disabled={page <= 1} icon={<ChevronLeft className="h-4 w-4" />} onClick={() => set_page((value) => Math.max(1, value - 1))}>Previous</Button>
            <Button disabled={page >= pages} icon={<ChevronRight className="h-4 w-4" />} onClick={() => set_page((value) => Math.min(pages, value + 1))}>Next</Button>
          </div>
        )}
      </section>
    </div>
  );
}
