"use client";

import { useEffect, useMemo, useState } from "react";
import { ChevronDown, Search } from "lucide-react";
import { Badge, Button } from "@kernelarchive/ui";
import type { KernelType } from "@kernelarchive/shared";
import { api_json } from "@/lib/api";
import { CopyButton } from "./copy-button";
import { LoadingState } from "./loading-state";

const page_size = 40;

function offset_label(offset_bits: number) {
  const byte_offset = Math.floor(offset_bits / 8);
  const bit_offset = offset_bits % 8;
  return bit_offset === 0 ? `0x${byte_offset.toString(16)}` : `0x${byte_offset.toString(16)}:${bit_offset}`;
}

// A bitfield's own offset lands mid-byte, so report the storage unit it packs into
// and describe the bits separately.
function bitfield_of(field: KernelType["fields"][number]) {
  const position = field.flags_json.bit_position;
  const width = field.flags_json.bit_width;
  if (typeof position !== "number" || typeof width !== "number") { return undefined; }
  return {
    offset: offset_label(field.offset_bits - position),
    range: width === 1 ? `bit ${position}` : `bits ${position}-${position + width - 1}`,
    width,
  };
}

export function TypeFields({ fieldCount, typeId, typeKind }: { fieldCount: number; typeId: string; typeKind: KernelType["kind"] }) {
  const [open, set_open] = useState(false);
  const [fields, set_fields] = useState<KernelType["fields"]>([]);
  const [loaded, set_loaded] = useState(false);
  const [loading, set_loading] = useState(false);
  const [error, set_error] = useState("");
  const [query, set_query] = useState("");
  const [visible_count, set_visible_count] = useState(page_size);
  const filtered_fields = useMemo(() => {
    const value = query.trim().toLowerCase();
    if (!value) { return fields; }
    return fields.filter((field) =>
      field.name.toLowerCase().includes(value) ||
      field.field_type_name.toLowerCase().includes(value) ||
      String(field.flags_json.enum_value ?? "").toLowerCase().includes(value) ||
      offset_label(field.offset_bits).includes(value));
  }, [fields, query]);
  const visible_fields = filtered_fields.slice(0, visible_count);
  const enum_type = typeKind === "enum";

  useEffect(() => {
    if (!open || loaded) { return; }
    let cancelled = false;
    set_loading(true);
    set_error("");
    void api_json<KernelType>(`/api/v1/types/${typeId}`)
      .then((result) => {
        if (!cancelled) {
          set_fields(result.data.fields);
          set_loaded(true);
        }
      })
      .catch((reason: unknown) => {
        if (!cancelled) { set_error(reason instanceof Error ? reason.message : "Fields unavailable"); }
      })
      .finally(() => {
        if (!cancelled) { set_loading(false); }
      });
    return () => {
      cancelled = true;
    };
  }, [loaded, open, typeId]);

  return (
    <details className="group ka-panel rounded-xl" data-testid="type-fields" onToggle={(event) => set_open(event.currentTarget.open)}>
      <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-4 py-3">
        <span className="flex items-center gap-2 text-sm font-semibold text-zinc-100">
          {enum_type ? "Values" : "Members"}
          <ChevronDown className="h-4 w-4 text-zinc-500 transition-transform group-open:rotate-180" />
        </span>
        <Badge tone="blue">{fieldCount.toLocaleString()}</Badge>
      </summary>

      {open && (
        <div className="border-t border-white/10 p-4">
          {loading && <LoadingState compact detail="Reading cached PDB definitions" label={`Loading ${enum_type ? "enum values" : "type members"}`} rows={2} />}
          {!loading && error && <div className="rounded-md border border-red-400/20 bg-red-500/10 p-4 text-sm text-red-100">{error}</div>}
          {!loading && !error && loaded && (
            <>
          <div className="relative mb-4">
            <Search className="pointer-events-none absolute left-3 top-2.5 h-4 w-4 text-zinc-500" />
            <input
              className="h-10 w-full rounded-md border border-white/10 bg-black/30 pl-9 pr-3 text-sm text-zinc-100 outline-none placeholder:text-zinc-600 focus:border-cyan-300/70"
              onChange={(event) => {
                set_query(event.target.value);
                set_visible_count(page_size);
              }}
              placeholder={enum_type ? "Filter names or values" : "Filter members, types, or offsets"}
              value={query}
            />
          </div>

          <div className="grid gap-2 md:grid-cols-2">
            {visible_fields.map((field) => {
              const bitfield = bitfield_of(field);
              const offset = bitfield ? bitfield.offset : offset_label(field.offset_bits);
              const enum_value = typeof field.flags_json.enum_value === "string" ? field.flags_json.enum_value : undefined;
              return (
                <div className="rounded-md border border-white/10 bg-black/30 p-3" key={field.id}>
                  <div className="mb-2 flex items-center justify-between gap-3">
                    <span className="min-w-0 truncate font-mono text-sm text-zinc-100">{field.name}</span>
                    <Badge tone="zinc">{enum_type ? `= ${enum_value ?? "?"}` : offset}</Badge>
                  </div>
                  <div className="mb-3 truncate font-mono text-xs text-zinc-500">
                    {field.field_type_name}
                    {bitfield && <span className="text-cyan-200/70">{` : ${bitfield.width}`}</span>}
                    {bitfield && <span className="text-zinc-600">{`  ${bitfield.range}`}</span>}
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <CopyButton label={enum_type ? "Copy value" : "Copy offset"} value={enum_type ? enum_value ?? "" : offset} />
                    <CopyButton label={enum_type ? "Copy enumerator" : "Copy member"} value={enum_type ? `${field.name} = ${enum_value ?? "?"}` : `${field.name} = ${offset}`} />
                  </div>
                </div>
              );
            })}
          </div>

          {filtered_fields.length === 0 && <div className="rounded-md border border-white/10 bg-black/30 p-4 text-sm text-zinc-500">No matching fields.</div>}
          {visible_count < filtered_fields.length && (
            <div className="mt-4 flex justify-center">
              <Button icon={<ChevronDown className="h-4 w-4" />} onClick={() => set_visible_count((count) => count + page_size)}>
                Show {Math.min(page_size, filtered_fields.length - visible_count)} more
              </Button>
            </div>
          )}
            </>
          )}
        </div>
      )}
    </details>
  );
}
