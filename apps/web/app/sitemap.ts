import type { MetadataRoute } from "next";

const site_url = process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3000";

// Static entry points only. Per-build and per-module pages are generated from a
// multi-million-row archive; listing them would produce a sitemap no crawler wants
// and would cost a full table scan to build.
const routes = [
  { path: "/", priority: 1, frequency: "daily" as const },
  { path: "/explorer", priority: 0.9, frequency: "daily" as const },
  { path: "/builds", priority: 0.9, frequency: "daily" as const },
  { path: "/search", priority: 0.7, frequency: "weekly" as const },
  { path: "/patterns", priority: 0.7, frequency: "weekly" as const },
  { path: "/api-docs", priority: 0.8, frequency: "weekly" as const },
  { path: "/terms", priority: 0.3, frequency: "yearly" as const },
  { path: "/privacy", priority: 0.3, frequency: "yearly" as const },
];

export default function sitemap(): MetadataRoute.Sitemap {
  const now = new Date();
  return routes.map((route) => ({
    url: `${site_url}${route.path}`,
    lastModified: now,
    changeFrequency: route.frequency,
    priority: route.priority,
  }));
}
