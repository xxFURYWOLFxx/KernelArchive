"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { Search } from "lucide-react";
import { Badge } from "@kernelarchive/ui";
import type { SearchResult } from "@kernelarchive/shared";
import { api_json } from "@/lib/api";

export function GlobalSearch() {
  const input_ref = useRef<HTMLInputElement>(null);
  const [query, set_query] = useState("");
  const [results, set_results] = useState<SearchResult[]>([]);

  useEffect(() => {
    function on_keydown(event: KeyboardEvent) {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        input_ref.current?.focus();
      }
    }

    window.addEventListener("keydown", on_keydown);
    return () => window.removeEventListener("keydown", on_keydown);
  }, []);

  useEffect(() => {
    const normalized = query.trim();
    if (normalized.length < 2) {
      set_results([]);
      return;
    }

    const controller = new AbortController();
    const handle = window.setTimeout(() => {
      void api_json<SearchResult[]>(`/api/v1/search?q=${encodeURIComponent(normalized)}&limit=6`, { signal: controller.signal })
        .then((response) => { if (!controller.signal.aborted) { set_results(response.data.slice(0, 6)); } })
        .catch(() => {});
    }, 150);

    return () => { window.clearTimeout(handle); controller.abort(); };
  }, [query]);

  return (
    <div className="relative w-full lg:w-72 lg:shrink-0 xl:w-80 2xl:w-96">
      <Search className="pointer-events-none absolute left-3 top-2.5 h-4 w-4 text-zinc-500" />
      <input
        className="h-9 w-full rounded-md border border-white/10 bg-black/35 pl-9 pr-3 text-sm text-zinc-100 outline-none transition-colors placeholder:text-zinc-600 focus:border-cyan-400/60"
        onChange={(event) => set_query(event.target.value)}
        placeholder="Search symbols, modules, RVAs"
        ref={input_ref}
        value={query}
      />
      {results.length > 0 && (
        <div className="ka-panel absolute right-0 top-11 z-30 max-h-[420px] w-full overflow-auto rounded-md ka-scroll">
          {results.map((result) => (
            <Link className="flex items-center justify-between gap-3 border-b border-white/10 px-3 py-2 transition-colors last:border-b-0 hover:bg-white/5" href={result.web_url} key={result.id} onClick={() => set_query("")}>
              <div>
                <div className="font-mono text-sm text-zinc-100">{result.name}</div>
                <div className="text-xs text-zinc-500">{result.module} / {result.build}</div>
              </div>
              <Badge tone={result.kind === "function" ? "green" : "blue"}>{result.kind}</Badge>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
