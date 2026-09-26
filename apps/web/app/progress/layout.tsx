import type { Metadata } from "next";
import { noindex_metadata } from "@/lib/seo";

export const metadata: Metadata = noindex_metadata("Indexing progress");

export default function ProgressLayout({ children }: { children: React.ReactNode }) {
  return children;
}
