import { Download } from "lucide-react";

export function ModuleDownloadLink({ available, module_id }: { available?: boolean; module_id: string }) {
  if (!available) {
    return (
      <span
        aria-disabled="true"
        className="inline-flex h-9 cursor-not-allowed items-center gap-2 rounded-md border border-white/10 bg-white/[0.03] px-3 text-sm text-zinc-600"
        title="The indexed binary file is unavailable"
      >
        <Download className="h-4 w-4" />
        File unavailable
      </span>
    );
  }

  return (
    <a
      className="inline-flex h-9 items-center gap-2 rounded-md border border-emerald-300/50 bg-emerald-300/10 px-3 text-sm text-emerald-100 transition-colors hover:bg-emerald-300/20"
      download
      href={`/api/v1/modules/${encodeURIComponent(module_id)}/download`}
    >
      <Download className="h-4 w-4" />
      Download file
    </a>
  );
}
