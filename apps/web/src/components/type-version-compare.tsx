"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { ArrowRight, ChevronDown, GitCompare } from "lucide-react";
import { Badge, Button } from "@kernelarchive/ui";
import type { TypeCompareLine, TypeCompareResult, TypeCompareStep } from "@kernelarchive/shared";
import { api_json } from "@/lib/api";
import { LoadingState } from "./loading-state";

const empty_compare: TypeCompareResult = {
  type_id: "",
  type_name: "",
  occurrences: [],
  steps: [],
};
const diff_page_size = 80;

function line_class(line: TypeCompareLine) {
  return line.kind === "added"
    ? "border-emerald-400/20 bg-emerald-500/10 text-emerald-100"
    : "border-red-400/20 bg-red-500/10 text-red-100";
}

function line_prefix(line: TypeCompareLine) {
  return line.kind === "added" ? "+" : "-";
}

function TypeCompareStepPanel({ initialOpen, step }: { initialOpen: boolean; step: TypeCompareStep }) {
  const [visible_count, set_visible_count] = useState(diff_page_size);
  const visible_lines = step.lines.slice(0, visible_count);

  return (
    <details className="group overflow-hidden rounded-md border border-white/10 bg-black/30" open={initialOpen}>
      <summary className="flex cursor-pointer list-none flex-wrap items-center justify-between gap-3 px-3 py-3">
        <div className="flex min-w-0 items-center gap-2 text-sm text-zinc-100">
          <span className="truncate">{step.from.version}</span>
          <ArrowRight className="h-4 w-4 shrink-0 text-zinc-500" />
          <span className="truncate">{step.to.version}</span>
          <ChevronDown className="h-4 w-4 shrink-0 text-zinc-500 transition-transform group-open:rotate-180" />
        </div>
        <div className="flex flex-wrap gap-2">
          <Badge tone={step.additions > 0 ? "green" : "zinc"}>+{step.additions}</Badge>
          <Badge tone={step.removals > 0 ? "red" : "zinc"}>-{step.removals}</Badge>
          <Badge tone={step.modifications > 0 ? "yellow" : "zinc"}>{step.modifications} changed</Badge>
        </div>
      </summary>
      <div className="border-t border-white/10 px-3 py-2 text-xs text-zinc-500">
        {step.from.build_number}.{step.from.revision} {step.from.module_name} to {step.to.build_number}.{step.to.revision} {step.to.module_name}
      </div>
      {step.lines.length > 0 ? (
        <>
          <div className="max-h-[360px] overflow-auto ka-scroll">
            {visible_lines.map((line, line_index) => (
              <div className={`grid grid-cols-[34px_1fr] border-b px-3 py-2 font-mono text-xs last:border-b-0 ${line_class(line)}`} key={`${line.pair_id}_${line.kind}_${line_index}`}>
                <span>{line_prefix(line)}</span>
                <span className="break-all">{line.text}</span>
              </div>
            ))}
          </div>
          {visible_count < step.lines.length && (
            <div className="flex justify-center border-t border-white/10 p-3">
              <Button icon={<ChevronDown className="h-4 w-4" />} onClick={() => set_visible_count((count) => count + diff_page_size)}>
                Show {Math.min(diff_page_size, step.lines.length - visible_count)} more
              </Button>
            </div>
          )}
        </>
      ) : (
        <div className="border-t border-white/10 p-4 text-sm text-zinc-500">No field changes.</div>
      )}
    </details>
  );
}

export function TypeCrossReference({ typeId }: { typeId: string }) {
  const [compare, set_compare] = useState<TypeCompareResult>(empty_compare);
  const [loading, set_loading] = useState(false);
  const [requested, set_requested] = useState(false);
  const [error, set_error] = useState("");
  const request_version = useRef(0);

  useEffect(() => {
    request_version.current += 1;
    set_compare(empty_compare);
    set_loading(false);
    set_requested(false);
    set_error("");
  }, [typeId]);

  async function load_compare() {
    const version = request_version.current + 1;
    request_version.current = version;
    set_requested(true);
    set_loading(true);
    set_error("");
    try {
      const result = await api_json<TypeCompareResult>(`/api/v1/types/${typeId}/xrefs`);
      if (request_version.current === version) { set_compare(result.data); }
    } catch (reason) {
      if (request_version.current === version) {
        set_compare(empty_compare);
        set_error(reason instanceof Error ? reason.message : "Structure cross-reference unavailable");
      }
    } finally {
      if (request_version.current === version) { set_loading(false); }
    }
  }

  return (
    <section className="ka-panel min-w-0 rounded-xl p-4" data-testid="type-cross-reference">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <GitCompare className="h-4 w-4 text-cyan-300" />
          <h2 className="text-sm font-semibold text-zinc-100">Structure cross-reference</h2>
        </div>
        <div className="flex items-center gap-2">
          {requested && <Badge tone={compare.occurrences.length > 1 ? "green" : "zinc"}>{loading ? "Loading" : `${compare.occurrences.length} versions`}</Badge>}
          <Button disabled={loading} icon={<GitCompare className="h-4 w-4" />} onClick={() => void load_compare()} variant="primary">
            {loading ? "Cross-referencing" : requested ? "Run again" : "Cross-reference"}
          </Button>
        </div>
      </div>

      {!requested && <div className="rounded-md border border-white/10 bg-black/30 p-4 text-sm text-zinc-500">Structure cross-reference has not been requested.</div>}
      {loading && <LoadingState detail="Matching this structure in the same module across indexed Windows builds" label="Cross-referencing structure versions" rows={4} />}
      {!loading && requested && error && <div className="rounded-md border border-red-400/20 bg-red-500/10 p-4 text-sm text-red-100">{error}</div>}
      {!loading && requested && !error && compare.occurrences.length < 2 && (
        <div className="rounded-md border border-white/10 bg-black/30 p-4 text-sm text-zinc-400">No other indexed version of this module contains this structure.</div>
      )}

      {!loading && requested && !error && compare.occurrences.length > 1 && (
        <>
          <div className="mb-4 flex gap-2 overflow-x-auto pb-1 ka-scroll">
            {compare.occurrences.map((occurrence) => (
              <Link
                className={`min-w-[190px] rounded-md border p-3 transition-colors hover:border-cyan-300/60 hover:bg-cyan-300/10 ${occurrence.type_id === typeId ? "border-cyan-300/40 bg-cyan-300/10" : "border-white/10 bg-black/30"}`}
                href={`/types/${occurrence.type_id}`}
                key={`${occurrence.build_id}_${occurrence.type_id}`}
              >
                <div className="font-semibold text-zinc-100">{occurrence.version}</div>
                <div className="mt-1 font-mono text-xs text-zinc-400">{occurrence.build_number}.{occurrence.revision} {occurrence.architecture}</div>
                <div className="mt-2 truncate text-xs text-zinc-500">{occurrence.module_name}</div>
                <div className="mt-2 flex gap-2">
                  <Badge tone="blue">0x{occurrence.size.toString(16)}</Badge>
                  <Badge tone="zinc">{occurrence.field_count} fields</Badge>
                </div>
              </Link>
            ))}
          </div>

          <div className="space-y-3">
            {compare.steps.map((step, index) => (
              <TypeCompareStepPanel initialOpen={index === 0} key={`${step.from.type_id}_${step.to.type_id}`} step={step} />
            ))}
          </div>
        </>
      )}
    </section>
  );
}
