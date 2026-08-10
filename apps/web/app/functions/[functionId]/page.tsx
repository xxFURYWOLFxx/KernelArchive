import Link from "next/link";
import { notFound } from "next/navigation";
import { Badge } from "@kernelarchive/ui";
import { CopyButton } from "@/components/copy-button";
import { FunctionPatternCard } from "@/components/function-pattern-card";
import { MetadataTable } from "@/components/metadata-table";
import { api_data, type FunctionDetailContext } from "@/lib/api";
import { build_label } from "@/lib/build-family";
import { function_signature, has_function_prototype, parse_hex, section_for_rva } from "@kernelarchive/shared";
import type { KernelFunction } from "@kernelarchive/shared";

function symbol_source_label(fn: KernelFunction) {
  if (fn.symbol_kind === "pe-export") { return "PE export table"; }
  if (fn.symbol_kind === "pdb-public") { return "PDB public symbols"; }
  if (fn.symbol_kind === "pdb-function") { return "PDB function symbols"; }
  return fn.is_exported ? "PE export table" : "unknown";
}

// Argument lists need DIA type records. Microsoft ships stripped public PDBs for
// most binaries, so a symbol can be PDB-sourced and still have no parameters.
function signature_origin_note(fn: KernelFunction) {
  if (fn.symbol_kind === "pe-export") {
    return "This symbol came from the PE export table. RVA, section, and pattern generation are available; argument types require PDB type records.";
  }
  if (fn.symbol_kind === "pdb-public") {
    return "This symbol came from the PDB public symbol table, which stores names and addresses but no type records. RVA, section, and pattern generation are available; argument types are not published for this binary.";
  }
  if (fn.symbol_kind === "pdb-function") {
    return "This symbol came from the PDB function symbols, but this PDB ships without type records, so no parameter or return types are published. RVA, section, and pattern generation are available.";
  }
  return "No prototype is published for this symbol. RVA, section, and pattern generation are available; argument types require PDB type records.";
}

export default async function FunctionDetailPage({ params }: { params: Promise<{ functionId: string }> }) {
  const { functionId } = await params;
  const context = await api_data<FunctionDetailContext | undefined>(`/api/v1/functions/${functionId}/context`, undefined);
  if (!context) { notFound(); }
  const { fn } = context;
  const module = context.module ?? undefined;
  const build = context.build ?? undefined;
  const signature = function_signature(fn);
  const has_prototype = has_function_prototype(fn);
  const section = section_for_rva(module, parse_hex(fn.rva));

  return (
    <div className="grid min-w-0 gap-4 lg:grid-cols-[380px_minmax(0,1fr)]">
        <aside className="ka-panel min-w-0 rounded-xl p-4">
          <div className="mb-3 flex flex-wrap items-center gap-2">
            <h1 className="break-all font-mono text-base text-zinc-100">{fn.name}</h1>
            <Badge tone={fn.is_exported ? "blue" : "zinc"}>{fn.is_exported ? "export" : "internal"}</Badge>
          </div>
          <MetadataTable
            rows={[
              ["Module", module?.name ?? fn.module_id],
              ["Build", build ? build_label(build) : "Detection required"],
              ["RVA", fn.rva],
              ["Size", fn.size],
              ["Section", section?.name ?? "n/a"],
              ["Return", has_prototype ? fn.return_type : "not published"],
              ["Calling convention", has_prototype ? fn.calling_convention : "not published"],
              ["Symbol source", symbol_source_label(fn)],
              ["Confidence", `${Math.round(fn.confidence * 100)}%`],
            ]}
          />
          <div className="mt-4 flex flex-wrap gap-2">
            <CopyButton label="Copy name" value={fn.name} />
            <CopyButton label="Copy RVA" value={fn.rva} />
            <CopyButton label="Copy prototype" value={signature} />
          </div>
        </aside>
        <section className="min-w-0 space-y-4">
          <FunctionPatternCard fn={fn} module={module} />

          <div className="ka-panel min-w-0 rounded-xl p-4">
            <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
              <div className="text-sm font-semibold text-zinc-100">Signature</div>
              <div className="flex flex-wrap gap-2">
                <CopyButton label="Copy prototype" value={signature} />
                <CopyButton label="Copy name" value={fn.name} />
                <CopyButton label="Copy RVA" value={fn.rva} />
              </div>
            </div>
            <pre className="min-w-0 max-w-full overflow-auto rounded-md border border-white/10 bg-black/35 p-3 font-mono text-xs text-zinc-200 ka-scroll">{signature}</pre>
            {!has_prototype && (
              <div className="mt-3 rounded-md border border-amber-400/30 bg-amber-500/10 p-3 text-sm text-amber-100">
                {signature_origin_note(fn)}
              </div>
            )}
          </div>

          <div className="ka-panel rounded-xl p-4">
            <div className="mb-3 text-sm font-semibold text-zinc-100">Actions</div>
            <div className="flex flex-wrap gap-2">
              {module && <Link className="rounded-md border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-zinc-100 hover:bg-zinc-800" href={`/modules/${module.id}`}>Open module</Link>}
              <Link className="rounded-md border border-cyan-400/60 bg-cyan-400/15 px-3 py-2 text-sm text-cyan-100 hover:bg-cyan-400/25" href={`/patterns?function=${fn.id}`}>Generate pattern</Link>
              <Link className="rounded-md border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-zinc-100 hover:bg-zinc-800" href={`/api-docs`}>API docs</Link>
            </div>
          </div>

          <details className="ka-panel min-w-0 rounded-xl">
            <summary className="cursor-pointer px-4 py-3 text-sm font-semibold text-zinc-100">Advanced function metadata</summary>
            <div className="space-y-4 border-t border-zinc-800 p-4">
              <MetadataTable
                rows={[
                  ["Function ID", fn.id],
                  ["Symbol", fn.symbol_id],
                  ["API URL", `/api/v1/functions/${fn.id}`],
                ]}
              />
              <div>
                <div className="mb-3 text-sm font-semibold text-zinc-100">Parameters</div>
                {fn.parameters_json.length === 0 ? (
                  <div className="rounded-md border border-zinc-800 bg-zinc-950 p-4 text-sm text-zinc-500">No function parameter records are available yet.</div>
                ) : (
                  <div className="divide-y divide-zinc-800 rounded-md border border-zinc-800 bg-zinc-950">
                    {fn.parameters_json.map((param) => (
                      <div className="grid grid-cols-[112px_minmax(0,1fr)] px-3 py-2 font-mono text-xs text-zinc-300 sm:grid-cols-[180px_minmax(0,1fr)]" key={param.name}>
                        <span className="break-words">{param.name}</span>
                        <span className="min-w-0 break-words">{param.type}</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          </details>
        </section>
    </div>
  );
}
