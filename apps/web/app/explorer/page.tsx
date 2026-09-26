import { Suspense } from "react";
import type { Metadata } from "next";
import { page_metadata } from "@/lib/seo";
import { ExplorerDashboard } from "@/components/explorer-dashboard";

export const metadata: Metadata = page_metadata({
  title: "Explore the archive",
  description: "Browse the archive by Windows family, architecture, build and module. Drill from a Windows release down to a single driver and its exported functions, struct layouts and field offsets.",
  path: "/explorer",
  keywords: ["Windows kernel explorer", "driver symbol browser", "kernel module list"],
});

export default function ExplorerPage() {
  return (
    <Suspense>
      <ExplorerDashboard />
    </Suspense>
  );
}
