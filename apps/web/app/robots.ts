import type { MetadataRoute } from "next";
import { site } from "@/lib/site";

export default function robots(): MetadataRoute.Robots {
  return {
    rules: [
      {
        userAgent: "*",
        allow: "/",
        // /api/v1 is deliberately crawlable. Disallowing it stopped the renderer
        // fetching the data every interactive part of the site is built from, so
        // anything drawn in the browser could never be indexed, and it also shut
        // out the AI agents that /llms.txt points at the API. The endpoints answer
        // with X-Robots-Tag: noindex instead, which keeps the JSON itself out of
        // results while still letting a crawler read it.
        disallow: ["/admin", "/admin/", "/login", "/api/v1/admin", "/api/docs"],
      },
    ],
    sitemap: `${site.url}/sitemap.xml`,
    host: site.url,
  };
}
