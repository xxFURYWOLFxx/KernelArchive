import Link from "next/link";
import { Layers3 } from "lucide-react";
import { Badge } from "@kernelarchive/ui";
import { api_list_all, type BuildCatalogEntry } from "@/lib/api";
import { build_label, detection_label, grouped_builds, product_label } from "@/lib/build-family";
import { RefreshButton } from "@/components/refresh-button";

// Rendered per request. These pages read the archive through the API, and the
// release build runs with no API up, so allowing them to be prerendered baked an
// empty catalog into the most important page on the site.
export const dynamic = "force-dynamic";

// Rendered on the server on purpose. This is the only page that links to every
// indexed build, so when it fetched its own data in the browser there was no
// path a crawler could follow from the site into the archive at all.
export default async function BuildsPage() {
  const builds = await api_list_all<BuildCatalogEntry>("/api/v1/builds/catalog");
  const build_groups = grouped_builds(builds);
  const module_counts = new Map(builds.map((build) => [build.id, build.module_count]));

  return (
    <section className="ka-panel relative overflow-hidden rounded-xl p-4">
      <div className="mb-4 flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <Layers3 className="h-4 w-4 text-cyan-300" />
          <h1 className="text-base font-semibold">Indexed builds</h1>
        </div>
        <RefreshButton label="Refresh builds" />
      </div>

      <p className="mb-5 max-w-3xl text-sm leading-relaxed text-zinc-400">
        Every Windows build indexed here, newest first. Kernel structures move between
        builds and sometimes between patch levels of one build, so each of these holds its
        own copy of the layouts, offsets and exported symbols that build actually shipped.
      </p>

      {build_groups.length > 0 && (
        <div className="space-y-6">
          {build_groups.map((group) => (
            <div key={group.family}>
              <div className="mb-3 flex items-center justify-between gap-3">
                <h2 className="text-sm font-semibold text-zinc-100">{group.family}</h2>
                <span className="text-xs text-zinc-500">{group.builds.length.toLocaleString()} builds</span>
              </div>
              <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
                {group.builds.map((build) => (
                  <Link className="rounded-md border border-white/10 bg-black/30 p-4 transition-colors hover:border-cyan-400/50 hover:bg-cyan-300/10" href={`/builds/${build.id}`} key={build.id}>
                    <div className="mb-2 flex items-center justify-between gap-3">
                      <span className="font-mono font-semibold text-zinc-100">{build_label(build)}</span>
                      <Badge tone={build.release_channel === "local-system" ? "green" : "blue"}>{build.release_channel}</Badge>
                    </div>
                    <div className="text-sm text-zinc-400">{detection_label(product_label(build))}</div>
                    <div className="mt-3 text-sm text-zinc-500">{(module_counts.get(build.id) ?? 0).toLocaleString()} modules indexed</div>
                  </Link>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}

      {build_groups.length === 0 && (
        <div className="rounded-md border border-white/10 bg-black/30 p-6 text-sm text-zinc-500">No builds are indexed yet.</div>
      )}
    </section>
  );
}
