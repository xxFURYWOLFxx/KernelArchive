"use client";

import { useEffect, useMemo, useState } from "react";
import { GitCompare, Plus, Search, Sigma } from "lucide-react";
import { Badge, Button } from "@kernelarchive/ui";
import type { DiffResult, EntityKind } from "@kernelarchive/shared";
import { grouped_builds } from "@/lib/build-family";
import { api_json, api_list_all, type SearchResult, type WindowsBuild } from "@/lib/api";
import { LoadingState } from "./loading-state";

type DiffKind = "type" | "function" | "module";

const kind_to_search: Record<DiffKind, EntityKind> = {
  type: "type",
  function: "function",
  module: "module",
};
const diff_kinds: DiffKind[] = ["function", "module", "type"];

const empty_diff: DiffResult = {
  entity_kind: "function",
  entity_name: "",
  from_build_id: "",
  to_build_id: "",
  summary: "Choose an indexed entity and two builds.",
  changes: [],
};

export function DiffWorkbench() {
  const [kind, set_kind] = useState<DiffKind>("function");
  const [name, set_name] = useState("");
  const [selected_name, set_selected_name] = useState("");
  const [from_build_id, set_from_build_id] = useState("");
  const [to_build_id, set_to_build_id] = useState("");
  const [builds, set_builds] = useState<WindowsBuild[]>([]);
  const [candidates, set_candidates] = useState<SearchResult[]>([]);
  const [diff, set_diff] = useState<DiffResult>(empty_diff);
  const [loading, set_loading] = useState(false);
  const [search_loading, set_search_loading] = useState(false);
  const [requested, set_requested] = useState(false);
  const [error, set_error] = useState("");
  const build_groups = useMemo(() => grouped_builds(builds), [builds]);
  const result_kind = requested ? diff.entity_kind : kind;

  useEffect(() => {
    void api_list_all<WindowsBuild>("/api/v1/builds").then((items) => {
      set_builds(items);
      set_from_build_id(items[1]?.id ?? items[0]?.id ?? "");
      set_to_build_id(items[0]?.id ?? "");
    });
  }, []);

  useEffect(() => {
    const normalized = name.trim();
    if (normalized.length < 2 || normalized === selected_name) {
      set_candidates([]);
      set_search_loading(false);
      return;
    }

    const controller = new AbortController();
    set_search_loading(true);
    const handle = window.setTimeout(() => {
      const params = new URLSearchParams({ q: normalized, kind: kind_to_search[kind], limit: "20" });
      void api_json<SearchResult[]>(`/api/v1/search?${params.toString()}`, { signal: controller.signal })
        .then((response) => {
          if (!controller.signal.aborted) { set_candidates(response.data); }
        })
        .catch(() => {
          if (!controller.signal.aborted) { set_candidates([]); }
        })
        .finally(() => {
          if (!controller.signal.aborted) { set_search_loading(false); }
        });
    }, 160);

    return () => { window.clearTimeout(handle); controller.abort(); };
  }, [kind, name, selected_name]);

  async function run_compare() {
    const normalized = (selected_name || name).trim();
    if (!normalized || !from_build_id || !to_build_id) { return; }
    const endpoint = kind === "type" ? "types" : kind === "module" ? "modules" : "functions";
    const params = new URLSearchParams({ name: normalized, from: from_build_id, to: to_build_id });
    set_selected_name(normalized);
    set_name(normalized);
    set_candidates([]);
    set_requested(true);
    set_loading(true);
    set_error("");
    try {
      const response = await api_json<DiffResult>(`/api/v1/diff/${endpoint}?${params.toString()}`);
      set_diff(response.data);
    } catch (reason) {
      set_diff(empty_diff);
      set_error(reason instanceof Error ? reason.message : "Comparison unavailable");
    } finally {
      set_loading(false);
    }
  }

  return (
    <div className="grid min-w-0 gap-4 lg:grid-cols-[360px_minmax(0,1fr)]">
      <aside className="ka-panel min-w-0 rounded-xl p-4">
        <div className="mb-4 flex items-center gap-2">
          <GitCompare className="h-4 w-4 text-cyan-300" />
          <h1 className="text-base font-semibold">Compare</h1>
        </div>
        <div className="space-y-3">
          <div>
            <span className="mb-1 block text-xs text-zinc-500">Kind</span>
            <div className="grid grid-cols-3 gap-1 rounded-md border border-white/10 bg-black/35 p-1">
              {diff_kinds.map((item) => (
                <button
                  aria-pressed={kind === item}
                  className={`h-8 rounded text-xs font-medium capitalize transition-colors ${kind === item ? "bg-cyan-300/20 text-cyan-100 ring-1 ring-cyan-300/50" : "text-zinc-400 hover:bg-white/5 hover:text-zinc-100"}`}
                  key={item}
                  onClick={() => {
                    set_kind(item);
                    set_name("");
                    set_selected_name("");
                    set_candidates([]);
                    set_diff(empty_diff);
                    set_requested(false);
                    set_error("");
                  }}
                  type="button"
                >
                  {item}
                </button>
              ))}
            </div>
          </div>
          <label className="block">
            <span className="mb-1 block text-xs text-zinc-500">Entity</span>
            <div className="relative">
              <Search className="pointer-events-none absolute left-3 top-2.5 h-4 w-4 text-zinc-500" />
              <input className="h-9 w-full rounded-md border border-white/10 bg-black/35 pl-9 pr-2 font-mono text-sm text-zinc-100 outline-none focus:border-cyan-300/60" onChange={(event) => {
                set_selected_name("");
                set_name(event.target.value);
                set_diff(empty_diff);
                set_requested(false);
                set_error("");
              }} placeholder="Search live symbols" value={name} />
            </div>
          </label>
          {search_loading && <LoadingState compact detail="Matching cached symbols for this entity kind" label="Searching indexed entities" rows={2} />}
          {!search_loading && candidates.length > 0 && (
            <div className="max-h-[240px] overflow-auto rounded-md border border-white/10 bg-black/30 ka-scroll">
              {candidates.map((item) => (
                <button className="block w-full border-b border-white/10 px-3 py-2 text-left last:border-b-0 hover:bg-white/5" key={item.id} onClick={() => {
                  set_selected_name(item.name);
                  set_name(item.name);
                  set_candidates([]);
                  set_diff(empty_diff);
                  set_requested(false);
                  set_error("");
                }} type="button">
                  <div className="font-mono text-xs text-zinc-100">{item.name}</div>
                  <div className="mt-1 text-xs text-zinc-500">{item.module} / {item.build}</div>
                </button>
              ))}
            </div>
          )}
          <Button className="w-full" disabled={name.trim().length < 2 || !from_build_id || !to_build_id || loading || search_loading} onClick={() => void run_compare()} variant="primary">
            {loading ? "Comparing" : "Compare"}
          </Button>
          {([
            ["From", from_build_id, set_from_build_id],
            ["To", to_build_id, set_to_build_id],
          ] as const).map(([label, value, setter]) => (
            <label className="block" key={label}>
              <span className="mb-1 block text-xs text-zinc-500">{label}</span>
              <select className="ka-select h-9 w-full rounded-md border border-white/10 px-2 text-zinc-100 outline-none focus:border-cyan-300/60" onChange={(event) => {
                setter(event.target.value);
                set_diff(empty_diff);
                set_requested(false);
                set_error("");
              }} value={value}>
                {build_groups.map((group) => (
                  <optgroup key={group.family} label={group.family}>
                    {group.builds.map((build) => <option key={build.id} value={build.id}>{build.version} / {build.build_number}.{build.revision} / {build.architecture}</option>)}
                  </optgroup>
                ))}
              </select>
            </label>
          ))}
        </div>
      </aside>
      <section className="ka-panel relative min-w-0 overflow-hidden rounded-xl p-4">
        <div className="mb-4 flex items-center justify-between gap-3">
          <div className="flex min-w-0 items-center gap-2">
            <GitCompare className="h-4 w-4 shrink-0 text-cyan-300" />
            <h2 className="truncate font-mono text-sm text-zinc-50">{diff.entity_name || selected_name || "No entity selected"}</h2>
          </div>
          <Badge tone={result_kind === "type" ? "blue" : result_kind === "function" ? "green" : "zinc"}>{result_kind}</Badge>
        </div>
        <p className="mb-4 text-sm text-zinc-400">{loading ? "Comparing indexed local data." : error || (requested ? diff.summary : "Comparison not requested.")}</p>
        {loading && <LoadingState detail={`Comparing ${result_kind} data across the selected builds`} label="Comparing indexed versions" rows={4} />}
        {!loading && error && <div className="mb-3 rounded-md border border-red-400/30 bg-red-500/10 p-3 text-sm text-red-100">{error}</div>}
        <div className="space-y-2">
          {!loading && diff.changes.map((change) => (
            <div key={`${change.kind}_${change.path}`} className="grid gap-3 rounded border border-white/10 bg-black/30 p-3 text-sm md:grid-cols-[140px_1fr]">
              <div className="flex items-center gap-2 text-zinc-300">
                {change.kind === "size" || change.kind === "image_size" ? <Sigma className="h-4 w-4 text-amber-300" /> : <Plus className="h-4 w-4 text-emerald-300" />}
                {change.kind}
              </div>
              <div className="break-all font-mono text-xs text-zinc-400">{change.path}: {String(change.before)}{" -> "}{String(change.after)}</div>
            </div>
          ))}
          {!loading && requested && diff.changes.length === 0 && <div className="rounded border border-white/10 bg-black/30 p-4 text-sm text-zinc-500">No comparable changes found</div>}
        </div>
      </section>
    </div>
  );
}
