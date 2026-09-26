import { SearchWorkbench } from "@/components/search-workbench";
import type { Metadata } from "next";
import { page_metadata } from "@/lib/seo";

export const metadata: Metadata = page_metadata({
  title: "Search kernel symbols",
  description: "Search millions of Windows kernel functions, structures and fields by name. Results carry the module and the exact build, so an offset is never reported without the version it belongs to.",
  path: "/search",
  keywords: ["search Windows kernel symbols", "find struct offset", "kernel function lookup"],
});

export default function SearchPage() {
  return <SearchWorkbench />;
}
