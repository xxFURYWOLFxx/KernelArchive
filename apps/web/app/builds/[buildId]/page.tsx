import Link from "next/link";
import type { Metadata } from "next";
import { build_display_label } from "@kernelarchive/shared";
import { noindex_metadata, page_metadata } from "@/lib/seo";
import { notFound } from "next/navigation";
import { Badge } from "@kernelarchive/ui";
import { MetadataTable } from "@/components/metadata-table";
import { api_data, api_json, api_list_all, type BuildCatalogEntry, type KernelModule, type WindowsBuild } from "@/lib/api";
import { build_label, detection_label } from "@/lib/build-family";
import { module_badge } from "@/lib/module-badge";

const modules_per_page = 50;

// First, last, and a window around the current page, so every page of a large
// build is a couple of hops away instead of a long chain of Next clicks.
function page_numbers(page: number, pages: number) {
  const wanted = new Set<number>([1, pages, page - 1, page, page + 1]);
  for (const step of [10, 50, 100]) {
    wanted.add(Math.max(1, page - step));
    wanted.add(Math.min(pages, page + step));
  }
  return Array.from(wanted).filter((value) => value >= 1 && value <= pages).sort((left, right) => left - right);
}

export async function generateMetadata({ params }: { params: Promise<{ buildId: string }> }): Promise<Metadata> {
  const { buildId } = await params;
  const build = await api_data<WindowsBuild | undefined>(`/api/v1/builds/${buildId}`, undefined);
  if (!build) { return noindex_metadata("Build not found"); }
  const catalog = await api_list_all<BuildCatalogEntry>("/api/v1/builds/catalog");
  const totals = catalog.find((entry) => entry.id === build.id);
  const label = build_display_label(build);
  const description = [
    `Kernel symbols for ${label}.`,
    ` ${(totals?.module_count ?? 0).toLocaleString()} modules,`,
    ` ${(totals?.function_count ?? 0).toLocaleString()} functions and`,
    ` ${(totals?.type_count ?? 0).toLocaleString()} type definitions,`,
    " every offset pinned to this build rather than averaged across versions.",
  ].join("");
  return page_metadata({
    title: `${label} kernel symbols`,
    description,
    path: `/builds/${build.id}`,
    keywords: [label, `${build_label(build)} offsets`, `${build.product_name} kernel symbols`, "ntoskrnl offsets"],
  });
}

export default async function BuildDetailPage({ params, searchParams }: { params: Promise<{ buildId: string }>; searchParams: Promise<{ page?: string }> }) {
  const { buildId } = await params;
  const { page: page_param } = await searchParams;
  const page = Math.max(1, Number.parseInt(page_param ?? "1", 10) || 1);
  const build = await api_data<WindowsBuild | undefined>(`/api/v1/builds/${buildId}`, undefined);
  if (!build) { notFound(); }

  const catalog = await api_list_all<BuildCatalogEntry>("/api/v1/builds/catalog");
  const totals = catalog.find((entry) => entry.id === build.id);
  const build_has_types = (totals?.type_count ?? 0) > 0;
  const modules_response = await api_json<KernelModule[]>(`/api/v1/builds/${build.id}/modules?page=${page}&limit=${modules_per_page}`);
  const modules = modules_response.data;
  const module_total = modules_response.pagination?.total ?? modules.length;
  const pages = Math.max(1, Math.ceil(module_total / modules_per_page));
  const first_index = module_total === 0 ? 0 : (page - 1) * modules_per_page + 1;
  const last_index = Math.min(page * modules_per_page, module_total);

  return (
    <div className="grid gap-4 lg:grid-cols-[360px_1fr]">
        <aside className="ka-panel rounded-xl p-4">
          <div className="mb-3 flex items-center justify-between">
            <h1 className="font-semibold text-zinc-100">{build.product_name}</h1>
            <Badge tone={build.release_channel === "local-system" ? "green" : "blue"}>{build.release_channel}</Badge>
          </div>
          <MetadataTable
            rows={[
              ["Version", detection_label(build.version)],
              ["Build", build_label(build)],
              ["Architecture", build.architecture],
              ["Modules", (totals?.module_count ?? module_total).toLocaleString()],
              ["Symbols", (totals?.symbol_count ?? 0).toLocaleString()],
              ["Functions", (totals?.function_count ?? 0).toLocaleString()],
              ["Created", build.created_at],
            ]}
          />
        </aside>
        <section className="ka-panel rounded-xl p-4">
          <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
            <span className="text-sm font-semibold text-zinc-100">Modules</span>
            <span className="text-xs text-zinc-500">
              {first_index.toLocaleString()}-{last_index.toLocaleString()} of {module_total.toLocaleString()}
            </span>
          </div>
          <div className="max-h-[70vh] divide-y divide-white/10 overflow-auto ka-scroll">
            {modules.map((module) => (
              <Link className="grid gap-3 px-3 py-3 transition-colors hover:bg-white/5 md:grid-cols-[1fr_120px_120px_120px]" href={`/modules/${module.id}`} key={module.id}>
                <div>
                  <div className="font-mono text-sm text-zinc-100">{module.name}</div>
                  <div className="break-all text-xs text-zinc-500">{module.original_path}</div>
                </div>
                <span className="font-mono text-sm text-zinc-400">{Math.round(module.image_size / 1024).toLocaleString()} KB</span>
                <span className="font-mono text-sm text-zinc-400">{module.function_count.toLocaleString()} functions</span>
                {(() => {
                  const badge = module_badge(module, build_has_types);
                  return <Badge title={badge.title} tone={badge.tone}>{badge.label}</Badge>;
                })()}
              </Link>
            ))}
            {modules.length === 0 && <div className="px-3 py-6 text-sm text-zinc-500">No modules are indexed for this build yet.</div>}
          </div>
          {pages > 1 && (
            <div className="mt-3 flex flex-wrap items-center justify-between gap-3 text-sm">
              {page > 1
                ? <Link className="rounded border border-white/10 px-3 py-1.5 text-zinc-300 transition-colors hover:bg-white/5" href={`/builds/${build.id}?page=${page - 1}`}>Previous</Link>
                : <span className="rounded border border-white/5 px-3 py-1.5 text-zinc-600">Previous</span>}
              {/* Numbered links, not just Previous and Next. With a build of 3,000
                  modules the last page was sixty sequential clicks from the first,
                  which is deeper than a crawler will follow. */}
              <div className="flex flex-wrap items-center gap-1.5 text-xs">
                {page_numbers(page, pages).map((value, index, list) => (
                  <span className="flex items-center gap-1.5" key={value}>
                    {index > 0 && list[index - 1] !== value - 1 && <span aria-hidden className="text-zinc-600">...</span>}
                    {value === page
                      ? <span className="rounded border border-cyan-400/50 bg-cyan-300/10 px-2 py-1 text-cyan-100">{value}</span>
                      : <Link className="rounded border border-white/10 px-2 py-1 text-zinc-400 transition-colors hover:border-cyan-300/60 hover:text-cyan-100" href={`/builds/${build.id}?page=${value}`}>{value}</Link>}
                  </span>
                ))}
              </div>
              {page < pages
                ? <Link className="rounded border border-white/10 px-3 py-1.5 text-zinc-300 transition-colors hover:bg-white/5" href={`/builds/${build.id}?page=${page + 1}`}>Next</Link>
                : <span className="rounded border border-white/5 px-3 py-1.5 text-zinc-600">Next</span>}
            </div>
          )}
        </section>
    </div>
  );
}
