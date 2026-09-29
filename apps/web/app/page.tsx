import type { Metadata } from "next";
import Link from "next/link";
import { ArrowRight, Binary, GitCompare, Search } from "lucide-react";
import { api_data, api_list_all, type BuildCatalogEntry, type CacheStats } from "@/lib/api";
import { build_label, grouped_builds, product_label } from "@/lib/build-family";
import { SiteStructuredData } from "@/components/structured-data";
import { page_metadata } from "@/lib/seo";

// Rendered per request. These pages read the archive through the API, and the
// release build runs with no API up, so allowing them to be prerendered baked an
// empty catalog into the most important page on the site.
export const dynamic = "force-dynamic";

export const metadata: Metadata = page_metadata({
  title: "Windows kernel internals, structure offsets and symbols by build",
  description: "A searchable archive of Windows kernel internals: structure layouts, field offsets, exported functions and byte patterns, each one pinned to an exact Windows build. Look up _EPROCESS, _KTHREAD, ntoskrnl exports and undocumented kernel structures instead of trusting an offset that was right for some other version.",
  path: "/",
  keywords: ["Windows internals", "Windows kernel structures", "undocumented Windows", "kernel data structures", "_EPROCESS offsets", "ntoskrnl symbols", "Windows kernel offsets", "PDB symbol search"],
});

const entry_points = [
  { href: "/explorer", icon: Search, title: "Explore the archive", body: "Drill from a Windows release down to a single driver and the structures it defines." },
  { href: "/search", icon: Binary, title: "Search symbols", body: "Find a structure, field or exported function by name across every indexed build." },
  { href: "/diff", icon: GitCompare, title: "Compare builds", body: "See which structures changed and which offsets moved between two Windows versions." },
];

function stat_row(stats: CacheStats | undefined) {
  return [
    { label: "Windows builds", value: stats?.builds ?? 0 },
    { label: "Kernel modules", value: stats?.modules ?? 0 },
    { label: "Functions", value: stats?.functions ?? 0 },
    { label: "Type definitions", value: stats?.types ?? 0 },
  ];
}

export default async function HomePage() {
  const [catalog, builds] = await Promise.all([
    api_data<{ stats?: CacheStats } | undefined>("/api/v1/catalog", undefined),
    api_list_all<BuildCatalogEntry>("/api/v1/builds/catalog"),
  ]);
  const groups = grouped_builds(builds);

  return (
    <>
      <SiteStructuredData />

      <section className="ka-panel rounded-xl p-6">
        <h1 className="max-w-3xl text-2xl font-semibold leading-tight text-zinc-50">
          Windows kernel internals, pinned to the build they came from
        </h1>
        <p className="mt-4 max-w-3xl text-sm leading-relaxed text-zinc-300">
          Ask anywhere for the offset of a field in <code className="font-mono text-cyan-200">_EPROCESS</code> and
          you will get an answer. It will look right. It may even have been right, for some build, once.
        </p>
        <p className="mt-3 max-w-3xl text-sm leading-relaxed text-zinc-400">
          That is the problem this archive exists to solve. Windows kernel data structures change between
          builds and sometimes between patch levels of the same build, and most of them are undocumented, so an
          offset without a build number attached is a guess. In kernel mode a wrong guess does not raise an
          exception, it bugchecks the machine.
        </p>
        <p className="mt-3 max-w-3xl text-sm leading-relaxed text-zinc-400">
          Every structure layout, function address and byte pattern here was read out of a real binary and its
          matching debug symbols, and every one of them says which Windows build it belongs to. You can look up
          the layout for one exact version and be correct, or find out the field does not exist in it at all.
        </p>

        <div className="mt-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {stat_row(catalog?.stats).map((stat) => (
            <div className="rounded-md border border-white/10 bg-black/30 p-4" key={stat.label}>
              <div className="font-mono text-xl text-cyan-100">{stat.value.toLocaleString()}</div>
              <div className="mt-1 text-xs uppercase tracking-wide text-zinc-500">{stat.label}</div>
            </div>
          ))}
        </div>
      </section>

      <section className="mt-4 grid gap-3 md:grid-cols-3">
        {entry_points.map((entry) => (
          <Link className="ka-panel group rounded-xl p-4 transition-colors hover:border-cyan-400/50" href={entry.href} key={entry.href}>
            <div className="flex items-center gap-2">
              <entry.icon className="h-4 w-4 text-cyan-300" />
              <h2 className="text-sm font-semibold text-zinc-100">{entry.title}</h2>
              <ArrowRight className="h-3.5 w-3.5 text-zinc-600 transition-transform group-hover:translate-x-0.5 group-hover:text-cyan-200" />
            </div>
            <p className="mt-2 text-xs leading-relaxed text-zinc-400">{entry.body}</p>
          </Link>
        ))}
      </section>

      <section className="ka-panel mt-4 rounded-xl p-6">
        <h2 className="text-base font-semibold text-zinc-100">Browse by Windows build</h2>
        <p className="mt-2 max-w-3xl text-sm leading-relaxed text-zinc-400">
          Pick the build you are working against. Each one holds its own kernel modules, exported functions and
          structure definitions at the offsets that build shipped with.
        </p>
        <div className="mt-5 space-y-5">
          {groups.map((group) => (
            <div key={group.family}>
              <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-zinc-400">{group.family}</h3>
              <div className="flex flex-wrap gap-2">
                {group.builds.map((build) => (
                  <Link
                    className="rounded-md border border-white/10 bg-black/30 px-3 py-2 font-mono text-xs text-zinc-300 transition-colors hover:border-cyan-400/50 hover:text-cyan-100"
                    href={`/builds/${build.id}`}
                    key={build.id}
                    title={`${product_label(build)} ${build_label(build)}`}
                  >
                    {build_label(build)}
                  </Link>
                ))}
              </div>
            </div>
          ))}
        </div>
        {groups.length === 0 && (
          <div className="mt-4 rounded-md border border-white/10 bg-black/30 p-6 text-sm text-zinc-500">No builds are indexed yet.</div>
        )}
      </section>
    </>
  );
}
