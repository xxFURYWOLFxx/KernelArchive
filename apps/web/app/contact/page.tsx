import type { Metadata } from "next";
import { LegalPage, LegalSection } from "@/components/legal-page";
import { site } from "@/lib/site";

export const metadata: Metadata = {
  title: "Contact",
  description: `How to reach the maintainer of ${site.name}.`,
};

export default function ContactPage() {
  return (
    <LegalPage dated={false} subtitle="Questions, corrections, takedown requests and security reports." title="Contact us">
      <LegalSection heading="Email">
        <p>
          <a className="font-mono text-cyan-200 underline decoration-cyan-300/40 underline-offset-2 hover:decoration-cyan-300" href={`mailto:${site.contact_email}`}>
            {site.contact_email}
          </a>
        </p>
        <p>The most reliable way to reach us. Expect a reply within a few days.</p>
      </LegalSection>

      {site.discord_url && (
        <LegalSection heading="Discord">
          <p>
            <a className="text-cyan-200 underline decoration-cyan-300/40 underline-offset-2 hover:decoration-cyan-300" href={site.discord_url} rel="noreferrer noopener" target="_blank">
              Join the Discord server
            </a>
          </p>
          <p>Best for quick questions, bug reports and discussing archive data.</p>
        </LegalSection>
      )}

      <LegalSection heading="Takedown requests">
        <p>
          If you believe material in this archive infringes your rights or should not be published, email
          us with enough detail to identify the material. Well-founded requests are honoured promptly.
        </p>
      </LegalSection>

      <LegalSection heading="Security reports">
        <p>
          Please report vulnerabilities privately by email rather than opening a public issue. Include
          what the issue is, how to reproduce it, and what an attacker could achieve. Please allow a
          reasonable window for a fix before disclosing publicly.
        </p>
      </LegalSection>

      <LegalSection heading="Bulk API access">
        <p>
          Automated access is welcome within the published rate limits. If your project needs more than
          that, get in touch rather than working around the limits.
        </p>
      </LegalSection>
    </LegalPage>
  );
}
