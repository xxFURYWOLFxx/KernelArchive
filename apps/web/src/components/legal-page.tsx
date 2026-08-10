import Link from "next/link";
import type { ReactNode } from "react";
import { ArrowLeft } from "lucide-react";
import { site } from "@/lib/site";

export function LegalPage({ children, dated = true, subtitle, title }: { children: ReactNode; dated?: boolean; subtitle: string; title: string }) {
  return (
    <div className="ka-bg">
      <div className="mx-auto max-w-3xl px-4 py-10 xl:px-6">
        <Link className="inline-flex h-9 items-center gap-2 rounded-md border border-white/10 bg-black/30 px-3 text-sm text-zinc-300 transition-colors hover:border-cyan-300/60 hover:text-cyan-100" href="/">
          <ArrowLeft className="h-4 w-4" />
          Back to archive
        </Link>
        <header className="mt-6">
          <h1 className="text-3xl font-semibold text-zinc-50">{title}</h1>
          <p className="mt-2 text-sm text-zinc-400">{subtitle}</p>
          {dated && <p className="mt-1 text-xs text-zinc-600">Last updated {site.legal_updated}</p>}
        </header>
        <div className="ka-panel mt-6 rounded-xl p-6">{children}</div>
      </div>
    </div>
  );
}

export function LegalSection({ children, heading }: { children: ReactNode; heading: string }) {
  return (
    <section className="border-b border-white/5 py-5 first:pt-0 last:border-b-0 last:pb-0">
      <h2 className="text-base font-semibold text-zinc-100">{heading}</h2>
      <div className="mt-2 space-y-3 text-sm leading-relaxed text-zinc-400">{children}</div>
    </section>
  );
}
