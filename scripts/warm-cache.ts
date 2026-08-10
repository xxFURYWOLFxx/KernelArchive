const base_url = process.env.API_BASE_URL ?? "http://localhost:4000";
const paths = [
  "/api/v1/health",
  "/api/v1/builds",
  "/api/v1/search?q=_EPROCESS",
  "/api/v1/ai/manifest",
];

for (const path of paths) {
  const response = await fetch(`${base_url}${path}`);
  console.log(`${response.status} ${path}`);
}

export {};
