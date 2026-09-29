"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { RefreshCw } from "lucide-react";
import { Button } from "@kernelarchive/ui";

// Lets a server-rendered page keep a refresh control without becoming a client
// component itself. The page has to stay server-rendered so its links are in the
// HTML a crawler reads.
export function RefreshButton({ label }: { label: string }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  return (
    <Button
      aria-label={label}
      className="w-9 px-0"
      disabled={pending}
      icon={<RefreshCw className={`h-4 w-4 ${pending ? "animate-spin" : ""}`} />}
      onClick={() => start(() => router.refresh())}
      title={label}
    />
  );
}
