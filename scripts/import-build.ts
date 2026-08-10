import { readFile } from "node:fs/promises";

const file_path = process.argv[2];

if (!file_path) {
  console.error("usage: pnpm --filter @kernelarchive/scripts import-build <build.json>");
  process.exit(1);
}

const input = JSON.parse(await readFile(file_path, "utf8"));
const normalized = {
  product_name: String(input.product_name ?? input.productName ?? ""),
  version: String(input.version ?? ""),
  build_number: String(input.build_number ?? input.buildNumber ?? ""),
  revision: String(input.revision ?? "0"),
  architecture: String(input.architecture ?? "x64").toLowerCase(),
  modules: Array.isArray(input.modules) ? input.modules.length : 0,
};

console.log(JSON.stringify(normalized, null, 2));

