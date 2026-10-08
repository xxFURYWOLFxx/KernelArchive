"use client";

import Link from "next/link";
import type { ReactNode } from "react";
import { Braces, Database, LayoutDashboard, Layers3, ScanSearch, Search, Shield } from "lucide-react";
import { GlobalSearch } from "./global-search";

const nav_items = [
  { href: "/", label: "Explorer", icon: LayoutDashboard },
  { href: "/builds", label: "Builds", icon: Layers3 },
  { href: "/search", label: "Search", icon: Search },
  { href: "/patterns", label: "Patterns", icon: ScanSearch },
  { href: "/api-docs", label: "API Docs", icon: Braces },
  { href: "/admin", label: "Admin", icon: Shield },
];

export function AppShell({ children, section }: { children: ReactNode; section: string }) {
  return (
    <div className="ka-shell">
      <header className="sticky top-0 z-30 border-b border-white/10 bg-[#05070d]/78 px-4 py-3 backdrop-blur-xl">
        <div className="mx-auto flex max-w-7xl flex-col gap-3 xl:flex-row xl:items-center xl:justify-between">
          <div className="flex min-w-0 items-center justify-between gap-4">
            <Link href="/" className="flex min-w-0 items-center gap-3">
              <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md border border-cyan-300/40 bg-cyan-300/12 shadow-lg shadow-cyan-950/40">
                <Database className="h-5 w-5 text-cyan-100" />
              </span>
              <span className="min-w-0">
                <span className="block truncate text-base font-semibold text-zinc-50">KernelArchive</span>
                <span className="block text-xs text-zinc-500">{section}</span>
              </span>
            </Link>
          </div>
          <div className="flex flex-col gap-3 lg:flex-row lg:items-center">
            <nav className="flex max-w-full shrink-0 gap-1 overflow-x-auto rounded-md border border-white/10 bg-black/25 p-1 ka-scroll">
              {nav_items.map((item) => {
                const Icon = item.icon;
                const active = item.label === section || (section === "Explorer" && item.href === "/");
                return (
                  <Link
                    aria-current={active ? "page" : undefined}
                    className={`inline-flex h-9 shrink-0 items-center gap-2 rounded px-3 text-sm transition-colors ${active ? "bg-cyan-300/15 text-cyan-100" : "text-zinc-400 hover:bg-white/5 hover:text-zinc-100"}`}
                    href={item.href}
                    key={item.href}
                    prefetch
                  >
                    <Icon className="h-4 w-4" />
                    {item.label}
                  </Link>
                );
              })}
            </nav>
            <GlobalSearch />
          </div>
        </div>
      </header>
      <main className="mx-auto min-w-0 max-w-7xl px-4 py-5 xl:px-6 xl:py-7">
        <div className="ka-rise">{children}</div>
      </main>
    </div>
  );
}
