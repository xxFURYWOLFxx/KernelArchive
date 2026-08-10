import type { Metadata } from "next";
import { LegalPage, LegalSection } from "@/components/legal-page";
import { site } from "@/lib/site";

export const metadata: Metadata = {
  title: "Terms of Service",
  description: `Terms governing use of ${site.name}.`,
};

export default function TermsPage() {
  return (
    <LegalPage subtitle={`The rules for using ${site.name}. Plain language, no surprises.`} title="Terms of Service">
      <LegalSection heading="1. What this service is">
        <p>
          {site.name} is a free, self-hosted index of Windows kernel symbols, type layouts and byte
          patterns, derived by analysing Microsoft&apos;s publicly published debug symbols (PDBs) and
          the corresponding system binaries. It exists as a research and interoperability reference
          for driver developers, security researchers and reverse engineers.
        </p>
        <p>
          It does not host or redistribute Windows binaries or PDB files. What it stores is derived
          information about them: symbol names, field offsets, structure sizes and addresses.
        </p>
        <p>
          It is operated by {site.author} as a personal project and provided at no cost. There is no
          company behind it, no paid tier, and no service level agreement.
        </p>
      </LegalSection>

      <LegalSection heading="2. No affiliation with Microsoft">
        <p>
          {site.name} is not affiliated with, sponsored by, or endorsed by Microsoft Corporation.
          Windows, Microsoft and related names are trademarks of Microsoft Corporation.
        </p>
        <p>
          The indexed data is derived from Microsoft Windows binaries and Microsoft public symbol
          files, and Microsoft retains all applicable rights in those materials. Nothing granted by
          this service covers them. You are responsible for ensuring your use of that data complies
          with any licence or terms that apply to it in your jurisdiction and situation.
        </p>
      </LegalSection>

      <LegalSection heading="3. Acceptable use">
        <p>You may browse the archive, query the API, and use the data in your own research and tooling. You may not:</p>
        <ul className="list-disc space-y-1 pl-5">
          <li>attempt to disrupt, overload or degrade the service, or circumvent rate limits;</li>
          <li>probe, scan or test the security of the service without permission;</li>
          <li>attempt to gain access to administrative functions or other users&apos; sessions;</li>
          <li>use automated bulk downloading in a way that denies service to others;</li>
          <li>redistribute the archive in a way that misrepresents its origin or implies endorsement.</li>
        </ul>
        <p>
          Automated access is welcome within the published rate limits. If you need bulk access for a
          legitimate project, please get in touch rather than scraping around the limits.
        </p>
      </LegalSection>

      <LegalSection heading="4. Availability and changes">
        <p>
          The service may be slow, unavailable, or discontinued at any time without notice. Data may be
          re-indexed, corrected or removed. Endpoints and response shapes may change; the API is
          versioned, and breaking changes are the reason the version prefix exists.
        </p>
      </LegalSection>

      <LegalSection heading="5. No warranty">
        <p>
          The service and its data are provided &quot;as is&quot;, without warranty of any kind, express
          or implied, including but not limited to warranties of merchantability, fitness for a
          particular purpose, accuracy and non-infringement.
        </p>
        <p>
          Symbol offsets, type layouts and generated patterns are produced by automated analysis and may
          be incomplete or wrong. <strong className="text-zinc-300">Do not rely on this data for anything
          safety-critical.</strong> Kernel-mode code written against incorrect offsets will crash machines.
          Verify against the actual binary before you ship.
        </p>
      </LegalSection>

      <LegalSection heading="6. Limitation of liability">
        <p>
          To the maximum extent permitted by law, {site.author} shall not be liable for any indirect,
          incidental, special, consequential or punitive damages, or any loss of data, systems, profits
          or revenue, arising from your use of or inability to use the service, including damage caused
          by acting on data obtained here.
        </p>
      </LegalSection>

      <LegalSection heading="7. Takedown requests">
        <p>
          If you believe material in this archive infringes your rights or should not be published, get
          in touch through the{" "}
          <a className="text-cyan-200 underline decoration-cyan-300/40 underline-offset-2 hover:decoration-cyan-300" href="/contact">
            contact page
          </a>{" "}
          with enough detail to identify the material. Well-founded requests are honoured promptly.
        </p>
      </LegalSection>

      <LegalSection heading="8. Source code">
        <p>
          The source code behind {site.name} is published at{" "}
          <a className="text-cyan-200 underline decoration-cyan-300/40 underline-offset-2 hover:decoration-cyan-300" href={site.source_url} rel="noreferrer noopener" target="_blank">
            GitHub
          </a>
          . Whatever licence the repository carries governs that code and nothing else. It grants no
          rights over the indexed data, which is derived from Microsoft&apos;s materials and remains
          Microsoft&apos;s.
        </p>
      </LegalSection>

      <LegalSection heading="9. Changes to these terms">
        <p>
          These terms may be updated. The date at the top reflects the current version, and continued
          use after a change constitutes acceptance of it.
        </p>
      </LegalSection>
    </LegalPage>
  );
}
