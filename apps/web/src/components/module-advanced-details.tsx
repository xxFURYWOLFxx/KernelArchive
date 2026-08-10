"use client";

import { useEffect, useState } from "react";
import { ChevronDown, LoaderCircle } from "lucide-react";
import { Button } from "@kernelarchive/ui";
import { describe_section_characteristics } from "@kernelarchive/shared";
import type { KernelModule, PeExport, PeImport, PeSection } from "@kernelarchive/shared";
import { api_json } from "@/lib/api";
import { LoadingState } from "./loading-state";
import { MetadataTable } from "./metadata-table";

const page_size = 50;

export function ModuleAdvancedDetails({ module }: { module: KernelModule }) {
  const [open, set_open] = useState(false);
  const [loaded, set_loaded] = useState(false);
  const [loading, set_loading] = useState(false);
  const [loading_more, set_loading_more] = useState("");
  const [error, set_error] = useState("");
  const [sections, set_sections] = useState<PeSection[]>([]);
  const [imports, set_imports] = useState<PeImport[]>([]);
  const [exports, set_exports] = useState<PeExport[]>([]);
  const [section_page, set_section_page] = useState(1);
  const [import_page, set_import_page] = useState(1);
  const [export_page, set_export_page] = useState(1);
  const [section_total, set_section_total] = useState(0);
  const [import_total, set_import_total] = useState(0);
  const [export_total, set_export_total] = useState(0);

  useEffect(() => {
    if (!open || loaded) { return; }
    let cancelled = false;
    set_loading(true);
    set_error("");
    const base = `/api/v1/modules/${module.id}`;
    void Promise.all([
      api_json<PeSection[]>(`${base}/sections?page=1&limit=${page_size}`),
      api_json<PeImport[]>(`${base}/imports?page=1&limit=${page_size}`),
      api_json<PeExport[]>(`${base}/exports?page=1&limit=${page_size}`),
    ]).then(([section_response, import_response, export_response]) => {
      if (cancelled) { return; }
      set_sections(section_response.data);
      set_imports(import_response.data);
      set_exports(export_response.data);
      set_section_total(section_response.pagination?.total ?? section_response.data.length);
      set_import_total(import_response.pagination?.total ?? import_response.data.length);
      set_export_total(export_response.pagination?.total ?? export_response.data.length);
      set_loaded(true);
    }).catch((reason: unknown) => {
      if (!cancelled) { set_error(reason instanceof Error ? reason.message : "PE details unavailable"); }
    }).finally(() => {
      if (!cancelled) { set_loading(false); }
    });

    return () => {
      cancelled = true;
    };
  }, [loaded, module.id, open]);

  async function load_more(kind: "sections" | "imports" | "exports") {
    set_loading_more(kind);
    set_error("");
    try {
      if (kind === "sections") {
        const page = section_page + 1;
        const response = await api_json<PeSection[]>(`/api/v1/modules/${module.id}/sections?page=${page}&limit=${page_size}`);
        set_sections((items) => [...items, ...response.data]);
        set_section_page(page);
      } else if (kind === "imports") {
        const page = import_page + 1;
        const response = await api_json<PeImport[]>(`/api/v1/modules/${module.id}/imports?page=${page}&limit=${page_size}`);
        set_imports((items) => [...items, ...response.data]);
        set_import_page(page);
      } else {
        const page = export_page + 1;
        const response = await api_json<PeExport[]>(`/api/v1/modules/${module.id}/exports?page=${page}&limit=${page_size}`);
        set_exports((items) => [...items, ...response.data]);
        set_export_page(page);
      }
    } catch (reason) {
      set_error(reason instanceof Error ? reason.message : "PE details unavailable");
    } finally {
      set_loading_more("");
    }
  }

  return (
    <details className="group ka-panel min-w-0 rounded-xl" data-testid="module-advanced-details" onToggle={(event) => set_open(event.currentTarget.open)}>
      <summary className="flex cursor-pointer list-none items-center gap-2 px-4 py-3 text-sm font-semibold text-zinc-100">
        Advanced PE details
        <ChevronDown className="h-4 w-4 text-zinc-500 transition-transform group-open:rotate-180" />
      </summary>
      {open && (
        <div className="min-w-0 space-y-4 border-t border-white/10 p-4">
          <MetadataTable
            rows={[
              ["Source", module.source_path ?? module.original_path],
              ["Image size", module.image_size],
              ["Timestamp", module.timestamp],
              ["Checksum", module.checksum],
              ["PDB GUID", module.pdb_guid || "Not present"],
              ["PDB age", module.pdb_age],
              ["SHA256", module.sha256],
            ]}
          />

          {loading && <LoadingState detail="Reading sections, imports, and exports" label="Loading PE details" rows={4} />}
          {!loading && error && <div className="rounded-md border border-red-400/20 bg-red-500/10 p-4 text-sm text-red-100">{error}</div>}
          {!loading && loaded && (
            <>
              <div>
                <div className="mb-2 flex items-center justify-between gap-3 text-xs font-medium text-zinc-500">
                  <span>Sections</span>
                  <span>{section_total.toLocaleString()}</span>
                </div>
                <div className="overflow-auto rounded-md border border-white/10 ka-scroll">
                  {sections.map((section) => (
                    <div className="grid min-w-[520px] grid-cols-[90px_120px_1fr] border-b border-white/10 px-3 py-2 text-xs last:border-b-0" key={`${section.name}_${section.virtual_address}`}>
                      <span className="font-mono text-zinc-200">{section.name}</span>
                      <span className="font-mono text-zinc-400">{section.virtual_address}</span>
                      <span className="text-zinc-400">{section.characteristics_summary ?? describe_section_characteristics(section).summary}</span>
                    </div>
                  ))}
                  {sections.length === 0 && <div className="p-3 text-sm text-zinc-500">No sections indexed.</div>}
                </div>
                {sections.length < section_total && <div className="mt-3 flex justify-center"><Button disabled={Boolean(loading_more)} icon={loading_more === "sections" ? <LoaderCircle className="h-4 w-4 animate-spin" /> : undefined} onClick={() => void load_more("sections")}>{loading_more === "sections" ? "Loading sections" : "Load more sections"}</Button></div>}
              </div>

              <div className="grid min-w-0 gap-4 xl:grid-cols-2">
                <div className="min-w-0">
                  <div className="mb-2 flex items-center justify-between gap-3 text-xs font-medium text-zinc-500">
                    <span>Imports</span>
                    <span>{import_total.toLocaleString()}</span>
                  </div>
                  <div className="max-h-[360px] overflow-auto rounded-md border border-white/10 ka-scroll">
                    {imports.map((item) => (
                      <details className="border-b border-white/10 last:border-b-0" key={item.dll}>
                        <summary className="flex cursor-pointer items-center justify-between gap-3 px-3 py-2 text-xs">
                          <span className="font-mono text-zinc-200">{item.dll}</span>
                          <span className="text-zinc-500">{item.functions.length}</span>
                        </summary>
                        <div className="flex flex-wrap gap-1 border-t border-white/10 p-3">
                          {item.functions.map((name) => <span className="rounded border border-white/10 bg-black/25 px-2 py-1 font-mono text-xs text-zinc-400" key={name}>{name}</span>)}
                        </div>
                      </details>
                    ))}
                    {imports.length === 0 && <div className="p-3 text-sm text-zinc-500">No imports indexed.</div>}
                  </div>
                  {imports.length < import_total && <div className="mt-3 flex justify-center"><Button disabled={Boolean(loading_more)} icon={loading_more === "imports" ? <LoaderCircle className="h-4 w-4 animate-spin" /> : undefined} onClick={() => void load_more("imports")}>{loading_more === "imports" ? "Loading imports" : "Load more imports"}</Button></div>}
                </div>

                <div className="min-w-0">
                  <div className="mb-2 flex items-center justify-between gap-3 text-xs font-medium text-zinc-500">
                    <span>Executable exports</span>
                    <span>{export_total.toLocaleString()}</span>
                  </div>
                  <div className="max-h-[360px] overflow-auto rounded-md border border-white/10 ka-scroll">
                    {exports.map((entry) => (
                      <div className="grid grid-cols-[1fr_110px] border-b border-white/10 px-3 py-2 text-xs last:border-b-0" key={`${entry.name}_${entry.ordinal}`}>
                        <span className="truncate font-mono text-zinc-200">{entry.name}</span>
                        <span className="font-mono text-zinc-500">{entry.rva}</span>
                      </div>
                    ))}
                    {exports.length === 0 && <div className="p-3 text-sm text-zinc-500">No executable exports indexed.</div>}
                  </div>
                  {exports.length < export_total && <div className="mt-3 flex justify-center"><Button disabled={Boolean(loading_more)} icon={loading_more === "exports" ? <LoaderCircle className="h-4 w-4 animate-spin" /> : undefined} onClick={() => void load_more("exports")}>{loading_more === "exports" ? "Loading exports" : "Load more exports"}</Button></div>}
                </div>
              </div>
            </>
          )}
        </div>
      )}
    </details>
  );
}
