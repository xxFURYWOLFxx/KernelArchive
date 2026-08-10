import type { ReactNode } from "react";

export function MetricCard({ icon, label, value, accent }: { icon: ReactNode; label: string; value: string; accent: string }) {
  return (
    <div className="rounded-md border border-line bg-panel p-4">
      <div className="mb-3 flex items-center justify-between">
        <span className="text-xs text-zinc-500">{label}</span>
        <span className={accent}>{icon}</span>
      </div>
      <div className="font-mono text-2xl text-zinc-50">{value}</div>
    </div>
  );
}

