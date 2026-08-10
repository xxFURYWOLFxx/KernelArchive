"use client";

import { createContext, type ReactNode, useContext, useMemo, useState } from "react";
import { cn } from "./cn";

const tab_context = createContext<{ value: string; set_value: (value: string) => void } | null>(null);

export function Tabs({ defaultValue, children }: { defaultValue: string; children: ReactNode }) {
  const [value, set_value] = useState(defaultValue);
  const state = useMemo(() => ({ value, set_value }), [value]);
  return <tab_context.Provider value={state}>{children}</tab_context.Provider>;
}

export function TabsList({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn("flex items-center gap-1 rounded-md border border-zinc-800 bg-zinc-950 p-1", className)}>{children}</div>;
}

export function TabsTrigger({ value, children }: { value: string; children: ReactNode }) {
  const state = useContext(tab_context);
  if (!state) { return null; }
  return (
    <button
      className={cn(
        "rounded px-3 py-1.5 text-sm text-zinc-400 transition-colors hover:bg-zinc-900 hover:text-zinc-100",
        state.value === value && "bg-zinc-800 text-zinc-50",
      )}
      onClick={() => state.set_value(value)}
      type="button"
    >
      {children}
    </button>
  );
}

export function TabsContent({ value, children, className }: { value: string; children: ReactNode; className?: string }) {
  const state = useContext(tab_context);
  if (!state || state.value !== value) { return null; }
  return <div className={className}>{children}</div>;
}

