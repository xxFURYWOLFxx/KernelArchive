import type { KernelModule } from "@kernelarchive/shared";

export type ModuleBadgeTone = "blue" | "green" | "yellow" | "red" | "zinc";

// Single source of truth for module symbol-coverage badges. Every surface that
// lists modules must use this, otherwise the same module reads differently
// depending on which page you opened.
export function module_badge(module: Pick<KernelModule, "type_count" | "pdb_name" | "pdb_guid">, build_has_types = false): { label: string; tone: ModuleBadgeTone; title: string } {
  if (module.type_count > 0) {
    return { label: "types", tone: "green", title: "This module's own PDB ships type records." };
  }
  if (build_has_types && (module.pdb_name || module.pdb_guid)) {
    return { label: "build types", tone: "blue", title: "No types of its own, but this build has a shared type library." };
  }
  if (module.pdb_name || module.pdb_guid) {
    return { label: "pdb", tone: "yellow", title: "PDB symbols are indexed, but no type records are available for this build." };
  }
  return { label: "pe", tone: "zinc", title: "No PDB is available; only PE export metadata is indexed." };
}
