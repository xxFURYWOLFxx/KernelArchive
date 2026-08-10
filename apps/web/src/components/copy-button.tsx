"use client";

import { useState } from "react";
import { Check, Copy } from "lucide-react";
import { Button } from "@kernelarchive/ui";

export function CopyButton({ value, label }: { value: string; label: string }) {
  const [state, set_state] = useState<"idle" | "copied" | "failed">("idle");

  async function copy_value() {
    let copied = false;
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(value);
        copied = true;
      }
    } catch {
      copied = false;
    }

    if (!copied) {
      const textarea = document.createElement("textarea");
      textarea.value = value;
      textarea.setAttribute("readonly", "true");
      textarea.style.position = "fixed";
      textarea.style.left = "-9999px";
      document.body.appendChild(textarea);
      textarea.select();
      copied = document.execCommand("copy");
      textarea.remove();
    }

    set_state(copied ? "copied" : "failed");
    window.setTimeout(() => set_state("idle"), 1200);
  }

  return (
    <Button icon={state === "copied" ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />} onClick={copy_value} variant="ghost">
      {state === "copied" ? "Copied" : state === "failed" ? "Copy failed" : label}
    </Button>
  );
}
