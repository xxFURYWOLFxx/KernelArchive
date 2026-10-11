import type { Metadata } from "next";
import { Suspense } from "react";
import { ExplorerDashboard } from "@/components/explorer-dashboard";
import { SiteStructuredData } from "@/components/structured-data";
import { page_metadata } from "@/lib/seo";

// The explorer owns the viewport: PickerShell is min-h-screen, centres its content
// and draws its own header. Anything stacked under it leaves a screen-high gap and
// a second header, so this page is the explorer and nothing else.
export const dynamic = "force-dynamic";

export const metadata: Metadata = page_metadata({
  title: "Windows kernel internals, structure offsets and symbols by build",
  description: "A searchable archive of Windows kernel internals: structure layouts, field offsets, exported functions and byte patterns, each one pinned to an exact Windows build. Look up _EPROCESS, _KTHREAD, ntoskrnl exports and undocumented kernel structures instead of trusting an offset that was right for some other version.",
  path: "/",
  keywords: ["Windows internals", "Windows kernel structures", "undocumented Windows", "kernel data structures", "_EPROCESS offsets", "ntoskrnl symbols", "Windows kernel offsets", "PDB symbol search"],
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
