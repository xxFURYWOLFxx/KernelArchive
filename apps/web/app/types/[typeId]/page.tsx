import Link from "next/link";
import { notFound } from "next/navigation";
import { Badge } from "@kernelarchive/ui";
import { CodePanel } from "@/components/code-panel";
import { CopyButton } from "@/components/copy-button";
import { MetadataTable } from "@/components/metadata-table";
import { TypeFields } from "@/components/type-fields";
import { TypeCrossReference } from "@/components/type-version-compare";
import { api_data, type TypeDetailContext } from "@/lib/api";
import { build_label, product_label } from "@/lib/build-family";
import { generate_offset_header } from "@kernelarchive/shared";

export default async function TypeDetailPage({ params }: { params: Promise<{ typeId: string }> }) {
  const { typeId } = await params;
  const context = await api_data<TypeDetailContext | undefined>(`/api/v1/types/${typeId}/context`, undefined);
  if (!context) { notFound(); }
  const { type } = context;
  const module = context.module ?? undefined;
  const build = context.build ?? undefined;
  const header = generate_offset_header(type, module, build);

  return (
    <div className="grid gap-4 xl:grid-cols-[360px_1fr]">
        <aside className="ka-panel min-w-0 rounded-xl p-4 xl:sticky xl:top-28 xl:self-start">
          <div className="mb-3 flex items-center gap-2">
            <h1 className="font-mono text-base text-zinc-100">{type.name}</h1>
            <Badge tone="blue">{type.kind}</Badge>
          </div>
          <MetadataTable
            rows={[
              ["Module", module?.name ?? type.module_id],
              ["Build", build ? `${product_label(build)} / ${build_label(build)}` : "Detection required"],
              ["Size", `0x${type.size.toString(16)} (${type.size} bytes)`],
              ["Members", type.fields.length],
            ]}
          />
          <div className="mt-4 flex flex-wrap gap-2">
            {module && <Link className="inline-flex rounded-md border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-zinc-100 hover:bg-zinc-800" href={`/modules/${module.id}`}>Open module</Link>}
            {build && <Link className="inline-flex rounded-md border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-zinc-100 hover:bg-zinc-800" href={`/builds/${build.id}`}>Open build</Link>}
          </div>
        </aside>
        <section className="min-w-0 space-y-4">
          <TypeCrossReference typeId={type.id} />

          <div className="ka-panel rounded-xl p-4">
            <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
              <h2 className="text-sm font-semibold text-zinc-100">Definition</h2>
              <div className="flex flex-wrap gap-2">
                <CopyButton label="Copy definition" value={type.reconstructed_c} />
                <CopyButton label="Copy offset header" value={header} />
                <CopyButton label="Copy type name" value={type.name} />
              </div>
            </div>
            <CodePanel code={type.reconstructed_c} />
          </div>

          {type.kind !== "typedef" && <TypeFields fieldCount={type.fields.length} typeId={type.id} typeKind={type.kind} />}

          <details className="ka-panel rounded-xl">
            <summary className="cursor-pointer px-4 py-3 text-sm font-semibold text-zinc-100">Advanced metadata</summary>
            <div className="border-t border-zinc-800 p-4">
              <MetadataTable
                rows={[
                  ["Type ID", type.id],
                  ["Hash", type.hash],
                  ["Alignment", type.alignment],
                  ["API URL", `/api/v1/types/${type.id}`],
                ]}
              />
            </div>
          </details>
        </section>
    </div>
  );
}
