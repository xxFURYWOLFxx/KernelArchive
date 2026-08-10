import { mkdir, writeFile } from "node:fs/promises";

const base_url = process.env.API_BASE_URL ?? "http://localhost:4000";
const response = await fetch(`${base_url}/api/docs/json`);

if (!response.ok) {
  throw new Error(`openapi fetch failed: ${response.status}`);
}

await mkdir("dist", { recursive: true });
await writeFile("dist/openapi.json", await response.text());
console.log("dist/openapi.json");

