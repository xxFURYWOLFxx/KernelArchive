// Single source of truth for branding, external links and legal dates.
// Everything user-facing that is not archive data should come from here so the
// footer, legal pages and metadata can never drift apart.

export const site = {
  name: "KernelArchive",
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
