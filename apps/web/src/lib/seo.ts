// Per-page metadata for archive pages.
//
// Every dynamic page used to inherit the layout's single title, so a crawler saw
// thousands of documents called "KernelArchive" and treated them as duplicates of
// one another. Titles and descriptions here carry the symbol, the module and the
// exact build, which is how these pages actually get searched for, and every page
// declares a canonical URL so the same symbol under different query strings does
// not compete with itself.
import type { Metadata } from "next";
import type { WindowsBuild } from "@kernelarchive/shared";
import { build_display_label } from "@kernelarchive/shared";
import { site } from "./site";

export function build_context_label(build?: WindowsBuild) {
  if (!build) { return ""; }
  // build_display_label already carries product, release, build number and
  // architecture. Composing it by hand here printed the architecture twice.
  return build_display_label(build);
}

export function noindex_metadata(title: string): Metadata {
  return {
    title,
    robots: { index: false, follow: false },
  };
}

export function page_metadata(options: {
  title: string;
  description: string;
  path: string;
  keywords?: string[];
}): Metadata {
  const canonical = `${site.url}${options.path}`;
  const full_title = `${options.title} | ${site.name}`;
  return {
    title: options.title,
    description: options.description,
    alternates: { canonical },
    ...(options.keywords && options.keywords.length > 0 ? { keywords: options.keywords } : {}),
    openGraph: {
      type: "article",
      siteName: site.name,
      title: full_title,
      description: options.description,
      url: canonical,
    },
    twitter: {
      card: "summary_large_image",
      title: full_title,
      description: options.description,
    },
  };
}
