import { PatternWorkbench } from "@/components/pattern-workbench";
import type { Metadata } from "next";
import { page_metadata } from "@/lib/seo";

export const metadata: Metadata = page_metadata({
  title: "Byte pattern generator",
  description: "Generate byte patterns for Windows kernel functions. Operands that move between builds are wildcarded, opcodes are kept, and each pattern is verified unique in the image before it is returned.",
  path: "/patterns",
  keywords: ["byte pattern signature", "AOB scan Windows kernel", "signature scanning pattern", "IDA pattern"],
});

export default async function PatternsPage({ searchParams }: { searchParams: Promise<{ function?: string }> }) {
  const params = await searchParams;
  return <PatternWorkbench initialFunctionId={params.function} />;
}
