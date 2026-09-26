import Link from "next/link";
import type { Metadata } from "next";
import { build_context_label, noindex_metadata, page_metadata } from "@/lib/seo";
import { notFound } from "next/navigation";
import { CopyButton } from "@/components/copy-button";
import { MetadataTable } from "@/components/metadata-table";
import { ModuleAdvancedDetails } from "@/components/module-advanced-details";
import { ModuleDownloadLink } from "@/components/module-download-link";
import { ModulePackageLink } from "@/components/module-package-link";
import { ModulePdbNotice } from "@/components/module-pdb-notice";
import { ModuleSymbols } from "@/components/module-symbols";
import type { ModulePdbStatus } from "@kernelarchive/shared";
import { api_data, api_list_all, type BuildCatalogEntry, type ModuleDetailContext } from "@/lib/api";
import { build_label, product_label } from "@/lib/build-family";

export async function generateMetadata({ params }: { params: Promise<{ moduleId: string }> }): Promise<Metadata> {
  const { moduleId } = await params;
  const context = await api_data<ModuleDetailContext | undefined>(`/api/v1/modules/${moduleId}/context`, undefined);
  if (!context) { return noindex_metadata("Module not found"); }
  const { module } = context;
  const where = build_context_label(context.build ?? undefined);
  const title = `${module.name} symbols${where ? ` (${where})` : ""}`;
  const description = [
    `Exported functions, symbols and type layouts extracted from ${module.name}`,
    where ? ` in ${where}` : "",
    `. ${module.function_count.toLocaleString()} functions and ${module.type_count.toLocaleString()} types, keyed to SHA-256 ${module.sha256.slice(0, 16)}.`,
  ].join("");
  return page_metadata({
    title,
    description,
    path: `/modules/${module.id}`,
    keywords: [module.name, `${module.name} exports`, `${module.name} symbols`, `${module.name} offsets`, where].filter(Boolean),
  });
}

export default async function ModuleDetailPage({ params }: { params: Promise<{ moduleId: string }> }) {
  const { moduleId } = await params;
  const context = await api_data<ModuleDetailContext | undefined>(`/api/v1/modules/${moduleId}/context`, undefined);
  if (!context) { notFound(); }
  const { module } = context;
  const build_catalog = await api_list_all<BuildCatalogEntry>("/api/v1/builds/catalog");
  const build_has_types = (build_catalog.find((entry) => entry.id === module.build_id)?.type_count ?? 0) > 0;
  const pdb = context.pdb ?? await api_data<ModulePdbStatus>(
    `/api/v1/modules/${module.id}/pdb`,
    {
      module_id: module.id,
      status: "unchecked",
      available: false,
      checking: false,
      can_retry: false,
      requires_admin: true,
      provider: "Symbol server",
      message: "PDB status is temporarily unavailable.",
    },
  );
  const build = context.build ?? undefined;

  return (
    <div className="space-y-4">
      <ModulePdbNotice initial_status={pdb} module_id={module.id} />

      <div className="grid min-w-0 gap-4 xl:grid-cols-[380px_minmax(0,1fr)]">
        <aside className="ka-panel min-w-0 rounded-xl p-4 xl:sticky xl:top-28 xl:self-start">
          <h1 className="mb-3 font-mono text-base text-zinc-100">{module.name}</h1>
          <MetadataTable
            rows={[
              ["Build", build ? `${product_label(build)} / ${build_label(build)}` : module.build_id],
              ["Machine", module.machine ?? build?.architecture ?? "Not detected"],
              ["Image base", module.image_base],
              ["Entry point", module.entry_point ?? "Not present"],
              ["Functions", module.function_count],
              ["Types", module.type_count],
              ["PDB", pdb.pdb_name ?? "No CodeView record"],
            ]}
          />
          <div className="mt-4 flex flex-wrap gap-2">
            <CopyButton label="Copy path" value={module.original_path} />
            <CopyButton label="Copy SHA256" value={module.sha256} />
            <ModuleDownloadLink available={module.binary_available} module_id={module.id} />
            <ModulePackageLink module_name={module.name} />
            {build && <Link className="inline-flex rounded-md border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-zinc-100 hover:bg-zinc-800" href={`/builds/${build.id}`}>Open build</Link>}
          </div>
        </aside>

        <section className="min-w-0 space-y-4">
          <ModuleSymbols buildHasTypes={build_has_types} buildId={module.build_id} functionCount={module.function_count} moduleId={module.id} typeCount={module.type_count} />
          <ModuleAdvancedDetails module={module} />
        </section>
      </div>
    </div>
  );
}
