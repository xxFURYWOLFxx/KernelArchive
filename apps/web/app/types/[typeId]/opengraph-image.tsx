import { api_data, type TypeDetailContext } from "@/lib/api";
import { build_context_label } from "@/lib/seo";
import { og_card, og_content_type, og_size } from "@/lib/og-card";

export const alt = "Windows kernel structure layout";
export const size = og_size;
export const contentType = og_content_type;

export default async function TypeOpengraphImage({ params }: { params: Promise<{ typeId: string }> }) {
  const { typeId } = await params;
  const context = await api_data<TypeDetailContext | undefined>(`/api/v1/types/${typeId}/context`, undefined);
  if (!context) {
    return og_card({ chips: [], eyebrow: "Windows kernel", subtitle: "This record is no longer in the archive.", title: "Not found" });
  }
  const { type } = context;
  const where = build_context_label(context.build ?? undefined);
  return og_card({
    eyebrow: `Windows kernel ${type.kind}`,
    title: type.name,
    subtitle: where ? `Field offsets as they shipped in ${where}` : "Field offsets from Microsoft's public debug symbols",
    chips: [
      context.module?.name ?? "",
      type.size > 0 ? `0x${type.size.toString(16)} bytes` : "",
      type.fields.length > 0 ? `${type.fields.length} members` : "",
    ],
  });
}
