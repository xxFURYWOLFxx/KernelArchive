import { LoaderCircle } from "lucide-react";

interface LoadingStateProps {
  label: string;
  detail?: string;
  rows?: number;
  compact?: boolean;
  className?: string;
}

export function LoadingState({
  label,
  detail = "Reading cached archive data",
  rows = 3,
  compact = false,
  className = "",
}: LoadingStateProps) {
  return (
    <div
      aria-busy="true"
      aria-label={label}
      aria-live="polite"
      className={`relative overflow-hidden rounded-md border border-cyan-300/30 bg-cyan-300/[0.07] shadow-[inset_0_1px_0_rgba(255,255,255,0.05)] ${compact ? "min-h-28 p-3" : "min-h-44 p-5"} ${className}`}
      role="status"
    >
      <div className="ka-operation-progress"><span /></div>
      <div className="flex items-center gap-3">
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md border border-cyan-200/30 bg-cyan-300/15 text-cyan-100">
          <LoaderCircle className="h-5 w-5 animate-spin" />
        </div>
        <div className="min-w-0">
          <div className="text-sm font-semibold text-zinc-50">{label}</div>
          <div className="mt-0.5 truncate text-xs text-zinc-400">{detail}</div>
        </div>
        <span className="ml-auto shrink-0 rounded border border-cyan-300/25 bg-black/25 px-2 py-1 font-mono text-[11px] text-cyan-100">Loading</span>
      </div>
      {rows > 0 && (
        <div className={`${compact ? "mt-3" : "mt-5"} divide-y divide-white/10 border-y border-white/10`}>
          {Array.from({ length: rows }, (_, index) => (
            <div className="grid h-10 animate-pulse grid-cols-[minmax(0,1fr)_28%] items-center gap-4" key={index}>
              <span className="h-2.5 rounded-sm bg-cyan-100/20" />
              <span className="h-2.5 rounded-sm bg-white/15" />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
