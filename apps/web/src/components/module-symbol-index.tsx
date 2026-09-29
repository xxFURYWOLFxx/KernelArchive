import Link from "next/link";
import { api_json, type KernelFunction, type KernelTypeSummary } from "@/lib/api";

// The API rejects a limit above 100.
const page_size = 100;

// A plain, server-rendered index of everything a module defines.
//
// The symbol browser above it is a client component: it searches and paginates
// without a round trip, which is the right tool for a person and the wrong one
// for a crawler, because none of the links it draws exist until JavaScript has
// run. Type and function pages are the archive's whole substance, so without a
// list like this nothing links to them and they are reachable only from the
// sitemap. Real anchors, real pagination, visible to both readers.
async function symbol_page<T>(path: string, page: number) {
  try {
    const response = await api_json<T[]>(`${path}?page=${page}&limit=${page_size}`);
    return { items: response.data, total: response.pagination?.total ?? response.data.length };
  } catch {
    return { items: [], total: 0 };
  }
}

function Pager({ base, label, page, pages }: { base: string; label: string; page: number; pages: number }) {
  if (pages < 2) { return null; }
  const numbers = new Set<number>([1, pages, page - 1, page, page + 1]);
  const visible = Array.from(numbers).filter((value) => value >= 1 && value <= pages).sort((left, right) => left - right);
  return (
    <div className="mt-3 flex flex-wrap items-center gap-2 text-xs text-zinc-500">
      <span>
        {label} page {page} of {pages.toLocaleString()}
      </span>
      {visible.map((value, index) => (
        <span className="flex items-center gap-2" key={value}>
          {index > 0 && visible[index - 1] !== value - 1 && <span aria-hidden>...</span>}
          {value === page
            ? <span className="rounded border border-cyan-400/50 bg-cyan-300/10 px-2 py-1 text-cyan-100">{value}</span>
            : <Link className="rounded border border-white/10 px-2 py-1 transition-colors hover:border-cyan-300/60 hover:text-cyan-100" href={`${base}${value}`}>{value}</Link>}
        </span>
      ))}
    </div>
  );
}

export async function ModuleSymbolIndex({ moduleId, functionPage, typePage }: { moduleId: string; functionPage: number; typePage: number }) {
  const [types, functions] = await Promise.all([
    symbol_page<KernelTypeSummary>(`/api/v1/modules/${moduleId}/types`, typePage),
    symbol_page<KernelFunction>(`/api/v1/modules/${moduleId}/functions`, functionPage),
  ]);

  if (types.total === 0 && functions.total === 0) { return null; }

  const type_pages = Math.max(1, Math.ceil(types.total / page_size));
  const function_pages = Math.max(1, Math.ceil(functions.total / page_size));

  return (
    <div className="ka-panel rounded-xl p-4">
      <h2 className="mb-1 text-sm font-semibold text-zinc-100">Index</h2>
      <p className="mb-4 text-xs leading-relaxed text-zinc-500">
        Every symbol this module publishes, as plain links.
      </p>

      {types.total > 0 && (
        <div className="mb-6">
          <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-zinc-400">
            Structures and types ({types.total.toLocaleString()})
          </h3>
          <div className="grid gap-x-4 gap-y-1 sm:grid-cols-2 lg:grid-cols-3">
            {types.items.map((type) => (
              <Link className="truncate font-mono text-xs text-zinc-400 transition-colors hover:text-cyan-200" href={`/types/${type.id}`} key={type.id} title={type.name}>
                {type.name}
              </Link>
            ))}
          </div>
          <Pager base={`?function_page=${functionPage}&type_page=`} label="Types" page={typePage} pages={type_pages} />
        </div>
      )}

      {functions.total > 0 && (
        <div>
          <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-zinc-400">
            Functions ({functions.total.toLocaleString()})
          </h3>
          <div className="grid gap-x-4 gap-y-1 sm:grid-cols-2 lg:grid-cols-3">
            {functions.items.map((fn) => (
              <Link className="truncate font-mono text-xs text-zinc-400 transition-colors hover:text-cyan-200" href={`/functions/${fn.id}`} key={fn.id} title={fn.name}>
                {fn.name}
              </Link>
            ))}
          </div>
          <Pager base={`?type_page=${typePage}&function_page=`} label="Functions" page={functionPage} pages={function_pages} />
        </div>
      )}
    </div>
  );
}
