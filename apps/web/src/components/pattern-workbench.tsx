"use client";

import { useEffect, useState } from "react";
import { ScanSearch } from "lucide-react";
import { Badge, Button } from "@kernelarchive/ui";
import type { ApiEnvelope, FunctionDetailContext, FunctionWithPattern, KernelModule, SearchResult } from "@/lib/api";
import { api_base, api_json, read_api_response } from "@/lib/api";
import type { PatternCrossReferenceRow, PatternResult } from "@kernelarchive/shared";
import { CopyButton } from "./copy-button";
import { LoadingState } from "./loading-state";
import { PatternCrossReferenceTable } from "./pattern-cross-reference-table";

export function PatternWorkbench({ initialFunctionId }: { initialFunctionId?: string }) {
  const [query, set_query] = useState("");
  const [candidates, set_candidates] = useState<SearchResult[]>([]);
  const [selected, set_selected] = useState<FunctionWithPattern | null>(null);
  const [module, set_module] = useState<KernelModule | null>(null);
  const [pattern, set_pattern] = useState<PatternResult | null>(null);
  const [source, set_source] = useState("");
  const [xrefs, set_xrefs] = useState<PatternCrossReferenceRow[]>([]);
  const [error, set_error] = useState("");
  const [xrefs_error, set_xrefs_error] = useState("");
  const [loading, set_loading] = useState(false);
  const [xrefs_loading, set_xrefs_loading] = useState(false);
  const [context_loading, set_context_loading] = useState(false);
  const [search_loading, set_search_loading] = useState(false);
  const [xrefs_requested, set_xrefs_requested] = useState(false);
  const is_multi_build_pattern = pattern ? pattern.tested_builds_json.length > 1 && !pattern.format.startsWith("ida-per-build") : false;

  async function select_function(function_id: string) {
    set_context_loading(true);
    set_selected(null);
    set_module(null);
    set_pattern(null);
    set_source("");
    set_xrefs([]);
    set_xrefs_loading(false);
    set_xrefs_requested(false);
    set_error("");
    set_xrefs_error("");
    try {
      const response = await api_json<FunctionDetailContext>(`/api/v1/functions/${function_id}/context`);
      const context = response.data;
      set_selected(context.fn);
      set_module(context.module);
      set_pattern(context.fn.pattern ?? null);
      set_source(context.fn.pattern ? "pattern-cache" : "");
      set_query(context.fn.name);
    } catch (request_error) {
      set_error(request_error instanceof Error ? request_error.message : "Function lookup failed");
    } finally {
      set_context_loading(false);
    }
  }

  async function load_xrefs(function_id: string) {
    set_xrefs([]);
    set_xrefs_requested(true);
    set_xrefs_loading(true);
    set_xrefs_error("");
    try {
      const response = await api_json<{ rows: PatternCrossReferenceRow[] }>(`/api/v1/functions/${function_id}/pattern/xrefs`);
      set_xrefs(response.data.rows ?? []);
    } catch (request_error) {
      set_xrefs_error(request_error instanceof Error ? request_error.message : "Pattern cross-reference failed");
    } finally {
      set_xrefs_loading(false);
    }
  }

  async function request_pattern(refresh = false) {
    if (!selected || !module) { return; }
    set_loading(true);
    set_error("");
    set_xrefs_error("");
    set_pattern(null);
    set_source("");
    set_xrefs([]);
    set_xrefs_requested(false);
    try {
      const response = await fetch(`${api_base}/api/v1/patterns/request`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({ function_id: selected.id, binary_sha256: module.sha256, refresh }),
      });
      const body = await read_api_response<ApiEnvelope<PatternResult>>(response);
      set_pattern(body.data);
      set_source(body.meta?.source ?? "");
    } catch (request_error) {
      set_error(request_error instanceof Error ? request_error.message : "Pattern request failed");
    } finally {
      set_loading(false);
    }
  }

  useEffect(() => {
    if (initialFunctionId) {
      void select_function(initialFunctionId);
    }
  }, [initialFunctionId]);



  useEffect(() => {
    const normalized = query.trim();
    if (normalized.length < 2 || selected?.name === normalized) {
      set_candidates([]);
      set_search_loading(false);
      return;
    }

    const controller = new AbortController();
    set_search_loading(true);
    const handle = window.setTimeout(() => {
      void api_json<SearchResult[]>(`/api/v1/search?q=${encodeURIComponent(normalized)}&kind=function&limit=20`, { signal: controller.signal })
        .then((response) => {
          if (!controller.signal.aborted) { set_candidates(response.data); }
        })
        .catch(() => {
          if (!controller.signal.aborted) { set_candidates([]); }
        })
        .finally(() => {
          if (!controller.signal.aborted) { set_search_loading(false); }
        });
    }, 150);

    return () => { window.clearTimeout(handle); controller.abort(); };
  }, [query, selected?.name]);

  return (
    <div className="grid min-w-0 gap-4 lg:grid-cols-[380px_minmax(0,1fr)]">
      <aside className="ka-panel min-w-0 rounded-xl p-4">
        <div className="mb-4 flex items-center gap-2">
          <ScanSearch className="h-4 w-4 text-cyan-300" />
          <h1 className="text-base font-semibold">Pattern workspace</h1>
        </div>
        <label className="block">
          <span className="mb-1 block text-xs text-zinc-500">Function, RVA, or symbol</span>
          <input className="h-10 w-full rounded-md border border-white/10 bg-black/35 px-3 font-mono text-sm text-zinc-100 outline-none placeholder:text-zinc-600 focus:border-cyan-300/60" onChange={(event) => set_query(event.target.value)} placeholder="Search indexed functions" value={query} />
        </label>
        {search_loading && <LoadingState className="mt-3" compact detail="Matching cached function symbols" label="Searching indexed functions" rows={2} />}
        <div className="mt-3 max-h-[360px] space-y-2 overflow-auto pr-1 ka-scroll">
          {!search_loading && candidates.map((item) => (
            <button
              className="w-full rounded-md border border-white/10 bg-black/30 px-3 py-2 text-left transition-colors hover:border-cyan-400/60 hover:bg-cyan-300/10"
              disabled={context_loading}
              key={item.id}
              onClick={() => void select_function(item.id)}
              type="button"
            >
              <div className="break-words font-mono text-xs text-zinc-100">{item.name}</div>
              <div className="mt-1 break-words text-xs text-zinc-500">{item.module} / {item.build} / {item.architecture}</div>
            </button>
          ))}
        </div>
        <Button className="mt-4 w-full" disabled={!selected || context_loading || loading || xrefs_loading} onClick={() => void request_pattern(false)} variant="primary">{loading ? "Generating" : "Generate pattern"}</Button>
        {pattern && (
          <Button className="mt-2 w-full" disabled={!selected || context_loading || loading || xrefs_loading} onClick={() => void request_pattern(true)}>{loading ? "Regenerating" : "Refresh pattern"}</Button>
        )}
        {selected && <Button className="mt-2 w-full" disabled={context_loading || loading || xrefs_loading} onClick={() => void load_xrefs(selected.id)}>{xrefs_loading ? "Checking builds" : "Check xrefs"}</Button>}
      </aside>

      <section className="ka-panel relative min-w-0 overflow-hidden rounded-xl p-4">
        {context_loading && <LoadingState detail="Reading cached symbol, module, and pattern metadata" label="Loading function context" rows={3} />}
        {selected && module && (
          <div className="mb-4 min-w-0 rounded-md border border-white/10 bg-black/30 p-3">
            <div className="mb-1 flex flex-wrap items-center gap-2">
              <span className="font-mono text-sm text-zinc-100">{selected.name}</span>
              <Badge tone="blue">{module.name}</Badge>
              <Badge tone="zinc">{selected.rva}</Badge>
              <Badge tone={module.binary_available ?? module.source_path ? "green" : "yellow"}>{module.binary_available ?? module.source_path ? "local binary" : "symbol only"}</Badge>
            </div>
            <div className="break-all text-xs text-zinc-500">{module.sha256}</div>
          </div>
        )}
        {error && <div className="rounded-md border border-red-400/40 bg-red-500/10 p-4 text-sm text-red-200">{error}</div>}
        {xrefs_error && <div className="rounded-md border border-amber-400/40 bg-amber-500/10 p-4 text-sm text-amber-100">{xrefs_error}</div>}
        {loading && <LoadingState detail="Analyzing the indexed local binary" label="Generating function pattern" rows={3} />}
        {xrefs_loading && <LoadingState className="mt-4" detail="Comparing cached coverage across indexed builds" label="Checking build cross-references" rows={4} />}
        {pattern ? (
          <div className="min-w-0 space-y-4">
            <div className="flex flex-wrap gap-2">
              <Badge tone={pattern.status === "excellent" || pattern.status === "good" ? "green" : pattern.status === "risky" ? "yellow" : "red"}>{pattern.status}</Badge>
              <Badge tone="blue">{Math.round(pattern.confidence * 100)}% confidence</Badge>
              <Badge tone="zinc">{pattern.collision_count} collisions</Badge>
              <Badge tone="zinc">{pattern.length} bytes</Badge>
              <Badge tone={is_multi_build_pattern ? "green" : "yellow"}>{is_multi_build_pattern ? `${pattern.tested_builds_json.length} builds` : "per-build"}</Badge>
              {source && <Badge tone={source === "pattern-cache" ? "green" : "blue"}>{source === "pattern-cache" ? "cached" : source === "regenerated" ? "regenerated" : "generated now"}</Badge>}
            </div>
            <pre className="max-h-[280px] min-w-0 max-w-full overflow-auto rounded-md border border-white/10 bg-black/35 p-4 font-mono text-xs text-zinc-200 ka-scroll">{pattern.pattern}</pre>
            <div className="flex flex-wrap gap-2">
              <CopyButton label="Copy IDA pattern" value={pattern.pattern} />
              <CopyButton label="Copy mask" value={pattern.mask} />
            </div>
            {xrefs_requested && !xrefs_loading && <PatternCrossReferenceTable rows={xrefs} />}
          </div>
        ) : !error && !context_loading && (
          <div className="rounded-md border border-white/10 bg-black/30 p-6 text-sm text-zinc-500">No pattern selected.</div>
        )}
        {!pattern && xrefs_requested && !xrefs_loading && <div className="mt-4"><PatternCrossReferenceTable rows={xrefs} /></div>}
      </section>
    </div>
  );
}
