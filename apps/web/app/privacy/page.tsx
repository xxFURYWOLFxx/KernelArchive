import type { Metadata } from "next";
import { LegalPage, LegalSection } from "@/components/legal-page";
import { site } from "@/lib/site";

export const metadata: Metadata = {
  title: "Privacy",
  description: `How ${site.name} handles data.`,
};

export default function PrivacyPage() {
  return (
    <LegalPage subtitle="What is collected, why, and what is not." title="Privacy">
      <LegalSection heading="The short version">
        <p>
          There are no analytics, no advertising, no third-party trackers and no cookies for visitors.
          Browsing the archive and querying the API are anonymous.
        </p>
      </LegalSection>

      <LegalSection heading="Server logs">
        <p>
          The API writes operational logs for each request: the path, method, response status, response
          time and the originating IP address. These exist to diagnose faults and to detect abuse. They
          are not used to build profiles and are not shared with anyone.
        </p>
      </LegalSection>

      <LegalSection heading="Rate limiting">
        <p>
          Request counts are held in memory per IP address for a short rolling window so that limits can
          be enforced. This state is transient and is lost when the server restarts.
        </p>
      </LegalSection>

      <LegalSection heading="Cookies">
        <p>
          The site sets no cookies for visitors. The single cookie that exists,{" "}
          <code className="rounded bg-black/40 px-1 py-0.5 font-mono text-xs text-cyan-100">kernelarchive_session</code>,
          is only ever set when the owner signs in to administer the archive. It is marked{" "}
          <code className="rounded bg-black/40 px-1 py-0.5 font-mono text-xs text-cyan-100">HttpOnly</code> and{" "}
          <code className="rounded bg-black/40 px-1 py-0.5 font-mono text-xs text-cyan-100">SameSite=Strict</code>,
          and carries the <code className="rounded bg-black/40 px-1 py-0.5 font-mono text-xs text-cyan-100">Secure</code> flag
          over HTTPS.
        </p>
      </LegalSection>

      <LegalSection heading="Archive content">
        <p>
          The indexed data, meaning module names, symbol names, type layouts and byte patterns, is
          derived from Microsoft&apos;s publicly published debug symbols and from Windows system
          binaries. It contains no personal data.
        </p>
      </LegalSection>

      <LegalSection heading="Data requests">
        <p>
          There are no visitor accounts, so in normal use there is nothing to export or delete. For
          anything else, use the{" "}
          <a className="text-cyan-200 underline decoration-cyan-300/40 underline-offset-2 hover:decoration-cyan-300" href="/contact">
            contact page
          </a>
          .
        </p>
      </LegalSection>
    </LegalPage>
  );
}
