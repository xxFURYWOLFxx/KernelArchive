import type { MetadataRoute } from "next";
import { site } from "@/lib/site";

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
    sitemap: `${site.url}/sitemap.xml`,
    host: site.url,
  };
}
