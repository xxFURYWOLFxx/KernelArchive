import { DiffWorkbench } from "@/components/diff-workbench";
import type { Metadata } from "next";
import { page_metadata } from "@/lib/seo";

export const metadata: Metadata = page_metadata({
  title: "Compare builds",
  description: "Diff two Windows builds to see which kernel modules, functions and structures changed, which offsets moved, and which symbols appeared or disappeared between versions.",
  path: "/diff",
  keywords: ["compare Windows builds", "kernel struct changes", "offset diff between builds"],
});

export default function DiffPage() {
  return <DiffWorkbench />;
}
