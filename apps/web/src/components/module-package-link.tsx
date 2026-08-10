import { Package } from "lucide-react";

// Pulls every build's copy of this module in one archive, foldered per build.
export function ModulePackageLink({ module_name }: { module_name: string }) {
  if (!module_name) { return null; }

  return (
    <a
      className="inline-flex h-9 items-center gap-2 rounded-md border border-cyan-300/50 bg-cyan-300/10 px-3 text-sm text-cyan-100 transition-colors hover:bg-cyan-300/20"
      download
      href={`/api/v1/packages/module?name=${encodeURIComponent(module_name)}`}
      title={`Download ${module_name} from every indexed Windows build as a single zip`}
    >
      <Package className="h-4 w-4" />
      Download all builds
    </a>
  );
}
