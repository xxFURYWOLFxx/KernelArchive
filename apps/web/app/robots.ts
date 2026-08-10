import type { MetadataRoute } from "next";

const site_url = process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3000";

export default function robots(): MetadataRoute.Robots {
  return {
    rules: [
      {
        userAgent: "*",
        allow: "/",
        // Admin is session-gated and the API is documented at /api-docs; neither
        // benefits from being crawled, and crawling the API spends the rate limit.
        disallow: ["/admin", "/admin/", "/login", "/api/"],
      },
    ],
    sitemap: `${site_url}/sitemap.xml`,
  };
}
