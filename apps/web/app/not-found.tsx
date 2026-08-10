import type { Metadata } from "next";
import Link from "next/link";
import { FileQuestion, Search } from "lucide-react";

export const metadata: Metadata = {
  title: "Not found",
};

export default function NotFound() {
  return (
    <div className="ka-bg">
      <div className="mx-auto flex max-w-xl flex-col items-center px-4 py-24 text-center">
        <span className="flex h-14 w-14 items-center justify-center rounded-xl border border-cyan-300/30 bg-cyan-300/10">
          <FileQuestion className="h-7 w-7 text-cyan-100" />
        </span>
        <h1 className="mt-5 text-2xl font-semibold text-zinc-50">Nothing indexed here</h1>
        <p className="mt-2 text-sm leading-relaxed text-zinc-400">
          That page does not exist. If you followed a link to a module, type or function, it may belong to
          a build that has since been re-indexed. Identifiers change when a binary is re-parsed.
        </p>
        <div className="mt-6 flex flex-wrap items-center justify-center gap-3">
          <Link className="inline-flex h-10 items-center gap-2 rounded-md border border-cyan-400/60 bg-cyan-400/15 px-4 text-sm font-medium text-cyan-100 transition-colors hover:bg-cyan-400/25" href="/search">
            <Search className="h-4 w-4" />
            Search the archive
          </Link>
          <Link className="inline-flex h-10 items-center rounded-md border border-white/10 bg-black/30 px-4 text-sm text-zinc-300 transition-colors hover:border-cyan-300/60 hover:text-cyan-100" href="/">
            Back to builds
          </Link>
        </div>
      </div>
    </div>
  );
}
