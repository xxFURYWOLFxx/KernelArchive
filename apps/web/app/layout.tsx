import type { Metadata } from "next";
import { RouteChrome } from "@/components/route-chrome";
import { SiteFooter } from "@/components/site-footer";
import { Providers } from "@/providers";
import { site } from "@/lib/site";
import "./globals.css";

export const metadata: Metadata = {
  metadataBase: new URL(site.url),
  title: {
    default: site.name,
    template: `%s | ${site.name}`,
  },
  description: site.tagline,
  applicationName: site.name,
  authors: [{ name: site.author, url: site.author_url }],
  creator: site.author,
  keywords: ["Windows kernel", "PDB", "symbols", "ntoskrnl", "reverse engineering", "kernel structures", "signatures"],
  openGraph: {
    type: "website",
    siteName: site.name,
    title: site.name,
    description: site.tagline,
  },
  twitter: {
    card: "summary_large_image",
    title: site.name,
    description: site.tagline,
  },
  robots: {
    index: true,
    follow: true,
  },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>
        <Providers>
          <div className="flex min-h-screen flex-col">
            <div className="flex-1">
              <RouteChrome>{children}</RouteChrome>
            </div>
            <SiteFooter />
          </div>
        </Providers>
      </body>
    </html>
  );
}
