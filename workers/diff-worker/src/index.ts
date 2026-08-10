import { readFile } from "node:fs/promises";

type Field = { name: string; offset_bits?: number; field_type_name?: string };
type TypeRecord = { name: string; size?: number; fields?: Field[] };

const [, , from_path, to_path] = process.argv;

if (!from_path || !to_path) {
  console.error("usage: pnpm --filter @kernelarchive/diff-worker dev <from.json> <to.json>");
  process.exit(1);
}

const from_type = JSON.parse(await readFile(from_path, "utf8")) as TypeRecord;
const to_type = JSON.parse(await readFile(to_path, "utf8")) as TypeRecord;
const changes: Array<{ kind: string; path: string; before: unknown; after: unknown }> = [];

if (from_type.size !== to_type.size) {
  changes.push({ kind: "size", path: "size", before: from_type.size, after: to_type.size });
}

const from_fields = new Map((from_type.fields ?? []).map((field) => [field.name, field]));
const to_fields = new Map((to_type.fields ?? []).map((field) => [field.name, field]));

for (const [name, field] of to_fields) {
  const previous = from_fields.get(name);
  if (!previous) {
    changes.push({ kind: "field_added", path: name, before: null, after: field });
    continue;
  }
  if (previous.offset_bits !== field.offset_bits) {
    changes.push({ kind: "field_offset", path: name, before: previous.offset_bits, after: field.offset_bits });
  }
  if (previous.field_type_name !== field.field_type_name) {
    changes.push({ kind: "field_type", path: name, before: previous.field_type_name, after: field.field_type_name });
  }
}

for (const [name, field] of from_fields) {
  if (!to_fields.has(name)) {
    changes.push({ kind: "field_removed", path: name, before: field, after: null });
  }
}

console.log(JSON.stringify({
  entity_kind: "type",
  entity_name: to_type.name || from_type.name,
  summary: `${changes.length} change(s)`,
  changes,
}, null, 2));

