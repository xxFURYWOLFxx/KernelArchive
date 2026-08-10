"use client";

import { useEffect, useState } from "react";
import { ScanSearch } from "lucide-react";
import { Badge, Button } from "@kernelarchive/ui";
import type { KernelFunction, KernelModule, PatternCrossReferenceRow, PatternResult } from "@kernelarchive/shared";
import { api_base, api_json, read_api_response, type ApiEnvelope } from "@/lib/api";
import { CopyButton } from "./copy-button";
import { LoadingState } from "./loading-state";
import { PatternCrossReferenceTable } from "./pattern-cross-reference-table";

export function FunctionPatternCard({ fn, module }: { fn: KernelFunction & { pattern?: PatternResult | null }; module?: KernelModule }) {
  const [pattern, set_pattern] = useState<PatternResult | null>(fn.pattern ?? null);
  const [source, set_source] = useState(fn.pattern ? "pattern-cache" : "");
  const [xrefs, set_xrefs] = useState<PatternCrossReferenceRow[]>([]);
  const [error, set_error] = useState("");
  const [xrefs_error, set_xrefs_error] = useState("");
  const [loading, set_loading] = useState(false);
  const [xrefs_loading, set_xrefs_loading] = useState(false);
  const [xrefs_requested, set_xrefs_requested] = useState(false);
  const can_generate = Boolean(module?.binary_available ?? module?.source_path);
  const is_multi_build_pattern = pattern ? pattern.tested_builds_json.length > 1 && !pattern.format.startsWith("ida-per-build") : false;

  async function load_xrefs() {
    set_xrefs([]);
    set_xrefs_requested(true);
    set_xrefs_loading(true);
    set_xrefs_error("");
    try {
      const response = await api_json<{ rows: PatternCrossReferenceRow[] }>(`/api/v1/functions/${fn.id}/pattern/xrefs`);
      set_xrefs(response.data.rows ?? []);
    } catch (request_error) {
      set_xrefs([]);
      set_xrefs_error(request_error instanceof Error ? request_error.message : "Pattern cross-reference failed");
    } finally {
      set_xrefs_loading(false);
    }
  }

  async function generate(refresh = false) {
    if (!can_generate) {
      set_error("Pattern generation requires an indexed local binary for this module.");
      return;
    }

    set_loading(true);
    set_error("");
    set_xrefs([]);
    set_xrefs_requested(false);
    try {
      const response = await fetch(`${api_base}/api/v1/patterns/request`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ function_id: fn.id, binary_sha256: module?.sha256 ?? "", refresh }),
      });
      const body = await read_api_response<ApiEnvelope<PatternResult>>(response);
      set_pattern(body.data);
      set_source(body.meta?.source ?? "");
    } catch (request_error) {
      set_error(request_error instanceof Error ? request_error.message : "Pattern generation failed");
      set_pattern(null);
    } finally {
      set_loading(false);
    }
  }

  useEffect(() => {
    set_pattern(fn.pattern ?? null);
    set_source(fn.pattern ? "pattern-cache" : "");
    set_xrefs([]);
    set_xrefs_loading(false);
    set_xrefs_requested(false);
    set_error("");
    set_xrefs_error("");
  }, [can_generate, fn.id, fn.pattern]);

  return (
    <section className="ka-panel relative min-w-0 overflow-hidden rounded-xl p-4">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <ScanSearch className="h-4 w-4 text-cyan-300" />
          <h2 className="text-sm font-semibold text-zinc-100">Pattern</h2>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button disabled={loading || xrefs_loading} onClick={() => void load_xrefs()}>{xrefs_loading ? "Checking builds" : "Check builds"}</Button>
          {pattern && (
            <Button disabled={loading || xrefs_loading || !can_generate} onClick={() => void generate(true)}>
              {loading ? "Regenerating" : "Refresh pattern"}
            </Button>
          )}
          <Button disabled={loading || xrefs_loading || !can_generate} onClick={() => void generate(false)} variant="primary">
            {loading ? "Generating" : pattern ? "Generate/check" : "Generate"}
          </Button>
        </div>
      </div>

      {error && <div className="rounded-md border border-red-400/40 bg-red-500/10 p-3 text-sm text-red-200">{error}</div>}
      {xrefs_error && <div className="mb-3 rounded-md border border-amber-400/40 bg-amber-500/10 p-3 text-sm text-amber-100">{xrefs_error}</div>}
      {loading && <LoadingState detail="Analyzing the indexed local binary" label="Generating function pattern" rows={3} />}
      {xrefs_loading && <LoadingState className="mt-3" detail="Comparing cached coverage across indexed builds" label="Checking build cross-references" rows={4} />}

      {pattern ? (
        <div className="min-w-0 space-y-3">
          <div className="flex flex-wrap gap-2">
            <Badge tone={pattern.status === "excellent" || pattern.status === "good" ? "green" : pattern.status === "risky" ? "yellow" : "red"}>{pattern.status}</Badge>
            <Badge tone="blue">{Math.round(pattern.confidence * 100)}% confidence</Badge>
            <Badge tone="zinc">{pattern.collision_count} collisions</Badge>
            <Badge tone="zinc">{pattern.length} bytes</Badge>
            <Badge tone={is_multi_build_pattern ? "green" : "yellow"}>{is_multi_build_pattern ? `${pattern.tested_builds_json.length} builds` : "per-build"}</Badge>
            {source && <Badge tone={source === "pattern-cache" ? "green" : "blue"}>{source === "pattern-cache" ? "cached" : source === "regenerated" ? "regenerated" : "generated now"}</Badge>}
          </div>
          <pre className="max-h-[180px] min-w-0 max-w-full overflow-auto rounded-md border border-white/10 bg-black/35 p-3 font-mono text-xs text-zinc-200 ka-scroll">{pattern.pattern}</pre>
          <div className="flex flex-wrap gap-2">
            <CopyButton label="Copy IDA pattern" value={pattern.pattern} />
            <CopyButton label="Copy mask" value={pattern.mask} />
          </div>
          {xrefs_requested && !xrefs_loading && <PatternCrossReferenceTable rows={xrefs} />}
        </div>
      ) : !error ? (
        <div className="rounded-md border border-white/10 bg-black/30 p-3 text-sm text-zinc-500">
          {can_generate ? "No cached pattern for this function." : "No local binary path is indexed for this module."}
        </div>
      ) : null}
      {!pattern && xrefs_requested && !xrefs_loading && <div className="mt-3"><PatternCrossReferenceTable rows={xrefs} /></div>}
    </section>
  );
}
