"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { Layers3, RefreshCw } from "lucide-react";
import { Badge, Button } from "@kernelarchive/ui";
import { api_list_all, type BuildCatalogEntry } from "@/lib/api";
import { build_label, detection_label, grouped_builds, product_label } from "@/lib/build-family";
import { LoadingState } from "@/components/loading-state";

export default function BuildsPage() {
  const [builds, set_builds] = useState<BuildCatalogEntry[]>([]);
  const [loading, set_loading] = useState(true);
  const [error, set_error] = useState("");
  const [refresh_key, set_refresh_key] = useState(0);
  const build_groups = useMemo(() => grouped_builds(builds), [builds]);
  const module_counts = useMemo(() => new Map(builds.map((build) => [build.id, build.module_count])), [builds]);

  useEffect(() => {
    let cancelled = false;
    set_loading(true);
    set_error("");
    void api_list_all<BuildCatalogEntry>("/api/v1/builds/catalog")
      .then((items) => {
        if (!cancelled) { set_builds(items); }
      })
      .catch((reason: unknown) => {
        if (!cancelled) { set_error(reason instanceof Error ? reason.message : "Build catalog unavailable"); }
      })
      .finally(() => {
        if (!cancelled) { set_loading(false); }
      });
    return () => {
      cancelled = true;
    };
  }, [refresh_key]);

  return (
    <section className="ka-panel relative overflow-hidden rounded-xl p-4">
      <div className="mb-4 flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <Layers3 className="h-4 w-4 text-cyan-300" />
          <h1 className="text-base font-semibold">Indexed builds</h1>
        </div>
        <Button aria-label="Refresh builds" className="w-9 px-0" disabled={loading} icon={<RefreshCw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} />} onClick={() => set_refresh_key((value) => value + 1)} title="Refresh builds" />
      </div>

      {error && <div className="mb-4 rounded-md border border-red-400/30 bg-red-500/10 p-4 text-sm text-red-100">{error}</div>}
      {loading && <LoadingState className="mb-4" compact={builds.length > 0} detail="Reading the shared build catalog" label={builds.length > 0 ? "Refreshing Windows builds" : "Loading Windows builds"} rows={builds.length > 0 ? 0 : 5} />}

      {builds.length > 0 && (
        <div className={`space-y-6 transition-opacity ${loading ? "opacity-55" : "opacity-100"}`}>
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

      {!loading && !error && build_groups.length === 0 && (
        <div className="rounded-md border border-white/10 bg-black/30 p-6 text-sm text-zinc-500">No builds are indexed yet.</div>
      )}
    </section>
  );
}
