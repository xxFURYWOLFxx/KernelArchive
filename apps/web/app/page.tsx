import type { Metadata } from "next";
import { Suspense } from "react";
import { ExplorerDashboard } from "@/components/explorer-dashboard";
import { SiteStructuredData } from "@/components/structured-data";
import { page_metadata } from "@/lib/seo";

export const metadata: Metadata = page_metadata({
  title: "Windows kernel symbols, struct offsets and byte patterns",
  description: "A searchable index of Windows kernel symbols, type layouts and byte patterns, every offset pinned to an exact Windows build. Look up _EPROCESS, _KTHREAD, ntoskrnl exports and driver internals instead of guessing at an offset that was right for some other version.",
  path: "/",
  keywords: ["Windows kernel offsets", "_EPROCESS offsets", "ntoskrnl symbols", "kernel struct layout", "PDB symbol search", "byte pattern signature", "Windows driver internals"],
});

export default function HomePage() {
  return (
    <>
      <SiteStructuredData />
      <Suspense>
        <ExplorerDashboard />
      </Suspense>
    </>
  );
}
