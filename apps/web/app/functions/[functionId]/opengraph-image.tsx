import { api_data, type FunctionDetailContext } from "@/lib/api";
import { build_context_label } from "@/lib/seo";
import { og_card, og_content_type, og_size } from "@/lib/og-card";

export const alt = "Windows kernel function";
export const size = og_size;
export const contentType = og_content_type;

export default async function FunctionOpengraphImage({ params }: { params: Promise<{ functionId: string }> }) {
  const { functionId } = await params;
  const context = await api_data<FunctionDetailContext | undefined>(`/api/v1/functions/${functionId}/context`, undefined);
  if (!context) {
    return og_card({ chips: [], eyebrow: "Windows kernel", subtitle: "This record is no longer in the archive.", title: "Not found" });
  }
  const { fn } = context;
  const where = build_context_label(context.build ?? undefined);
  return og_card({
    eyebrow: "Windows kernel function",
    title: fn.name,
    subtitle: where ? `Address and prototype as they shipped in ${where}` : "Address and prototype from Microsoft's public debug symbols",
    chips: [context.module?.name ?? "", `RVA ${fn.rva}`, fn.calling_convention && fn.calling_convention !== "unknown" ? fn.calling_convention : ""],
  });
}
