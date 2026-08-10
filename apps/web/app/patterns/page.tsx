import { PatternWorkbench } from "@/components/pattern-workbench";

export default async function PatternsPage({ searchParams }: { searchParams: Promise<{ function?: string }> }) {
  const params = await searchParams;
  return <PatternWorkbench initialFunctionId={params.function} />;
}
