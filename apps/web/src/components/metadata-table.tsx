export function MetadataTable({ rows }: { rows: Array<[string, string | number]> }) {
  return (
    <div className="overflow-hidden rounded-md border border-white/10 bg-black/25">
      {rows.map(([label, value]) => (
        <div className="grid grid-cols-[112px_minmax(0,1fr)] border-b border-white/10 last:border-b-0 sm:grid-cols-[150px_minmax(0,1fr)]" key={label}>
          <div className="bg-black/25 px-3 py-2 text-xs text-zinc-500">{label}</div>
          <div className="min-w-0 break-words px-3 py-2 font-mono text-xs text-zinc-200">{value}</div>
        </div>
      ))}
    </div>
  );
}
