import { PrismaClient } from "@prisma/client";
import { parse_hex, section_for_rva } from "@kernelarchive/shared";
import { find_module, list_functions, sample_builds, sample_modules, sample_types } from "@kernelarchive/shared/sample-data";

const db = new PrismaClient();

async function main() {
  for (const build of sample_builds) {
    await db.windowsBuild.upsert({
      where: {
        build_number_revision_architecture: {
          build_number: build.build_number,
          revision: build.revision,
          architecture: build.architecture.toUpperCase() as "X64" | "ARM64" | "X86",
        },
      },
      update: {},
      create: {
        id: build.id,
        product_name: build.product_name,
        version: build.version,
        build_number: build.build_number,
        revision: build.revision,
        architecture: build.architecture.toUpperCase() as "X64" | "ARM64" | "X86",
        release_channel: build.release_channel,
        published: build.published,
      },
    });
  }

  for (const module of sample_modules) {
    await db.module.upsert({
      where: { sha256: module.sha256 },
      update: {},
      create: {
        id: module.id,
        build_id: module.build_id,
        name: module.name,
        original_path: module.original_path,
        image_base: module.image_base,
        image_size: module.image_size,
        timestamp: module.timestamp,
        checksum: module.checksum,
        sha256: module.sha256,
        pdb_name: module.pdb_name,
        pdb_guid: module.pdb_guid,
        pdb_age: module.pdb_age,
      },
    });
  }

  for (const type of sample_types) {
    await db.kernelType.upsert({
      where: { id: type.id },
      update: {},
      create: {
        id: type.id,
        module_id: type.module_id,
        name: type.name,
        kind: type.kind,
        size: type.size,
        alignment: type.alignment,
        reconstructed_c: type.reconstructed_c,
        hash: type.hash,
        fields: {
          create: type.fields.map((field) => ({
            id: field.id,
            name: field.name,
            field_type_name: field.field_type_name,
            offset_bits: field.offset_bits,
            size_bits: field.size_bits,
            flags_json: field.flags_json,
          })),
        },
      },
    });
  }

  for (const fn of list_functions()) {
    const module = find_module(fn.module_id);
    const section = section_for_rva(module, parse_hex(fn.rva));
    const symbol = await db.symbol.upsert({
      where: { id: fn.symbol_id },
      update: {},
      create: {
        id: fn.symbol_id,
        module_id: fn.module_id,
        name: fn.name,
        undecorated_name: fn.name,
        kind: "function",
        rva: fn.rva,
        size: fn.size,
        section_name: section?.name ?? "unknown",
        is_exported: fn.is_exported,
        is_public: true,
        source: "pdb",
      },
    });

    await db.kernelFunction.upsert({
      where: { id: fn.id },
      update: {},
      create: {
        id: fn.id,
        symbol_id: symbol.id,
        module_id: fn.module_id,
        name: fn.name,
        return_type: fn.return_type,
        calling_convention: fn.calling_convention,
        parameters_json: fn.parameters_json,
        rva: fn.rva,
        size: fn.size,
        confidence: fn.confidence,
        has_pattern: fn.has_pattern,
      },
    });
  }
}

main()
  .finally(async () => {
    await db.$disconnect();
  });
