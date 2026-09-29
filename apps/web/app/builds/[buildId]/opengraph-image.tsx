import { build_display_label } from "@kernelarchive/shared";
import { api_data, api_list_all, type BuildCatalogEntry, type WindowsBuild } from "@/lib/api";
import { og_card, og_content_type, og_size } from "@/lib/og-card";

export const alt = "Windows build kernel symbols";
export const size = og_size;
export const contentType = og_content_type;

export default async function BuildOpengraphImage({ params }: { params: Promise<{ buildId: string }> }) {
  const { buildId } = await params;
  const build = await api_data<WindowsBuild | undefined>(`/api/v1/builds/${buildId}`, undefined);
  if (!build) {
    return og_card({ chips: [], eyebrow: "Windows kernel", subtitle: "This build is no longer in the archive.", title: "Not found" });
  }
  const catalog = await api_list_all<BuildCatalogEntry>("/api/v1/builds/catalog");
  const totals = catalog.find((entry) => entry.id === build.id);
  return og_card({
    eyebrow: "Windows build",
    title: build_display_label(build),
    subtitle: "Kernel structures, offsets and exported symbols pinned to this build",
    chips: [
      `${(totals?.module_count ?? 0).toLocaleString()} modules`,
      `${(totals?.function_count ?? 0).toLocaleString()} functions`,
      `${(totals?.type_count ?? 0).toLocaleString()} types`,
    ],
  });
}
