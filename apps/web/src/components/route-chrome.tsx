"use client";

import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import { AppShell } from "./app-shell";

function workspace_section(pathname: string) {
  if (pathname === "/builds" || pathname.startsWith("/builds/")) { return "Builds"; }
  if (pathname === "/search") { return "Search"; }
  if (pathname === "/patterns") { return "Patterns"; }
  if (pathname === "/diff") { return "Diff"; }
  if (pathname === "/api-docs") { return "API Docs"; }
  if (pathname === "/admin") { return "Admin"; }
  if (pathname.startsWith("/modules/") || pathname.startsWith("/types/") || pathname.startsWith("/functions/")) { return "Explorer"; }
  return undefined;
}

export function RouteChrome({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const section = workspace_section(pathname);
  return section ? <AppShell section={section}>{children}</AppShell> : children;
}
