"use client";

import { Badge } from "@kernelarchive/ui";
import type { PatternCrossReferenceRow, PatternCrossReferenceStatus } from "@kernelarchive/shared";
import { CopyButton } from "./copy-button";

function status_tone(status: PatternCrossReferenceStatus) {
  if (status === "tested") { return "green"; }
  if (status === "stored-pattern") { return "blue"; }
  if (status === "symbol-only") { return "yellow"; }
  if (status === "error") { return "red"; }
  return "zinc";
}

function metrics(row: PatternCrossReferenceRow) {
  const values = [
    row.pattern_scope ?? "",
    typeof row.confidence === "number" ? `${Math.round(row.confidence * 100)}%` : "",
    typeof row.collision_count === "number" ? `${row.collision_count} collisions` : "",
    typeof row.length === "number" ? `${row.length} bytes` : "",
  ].filter(Boolean);
  return values.length > 0 ? values.join(" / ") : "n/a";
}

function build_key(row: PatternCrossReferenceRow) {
  const label = row.build_label.trim();
  return label.toLowerCase().endsWith(row.architecture.toLowerCase()) ? label : `${label} ${row.architecture}`;
}

// One "build = pattern" line per build, aligned so a whole set can be pasted
// straight into notes or a signature header.
function patterns_export(rows: PatternCrossReferenceRow[]) {
  const usable = rows.filter((row) => row.pattern);
  if (usable.length === 0) { return ""; }
  const width = Math.max(...usable.map((row) => build_key(row).length));
  return usable.map((row) => `${build_key(row).padEnd(width)} = ${row.pattern}`).join("\n");
}

function detailed_export(rows: PatternCrossReferenceRow[], function_name: string) {
  const lines = [`// ${function_name} - pattern per build (${rows.filter((row) => row.pattern).length}/${rows.length} builds)`];
  for (const row of rows) {
    if (row.pattern) {
      lines.push(`${build_key(row)}  rva=${row.rva ?? "n/a"}  ${row.pattern_status ?? ""}`.trimEnd());
      lines.push(`  ${row.pattern}`);
    } else {
      lines.push(`${build_key(row)}  ${row.status}${row.note ? ` - ${row.note}` : ""}`);
    }
  }
  return lines.join("\n");
}

export function PatternCrossReferenceTable({ rows }: { rows: PatternCrossReferenceRow[] }) {
  if (rows.length === 0) {
    return (
      <div className="rounded-md border border-white/10 bg-black/30 p-3 text-sm text-zinc-500">
        No build cross-reference rows are available.
      </div>
    );
  }

  const pattern_rows = rows.filter((row) => row.pattern).length;

  return (
    <div className="min-w-0 max-w-full overflow-hidden rounded-md border border-white/10 bg-black/30">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-white/10 p-3">
        <div className="flex flex-wrap items-center gap-2">
          <h3 className="text-sm font-semibold text-zinc-100">Build Cross-Reference</h3>
          <Badge tone="zinc">{rows.length} builds</Badge>
          {pattern_rows > 0 && <Badge tone="green">{pattern_rows} with patterns</Badge>}
        </div>
        {pattern_rows > 0 && (
          <div className="flex flex-wrap gap-2">
            <CopyButton label={`Copy all ${pattern_rows} patterns`} value={patterns_export(rows)} />
            <CopyButton label="Copy with details" value={detailed_export(rows, rows[0]?.function_name ?? "function")} />
          </div>
        )}
      </div>

      {pattern_rows > 0 && (
        <pre className="max-h-[220px] min-w-0 max-w-full overflow-auto border-b border-white/10 bg-black/40 p-3 font-mono text-[11px] leading-relaxed text-zinc-300 ka-scroll">{patterns_export(rows)}</pre>
      )}
      <div className="min-w-0 max-w-full overflow-x-auto ka-scroll">
        <table className="w-full min-w-[760px] text-left text-xs">
          <thead className="border-b border-white/10 text-zinc-500">
            <tr>
              <th className="px-3 py-2 font-medium">Build</th>
              <th className="px-3 py-2 font-medium">Module</th>
              <th className="px-3 py-2 font-medium">RVA</th>
              <th className="px-3 py-2 font-medium">Status</th>
              <th className="px-3 py-2 font-medium">Pattern</th>
              <th className="px-3 py-2 font-medium">Note</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-white/10">
            {rows.map((row) => (
              <tr key={row.build_id} className="align-top transition-colors hover:bg-white/5">
                <td className="px-3 py-2 font-mono text-zinc-200">{row.build_label}</td>
                <td className="px-3 py-2 font-mono text-zinc-300">{row.module_name}</td>
                <td className="px-3 py-2 font-mono text-zinc-300">{row.rva ?? "n/a"}</td>
                <td className="px-3 py-2"><Badge tone={status_tone(row.status)}>{row.status}</Badge></td>
                <td className="px-3 py-2 font-mono text-zinc-300">
                  <div>{metrics(row)}</div>
                  {row.pattern && (
                    <details className="mt-2 font-sans text-xs text-zinc-400">
                      <summary className="cursor-pointer text-cyan-200">View pattern</summary>
                      <pre className="mt-2 min-w-0 max-w-[360px] overflow-auto rounded border border-white/10 bg-black/35 p-2 font-mono text-[11px] text-zinc-300 ka-scroll">{row.pattern}</pre>
                      <div className="mt-2 flex flex-wrap gap-2">
                        <CopyButton label="Copy pattern" value={row.pattern} />
                        {row.mask && <CopyButton label="Copy mask" value={row.mask} />}
                      </div>
                    </details>
                  )}
                </td>
                <td className="max-w-[320px] px-3 py-2 text-zinc-400">{row.note}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
