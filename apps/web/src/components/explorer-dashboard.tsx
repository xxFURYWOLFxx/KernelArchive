"use client";

import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft, ChevronDown, ChevronRight, Cpu, Database, LoaderCircle, ScanSearch, Search } from "lucide-react";
import { motion } from "framer-motion";
import { Badge, Button } from "@kernelarchive/ui";
import type { Architecture } from "@kernelarchive/shared";
import type { BuildCatalogEntry, CacheStats, CatalogData, KernelModule, WindowsBuild } from "@/lib/api";
import { api_json } from "@/lib/api";
import { build_family, build_family_order, build_label, build_version_title, type BuildFamily } from "@/lib/build-family";
import { module_badge } from "@/lib/module-badge";
import { CopyButton } from "./copy-button";
import { LoadingState } from "./loading-state";
import { ModuleAdvancedDetails } from "./module-advanced-details";
import { ModuleDownloadLink } from "./module-download-link";
import { ModulePackageLink } from "./module-package-link";
import { ModuleSymbols } from "./module-symbols";

const empty_stats: CacheStats = {
  builds: 0,
  modules: 0,
  functions: 0,
  types: 0,
  patterns: 0,
  ingestions: 0,
};

const module_page_size = 48;

const view_motion = {
  initial: { opacity: 0, y: 14 },
  animate: { opacity: 1, y: 0 },
  transition: { duration: 0.35, ease: "easeOut" },
} as const;

const tile_motion = {
  whileHover: { y: -4, scale: 1.01 },
  whileTap: { scale: 0.985 },
  transition: { type: "spring", stiffness: 260, damping: 22 },
} as const;

function empty_state(label: string) {
  return <div className="ka-panel rounded-md p-4 text-sm text-zinc-400">{label}</div>;
}

function build_weight(build: WindowsBuild) {
  const build_number = Number.parseInt(build.build_number, 10);
  const revision = Number.parseInt(build.revision, 10);
  return (Number.isFinite(build_number) ? build_number : 0) * 100000 + (Number.isFinite(revision) ? revision : 0);
}

function module_page_path(build_id: string, page: number, query = "") {
  const parameters = new URLSearchParams({ page: String(page), limit: String(module_page_size) });
  if (query) { parameters.set("q", query); }
  return `/api/v1/builds/${build_id}/modules?${parameters.toString()}`;
}

function PickerShell({ back, children, crumbs, title }: { back?: () => void; children: ReactNode; crumbs?: ReactNode; title: string }) {
  return (
    <div className="ka-bg min-h-screen" style={{ overflowX: "clip" }}>
      <div className="relative z-10 mx-auto flex min-h-screen max-w-6xl flex-col px-5 py-6">
        <header className="flex min-h-10 items-center justify-between gap-4">
          <button className="inline-flex items-center gap-3 text-left" onClick={back} type="button">
            <span className="flex h-10 w-10 items-center justify-center rounded-md border border-cyan-300/35 bg-cyan-300/12">
              <Database className="h-5 w-5 text-cyan-100" />
            </span>
            <span>
              <span className="block text-sm font-semibold text-zinc-50">KernelArchive</span>
              <span className="block text-xs text-zinc-500">local index</span>
            </span>
          </button>
          <div className="hidden items-center gap-2 text-sm text-zinc-400 sm:flex">{crumbs}</div>
        </header>
        <motion.main className="flex flex-1 flex-col items-center justify-center py-12 text-center" {...view_motion}>
          {back && (
            <button className="mb-8 inline-flex h-10 items-center gap-2 rounded-md border border-white/10 bg-black/30 px-4 text-sm text-zinc-100 backdrop-blur transition-colors hover:border-cyan-300/60 hover:bg-cyan-300/10" onClick={back} type="button">
              <ArrowLeft className="h-4 w-4" />
              Back
            </button>
          )}
          <h1 className="text-balance text-4xl font-semibold text-zinc-50 md:text-6xl">{title}</h1>
          <div className="mt-10 w-full">{children}</div>
        </motion.main>
      </div>
    </div>
  );
}

function WorkspaceShell({ children }: { children: ReactNode }) {
  return (
    <div className="ka-bg min-h-screen px-4 py-5" style={{ overflowX: "clip" }}>
      <motion.div className="mx-auto w-full min-w-0 max-w-6xl space-y-4" {...view_motion}>{children}</motion.div>
    </div>
  );
}

// A crumb with onSelect jumps straight to that level. The last crumb is the current
// level, so it is rendered as plain text rather than a control that goes nowhere.
function Crumb({ children, onSelect }: { children: ReactNode; onSelect?: () => void }) {
  return (
    <>
      <ChevronRight className="h-4 w-4 shrink-0 text-zinc-600" />
      {onSelect ? (
        <button
          className="rounded font-mono text-zinc-300 underline decoration-transparent underline-offset-4 transition-colors hover:text-cyan-100 hover:decoration-cyan-300/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-300/60"
          onClick={onSelect}
          type="button"
        >
          {children}
        </button>
      ) : (
        <span aria-current="page" className="font-mono text-zinc-200">{children}</span>
      )}
    </>
  );
}

export function ExplorerDashboard() {
  const pathname = usePathname();
  const search_params = useSearchParams();
  const [stats, set_stats] = useState<CacheStats>(empty_stats);
  const [builds, set_builds] = useState<WindowsBuild[]>([]);
  const [modules, set_modules] = useState<KernelModule[]>([]);
  const [selected_family, set_selected_family] = useState<BuildFamily | undefined>(
    (search_params.get("family") as BuildFamily | null) ?? undefined);
  const [selected_architecture, set_selected_architecture] = useState<Architecture | undefined>(
    (search_params.get("arch") as Architecture | null) ?? undefined);
  const [selected_build_id, set_selected_build_id] = useState(search_params.get("build") ?? "");
  const [build_type_counts, set_build_type_counts] = useState<Map<string, number>>(new Map());
  const [selected_module, set_selected_module] = useState<KernelModule | undefined>();
  const [module_query, set_module_query] = useState("");
  const [module_search, set_module_search] = useState("");
  const [module_page, set_module_page] = useState(1);
  const [module_total, set_module_total] = useState(0);
  const [loading_index, set_loading_index] = useState(true);
  const [loading_modules, set_loading_modules] = useState(false);
  const [loading_more_modules, set_loading_more_modules] = useState(false);
  const [module_error, set_module_error] = useState("");
  const [error, set_error] = useState("");
  const [initial_module_id] = useState(() => search_params.get("module") ?? "");
  const last_written_query = useRef(search_params.toString());
  const [hydrating_module, set_hydrating_module] = useState(Boolean(initial_module_id));
  const selected_build_id_ref = useRef(selected_build_id);
  const module_search_ref = useRef(module_search);
  selected_build_id_ref.current = selected_build_id;
  module_search_ref.current = module_search;

  const family_counts = useMemo(() => build_family_order.map((family) => ({
    family,
    count: builds.filter((build) => build_family(build) === family).length,
  })).filter((item) => item.count > 0), [builds]);

  const family_builds = useMemo(() => selected_family
    ? builds.filter((build) => build_family(build) === selected_family).sort((left, right) => build_weight(right) - build_weight(left))
    : [], [builds, selected_family]);

  const architecture_counts = useMemo(() => Array.from(new Set(family_builds.map((build) => build.architecture))).sort().map((architecture) => ({
    architecture,
    count: family_builds.filter((build) => build.architecture === architecture).length,
  })), [family_builds]);

  const visible_builds = useMemo(() => selected_architecture
    ? family_builds.filter((build) => build.architecture === selected_architecture)
    : [], [family_builds, selected_architecture]);

  const selected_build = useMemo(() => builds.find((build) => build.id === selected_build_id), [builds, selected_build_id]);

  useEffect(() => {
    const controller = new AbortController();
    set_loading_index(true);
    set_error("");
    void api_json<BuildCatalogEntry[]>("/api/v1/builds/catalog?page=1&limit=100", { signal: controller.signal })
      .then((response) => {
        if (controller.signal.aborted) { return; }
        set_build_type_counts(new Map(response.data.map((entry) => [entry.id, entry.type_count])));
      })
      .catch(() => undefined);
    void api_json<CatalogData>("/api/v1/catalog", { signal: controller.signal })
      .then((response) => {
        if (!controller.signal.aborted) {
          set_stats(response.data.stats);
          set_builds(response.data.builds);
        }
      })
      .catch((reason: unknown) => {
        if (!controller.signal.aborted) { set_error(reason instanceof Error ? reason.message : "Build index unavailable"); }
      })
      .finally(() => {
        if (!controller.signal.aborted) { set_loading_index(false); }
      });
    return () => { controller.abort(); };
  }, []);

  useEffect(() => {
    if (!selected_build_id) {
      set_module_search("");
      return;
    }
    const query = module_query.trim();
    const timer = window.setTimeout(() => set_module_search(query), query ? 180 : 0);
    return () => window.clearTimeout(timer);
  }, [module_query, selected_build_id]);

  useEffect(() => {
    if (!selected_build_id) {
      set_modules([]);
      set_module_page(1);
      set_module_total(0);
      set_loading_modules(false);
      return;
    }
    const controller = new AbortController();
    set_loading_modules(true);
    set_loading_more_modules(false);
    set_module_error("");
    set_modules([]);
    set_module_page(1);
    set_module_total(0);
    void api_json<KernelModule[]>(module_page_path(selected_build_id, 1, module_search), { signal: controller.signal })
      .then((response) => {
        if (!controller.signal.aborted) {
          set_modules(response.data);
          set_module_total(response.pagination?.total ?? response.data.length);
        }
      })
      .catch((reason: unknown) => {
        if (!controller.signal.aborted) { set_module_error(reason instanceof Error ? reason.message : "Modules unavailable"); }
      })
      .finally(() => {
        if (!controller.signal.aborted) { set_loading_modules(false); }
      });
    return () => { controller.abort(); };
  }, [module_search, selected_build_id]);

  // Drill-down position lives in the URL so leaving for a function page and
  // pressing browser Back returns here instead of resetting to the first picker.
  useEffect(() => {
    if (hydrating_module) { return; }
    const next = new URLSearchParams();
    if (selected_family) { next.set("family", selected_family); }
    if (selected_architecture) { next.set("arch", selected_architecture); }
    if (selected_build_id) { next.set("build", selected_build_id); }
    if (selected_module) { next.set("module", selected_module.id); }
    if (module_search) { next.set("q", module_search); }
    const query = next.toString();
    if (last_written_query.current === query) { return; }
    last_written_query.current = query;
    // history.replaceState, not router.replace. The router performs a real
    // navigation and fetches an RSC payload for the route, and while that is in
    // flight the previous view is painted again. On localhost that round trip is
    // a few milliseconds and invisible; over a network it is a visible flicker
    // back to the last screen on every click. Nothing here needs the server: the
    // URL is bookkeeping so links are shareable and Back has somewhere to return
    // to, and every reader of it parses the address once at mount.
    window.history.replaceState(window.history.state, "", query ? `${pathname}?${query}` : pathname);
  }, [hydrating_module, module_search, pathname, selected_architecture, selected_build_id, selected_family, selected_module]);

  // Arriving with a module id in the URL gives us no module object, so restore it.
  // This keys off the id captured at mount rather than live search_params: reading
  // the live value would re-run the effect whenever the URL changes, and its cleanup
  // would abort the in-flight fetch the moment the sync effect above rewrites the
  // query. It would also refire after a Back press, restoring what the user cleared.
  useEffect(() => {
    if (!initial_module_id) { return; }
    const controller = new AbortController();
    void api_json<KernelModule>(`/api/v1/modules/${initial_module_id}`, { signal: controller.signal })
      .then((response) => {
        if (!controller.signal.aborted) { set_selected_module(response.data); }
      })
      .catch(() => undefined)
      .finally(() => {
        if (!controller.signal.aborted) { set_hydrating_module(false); }
      });
    return () => { controller.abort(); };
  }, [initial_module_id]);

  function reset_module_selection() {
    set_selected_build_id("");
    set_selected_module(undefined);
    set_modules([]);
    set_module_query("");
    set_module_search("");
    set_module_page(1);
    set_module_total(0);
    set_module_error("");
  }

  function select_build(build_id: string) {
    set_modules([]);
    set_module_query("");
    set_module_search("");
    set_module_page(1);
    set_module_total(0);
    set_module_error("");
    set_selected_build_id(build_id);
  }

  function prefetch_build_modules(build_id: string) {
    void api_json<KernelModule[]>(module_page_path(build_id, 1)).catch(() => undefined);
  }

  async function load_more_modules() {
    if (!selected_build_id || loading_modules || loading_more_modules || modules.length >= module_total) { return; }
    const requested_build_id = selected_build_id;
    const requested_search = module_search;
    const next_page = module_page + 1;
    set_loading_more_modules(true);
    set_module_error("");
    try {
      const response = await api_json<KernelModule[]>(module_page_path(requested_build_id, next_page, module_search));
      if (selected_build_id_ref.current !== requested_build_id || module_search_ref.current !== requested_search) { return; }
      set_modules((current) => {
        const known = new Set(current.map((module) => module.id));
        return [...current, ...response.data.filter((module) => !known.has(module.id))];
      });
      set_module_page(next_page);
      set_module_total(response.pagination?.total ?? modules.length + response.data.length);
    } catch (reason) {
      if (selected_build_id_ref.current === requested_build_id && module_search_ref.current === requested_search) {
        set_module_error(reason instanceof Error ? reason.message : "More modules could not be loaded");
      }
    } finally {
      set_loading_more_modules(false);
    }
  }

  function reset_to_families() {
    set_selected_family(undefined);
    set_selected_architecture(undefined);
    reset_module_selection();
  }

  function select_family(family: BuildFamily) {
    set_selected_family(family);
    set_selected_architecture(undefined);
    reset_module_selection();
  }

  function select_architecture(architecture: Architecture) {
    set_selected_architecture(architecture);
    reset_module_selection();
  }

  if (!selected_family) {
    return (
      <PickerShell title="Windows kernels">
        {loading_index ? (
          <div className="mx-auto max-w-xl text-left">
            <LoadingState detail="Reading the shared build catalog" label="Loading Windows builds" rows={4} />
          </div>
        ) : family_counts.length === 0 ? (
          <div className="mx-auto max-w-md">
            {error
              ? <div className="rounded-md border border-red-400/20 bg-red-500/10 p-4 text-sm text-red-100">{error}</div>
              : empty_state("No indexed builds.")}
          </div>
        ) : (
          <div className={family_counts.length === 1 ? "mx-auto grid w-full max-w-md gap-3" : "mx-auto grid max-w-3xl gap-3 sm:grid-cols-2"}>
            {family_counts.map((item) => (
              <motion.button className="ka-tile rounded-xl p-6 text-left transition-colors hover:border-cyan-200/70" key={item.family} onClick={() => select_family(item.family)} type="button" {...tile_motion}>
                <div className="flex items-start justify-between gap-4">
                  <div>
                    <div className="text-2xl font-semibold text-zinc-50">{item.family}</div>
                    <div className="mt-3 font-mono text-sm text-cyan-100">{item.count.toLocaleString()} builds</div>
                  </div>
                  <ChevronRight className="h-5 w-5 text-cyan-100/70" />
                </div>
              </motion.button>
            ))}
          </div>
        )}
      </PickerShell>
    );
  }

  if (!selected_architecture) {
    return (
      <PickerShell back={reset_to_families} crumbs={<Crumb>{selected_family}</Crumb>} title={selected_family}>
        {/* Columns track the number of architectures. A fixed three-column grid
            holding two tiles leaves the third column empty, and the pair reads as
            shifted left even though the grid itself is centred. */}
        <div className={`mx-auto grid gap-3 ${architecture_counts.length === 1
          ? "w-full max-w-sm"
          : architecture_counts.length === 2
            ? "max-w-2xl sm:grid-cols-2"
            : "max-w-3xl sm:grid-cols-3"}`}>
          {architecture_counts.map((item) => (
            <motion.button className="ka-tile rounded-xl px-6 py-8 text-center transition-colors hover:border-emerald-200/70" key={item.architecture} onClick={() => select_architecture(item.architecture)} type="button" {...tile_motion}>
              <Cpu className="mx-auto mb-4 h-6 w-6 text-emerald-100/80" />
              <div className="font-mono text-5xl font-semibold text-zinc-50">{item.architecture}</div>
              <div className="mt-3 font-mono text-sm text-emerald-100">{item.count.toLocaleString()} builds</div>
            </motion.button>
          ))}
        </div>
      </PickerShell>
    );
  }

  if (!selected_build) {
    return (
      <PickerShell back={() => set_selected_architecture(undefined)} crumbs={<><Crumb onSelect={() => select_family(selected_family)}>{selected_family}</Crumb><Crumb>{selected_architecture}</Crumb></>} title="Builds">
        <div className="mx-auto grid max-w-4xl gap-3 md:grid-cols-2">
          {visible_builds.map((build) => (
            <motion.button className="ka-tile rounded-xl p-5 text-left transition-colors hover:border-cyan-200/70" key={build.id} onClick={() => select_build(build.id)} onFocus={() => prefetch_build_modules(build.id)} onMouseEnter={() => prefetch_build_modules(build.id)} type="button" {...tile_motion}>
              <div className="text-3xl font-semibold text-zinc-50">{build_version_title(build)}</div>
              <div className="mt-3 font-mono text-sm text-cyan-100">{build_label(build)}</div>
            </motion.button>
          ))}
        </div>
      </PickerShell>
    );
  }

  if (!selected_module) {
    return (
      <PickerShell back={reset_module_selection} crumbs={<><Crumb onSelect={() => select_family(selected_family)}>{selected_family}</Crumb><Crumb onSelect={() => select_architecture(selected_architecture)}>{selected_architecture}</Crumb><Crumb>{build_label(selected_build)}</Crumb></>} title="Modules">
        <div className="mx-auto max-w-4xl">
          <div className="relative mx-auto mb-5 max-w-xl">
            <Search className="pointer-events-none absolute left-3 top-3 h-4 w-4 text-zinc-500" />
            <input aria-label="Search modules" className="h-10 w-full rounded-md border border-white/15 bg-black/45 pl-9 pr-3 text-left text-sm text-zinc-100 outline-none backdrop-blur placeholder:text-zinc-500 focus:border-cyan-300/70" onChange={(event) => set_module_query(event.target.value)} placeholder="Search modules" type="search" value={module_query} />
          </div>
          {loading_modules ? (
            <LoadingState className="text-left" detail={`Reading modules for ${build_label(selected_build)}`} label="Loading kernel modules" rows={5} />
          ) : module_error && modules.length === 0 ? (
            <div className="rounded-md border border-red-400/20 bg-red-500/10 p-4 text-sm text-red-100">{module_error}</div>
          ) : modules.length === 0 ? (
            empty_state(module_search ? `No modules match "${module_search}".` : "No modules found.")
          ) : (
            <div>
              <div className="mb-3 text-left text-xs text-zinc-500">Showing {modules.length.toLocaleString()} of {module_total.toLocaleString()} modules</div>
              {/* Padding, not decoration. Tiles lift and scale on hover, and this is
                  a scroll container, so without room inside the clip boundary the
                  raised edge of a hovered tile is sliced off. */}
              <div className="grid max-h-[60vh] gap-3 overflow-auto p-2 pr-3 md:grid-cols-2 ka-scroll">
                {modules.map((module) => {
                  const badge = module_badge(module, (build_type_counts.get(module.build_id) ?? 0) > 0);
                  return (
                    <motion.button className="ka-tile rounded-xl p-4 text-left transition-colors hover:border-emerald-200/70" key={module.id} onClick={() => set_selected_module(module)} type="button" {...tile_motion}>
                      <div className="flex items-center justify-between gap-3">
                        <div className="min-w-0 truncate font-mono text-lg font-semibold text-zinc-50">{module.name}</div>
                        <Badge tone={badge.tone}>{badge.label}</Badge>
                      </div>
                      <div className="mt-2 truncate text-xs text-zinc-500">{module.original_path}</div>
                    </motion.button>
                  );
                })}
              </div>
              {module_error && <div className="mt-3 rounded-md border border-red-400/20 bg-red-500/10 p-3 text-left text-sm text-red-100">{module_error}</div>}
              {modules.length < module_total && (
                <div className="mt-4 flex justify-center">
                  <Button disabled={loading_more_modules} icon={loading_more_modules ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <ChevronDown className="h-4 w-4" />} onClick={() => void load_more_modules()} variant="ghost">
                    {loading_more_modules ? "Loading" : "Load more"}
                  </Button>
                </div>
              )}
            </div>
          )}
        </div>
      </PickerShell>
    );
  }

  const selected_badge = module_badge(selected_module, (build_type_counts.get(selected_module.build_id) ?? 0) > 0);
  return (
    <WorkspaceShell>
      <section className="ka-panel min-w-0 rounded-xl p-5">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <Button icon={<ArrowLeft className="h-4 w-4" />} onClick={() => set_selected_module(undefined)} variant="ghost">Back</Button>
              <nav aria-label="Breadcrumb" className="flex min-w-0 flex-wrap items-center gap-2 text-sm text-zinc-400">
                <button
                  className="rounded font-mono text-zinc-300 underline decoration-transparent underline-offset-4 transition-colors hover:text-cyan-100 hover:decoration-cyan-300/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-300/60"
                  onClick={reset_to_families}
                  type="button"
                >
                  Explorer
                </button>
                <Crumb onSelect={() => select_family(selected_family)}>{selected_family}</Crumb>
                <Crumb onSelect={() => select_architecture(selected_architecture)}>{selected_architecture}</Crumb>
                <Crumb onSelect={() => set_selected_module(undefined)}>{build_label(selected_build)}</Crumb>
                <Crumb>{selected_module.name}</Crumb>
              </nav>
            </div>
            <div className="mt-4 flex flex-wrap items-center gap-2">
              <h1 className="font-mono text-2xl font-semibold text-zinc-50">{selected_module.name}</h1>
              <Badge tone="blue">{selected_module.machine ?? selected_build.architecture}</Badge>
              <Badge tone={selected_badge.tone}>{selected_badge.label}</Badge>
            </div>
            <div className="mt-2 break-all text-sm text-zinc-500">{selected_module.original_path}</div>
          </div>
          <div className="flex flex-wrap gap-2">
            <CopyButton label="Copy path" value={selected_module.original_path} />
            <CopyButton label="Copy SHA256" value={selected_module.sha256} />
            <ModuleDownloadLink available={selected_module.binary_available} module_id={selected_module.id} />
            <ModulePackageLink module_name={selected_module.name} />
            <Link className="inline-flex h-9 items-center gap-2 rounded-md border border-cyan-300/50 bg-cyan-300/10 px-3 text-sm text-cyan-100 hover:bg-cyan-300/20" href="/patterns"><ScanSearch className="h-4 w-4" />Patterns</Link>
            <Link className="inline-flex h-9 items-center rounded-md border border-white/15 bg-white/5 px-3 text-sm text-zinc-100 hover:bg-white/10" href={`/modules/${selected_module.id}`}>Open module</Link>
          </div>
        </div>
        <div className="mt-4 text-xs text-zinc-600">{stats.patterns.toLocaleString()} cached patterns</div>
      </section>

      <ModuleSymbols buildHasTypes={(build_type_counts.get(selected_module.build_id) ?? 0) > 0} buildId={selected_module.build_id} functionCount={selected_module.function_count} moduleId={selected_module.id} typeCount={selected_module.type_count} />
      <ModuleAdvancedDetails module={selected_module} />
    </WorkspaceShell>
  );
}
