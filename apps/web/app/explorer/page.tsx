import { Suspense } from "react";
import { ExplorerDashboard } from "@/components/explorer-dashboard";

export default function ExplorerPage() {
  return (
    <Suspense>
      <ExplorerDashboard />
    </Suspense>
  );
}
