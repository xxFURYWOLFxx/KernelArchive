import type { ButtonHTMLAttributes, ReactNode } from "react";
import { cn } from "./cn";

type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";

const variants: Record<ButtonVariant, string> = {
  primary: "border-cyan-400/60 bg-cyan-400/15 text-cyan-100 hover:bg-cyan-400/25",
  secondary: "border-zinc-700 bg-zinc-900 text-zinc-100 hover:bg-zinc-800",
  ghost: "border-transparent bg-transparent text-zinc-300 hover:bg-zinc-900 hover:text-zinc-50",
  danger: "border-red-400/60 bg-red-500/10 text-red-100 hover:bg-red-500/20",
};

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  icon?: ReactNode;
}

export function Button({ className, variant = "secondary", icon, children, ...props }: ButtonProps) {
  return (
    <button
      className={cn(
        "inline-flex h-9 items-center justify-center gap-2 rounded-md border px-3 text-sm font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50",
        variants[variant],
        className,
      )}
      {...props}
    >
      {icon}
      {children}
    </button>
  );
}

