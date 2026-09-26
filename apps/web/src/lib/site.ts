// Single source of truth for branding, external links and legal dates.
// Everything user-facing that is not archive data should come from here so the
// footer, legal pages and metadata can never drift apart.

// NEXT_PUBLIC_SITE_URL is inlined at build time. A production bundle built
// without it used to fall back to localhost, which shipped a sitemap and robots
// file pointing at a host no crawler can reach, so the public origin is the
// default and localhost is only used while developing.
function resolve_site_url() {
  const configured = process.env.NEXT_PUBLIC_SITE_URL?.trim().replace(/\/+$/, "");
  if (configured) { return configured; }
  if (process.env.NODE_ENV === "development") { return "http://localhost:3000"; }
  return "https://kernelarchive.com";
}

export const site = {
  name: "KernelArchive",
  url: resolve_site_url(),
  tagline: "Windows kernel symbol archive and PDB intelligence platform",
  author: "FURYWOLF",
  author_url: "https://furywolf.net",
  source_url: process.env.NEXT_PUBLIC_SOURCE_URL ?? "https://github.com/xxFURYWOLFxx/KernelArchive",
  contact_email: "abdulla1233244@gmail.com",
  // Set to an invite URL to show the Discord option on the contact page.
  discord_url: process.env.NEXT_PUBLIC_DISCORD_URL ?? "",
  // Set once an address exists; the footer and donate page stay hidden while empty.
  donate_btc: process.env.NEXT_PUBLIC_DONATE_BTC ?? "",
  legal_updated: "2026-08-07",
} as const;
