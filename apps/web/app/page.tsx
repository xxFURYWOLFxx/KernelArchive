import { Suspense } from "react";
import { ExplorerDashboard } from "@/components/explorer-dashboard";

export default function HomePage() {
  return (
    <Suspense>
      <ExplorerDashboard />
    </Suspense>
  );
}
