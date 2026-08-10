import type { HTMLAttributes } from "react";
import { cn } from "./cn";

type BadgeTone = "blue" | "green" | "yellow" | "red" | "zinc";

const tones: Record<BadgeTone, string> = {
  blue: "border-cyan-400/40 bg-cyan-400/10 text-cyan-200",
  green: "border-emerald-400/40 bg-emerald-400/10 text-emerald-200",
  yellow: "border-amber-400/40 bg-amber-400/10 text-amber-200",
  red: "border-red-400/40 bg-red-400/10 text-red-200",
  zinc: "border-zinc-700 bg-zinc-900 text-zinc-300",
};

export interface BadgeProps extends HTMLAttributes<HTMLSpanElement> {
  tone?: BadgeTone;
}

export function Badge({ className, tone = "zinc", ...props }: BadgeProps) {
  return <span className={cn("inline-flex items-center rounded px-2 py-1 text-xs font-medium", tones[tone], className)} {...props} />;
}

