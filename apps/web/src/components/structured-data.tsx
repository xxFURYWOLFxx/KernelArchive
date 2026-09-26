// Schema.org descriptions of what a page holds.
//
// Search engines cannot tell from markup alone that a page is a struct layout
// for one exact Windows build rather than a blog post about one. These blocks
// say so directly, which is what earns the search box on the site result and the
// breadcrumb trail under it.
import { site } from "@/lib/site";

// The payload is built here from archive data, never from user input, and the
// only character that can break out of a script element is escaped.
function serialize(data: unknown) {
  return JSON.stringify(data).replace(/</g, "\\u003c");
}

export function StructuredData({ data }: { data: unknown }) {
  return <script dangerouslySetInnerHTML={{ __html: serialize(data) }} type="application/ld+json" />;
}

export function SiteStructuredData() {
  return (
    <StructuredData
      data={{
        "@context": "https://schema.org",
        "@graph": [
          {
            "@type": "WebSite",
            "@id": `${site.url}/#website`,
            url: site.url,
            name: site.name,
            description: site.tagline,
            inLanguage: "en",
            potentialAction: {
              "@type": "SearchAction",
              target: { "@type": "EntryPoint", urlTemplate: `${site.url}/search?q={search_term_string}` },
              "query-input": "required name=search_term_string",
            },
          },
          {
            "@type": "Dataset",
            "@id": `${site.url}/#dataset`,
            name: `${site.name} Windows kernel symbol archive`,
            description: "Windows kernel symbols, type layouts, field offsets and byte patterns, derived from Microsoft's public debug symbols and pinned to exact Windows builds.",
            url: site.url,
            isAccessibleForFree: true,
            keywords: ["Windows kernel", "PDB symbols", "struct offsets", "reverse engineering", "ntoskrnl"],
            creator: { "@type": "Person", name: site.author },
            distribution: {
              "@type": "DataDownload",
              encodingFormat: "application/json",
              contentUrl: `${site.url}/api/v1/search`,
            },
          },
        ],
      }}
    />
  );
}

export function BreadcrumbStructuredData({ trail }: { trail: Array<{ name: string; path: string }> }) {
  return (
    <StructuredData
      data={{
        "@context": "https://schema.org",
        "@type": "BreadcrumbList",
        itemListElement: trail.map((crumb, index) => ({
          "@type": "ListItem",
          position: index + 1,
          name: crumb.name,
          item: `${site.url}${crumb.path}`,
        })),
      }}
    />
  );
}
