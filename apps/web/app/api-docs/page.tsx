import type { Metadata } from "next";
import Link from "next/link";
import { Bot, Braces, ExternalLink, Gauge, KeyRound, ShieldAlert, Terminal } from "lucide-react";
import { Badge } from "@kernelarchive/ui";
import { CopyButton } from "@/components/copy-button";

export const metadata: Metadata = {
  title: "API reference",
  description: "Query Windows kernel symbols, type layouts and byte patterns as structured JSON.",
};

const endpoint_groups = [
  {
    title: "Builds and modules",
    endpoints: [
      ["GET", "/api/v1/builds", "List every indexed Windows build"],
      ["GET", "/api/v1/builds/catalog", "Build list with module, symbol and function counts"],
      ["GET", "/api/v1/builds/:buildId/modules", "Paged module list for one build"],
      ["GET", "/api/v1/builds/:buildId/types", "Every distinct type in a build"],
      ["GET", "/api/v1/modules/:moduleId", "Module metadata, PDB identity and counts"],
      ["GET", "/api/v1/modules/:moduleId/sections", "PE section table"],
      ["GET", "/api/v1/modules/:moduleId/imports", "PE imports"],
      ["GET", "/api/v1/modules/:moduleId/exports", "PE exports"],
      ["GET", "/api/v1/modules/:moduleId/download", "Download the indexed PE file"],
      ["GET", "/api/v1/packages/module?name=", "Zip of one module across every build"],
    ],
  },
  {
    title: "Symbols, types and functions",
    endpoints: [
      ["GET", "/api/v1/search?q=", "Search symbols, modules, functions and fields"],
      ["GET", "/api/v1/modules/:moduleId/types", "Types reconstructed from this module's PDB"],
      ["GET", "/api/v1/modules/:moduleId/functions", "Functions with RVA and prototype"],
      ["GET", "/api/v1/types/:typeId", "One type with full field layout"],
      ["GET", "/api/v1/types/:typeId/header", "Copy-paste C offset header"],
      ["GET", "/api/v1/types/:typeId/references", "Field and function cross-reference counts"],
      ["GET", "/api/v1/functions/:functionId", "One function with signature and RVA"],
    ],
  },
  {
    title: "Patterns",
    endpoints: [
      ["GET", "/api/v1/functions/:functionId/pattern", "Byte signature for a function"],
      ["GET", "/api/v1/functions/:functionId/pattern/xrefs", "The same pattern across every build"],
    ],
  },
  {
    title: "Machine-readable",
    endpoints: [
      ["GET", "/api/v1/openapi.json", "OpenAPI 3 document"],
      ["GET", "/api/v1/schemas", "Response schema manifest"],
      ["GET", "/api/v1/ai/manifest", "Capability manifest for agents"],
      ["GET", "/llms.txt", "Plain-text orientation for language models"],
    ],
  },
];

const example_request = `curl "https://<host>/api/v1/modules/mod_athw8x_sys_build_windows_11_26200_8875_x64_de129e570c85"`;

const example_response = `{
  "data": {
    "id": "mod_athw8x_sys_build_windows_11_26200_8875_x64_de129e570c85",
    "build_id": "build_windows_11_26200_8875_x64",
    "name": "athw8x.sys",
    "original_path": "\\\\SystemRoot\\\\System32\\\\drivers\\\\athw8x.sys",
    "image_base": "0x140000000",
    "image_size": 4354048,
    "entry_point": "0x00304240",
    "machine": "AMD64",
    "timestamp": "0x56a9e4f6",
    "checksum": "0x0040ec70",
    "sha256": "de129e570c85ee8aae8084b40f4e32766b4b789a2eed81e46311712b0826053d",
    "pdb_name": "athw8x.pdb",
    "pdb_guid": "CA08CAA9-2F22-496C-B964-AA4CEB10FF75",
    "pdb_age": 1,
    "symbol_count": 161,
    "type_count": 0,
    "function_count": 12592
  },
  "meta": {
    "request_id": "3f9c1b2e-...",
    "api_version": "v1",
    "source": "archive-database"
  }
}`;

const example_error = `{
  "error": {
    "code": "PAGE_TOO_DEEP",
    "message": "Reference pages stop at offset 5000. Narrow the result set with q instead.",
    "request_id": "13dd397a-d157-413d-be91-9ea0782c7cb7"
  }
}`;

function CodeBlock({ code, label }: { code: string; label?: string }) {
  return (
    <div className="relative">
      {label && <p className="mb-2 text-xs font-medium uppercase tracking-wider text-zinc-500">{label}</p>}
      <div className="absolute right-2 top-0 z-10">
        <CopyButton label="Copy" value={code} />
      </div>
      <pre className="ka-scroll min-w-0 max-w-full overflow-auto rounded-md border border-white/10 bg-black/45 p-3 font-mono text-xs leading-relaxed text-zinc-300">{code}</pre>
    </div>
  );
}

export default function ApiDocsPage() {
  return (
    <div className="grid min-w-0 gap-4 lg:grid-cols-[minmax(0,1fr)_340px]">
      <div className="min-w-0 space-y-4">
        <section className="ka-panel min-w-0 rounded-xl p-5">
          <div className="mb-3 flex items-center gap-2">
            <Bot className="h-4 w-4 text-cyan-300" />
            <h1 className="text-base font-semibold text-zinc-100">What this API is for</h1>
          </div>
          <div className="space-y-3 text-sm leading-relaxed text-zinc-400">
            <p>
              This API exists to be a <strong className="text-zinc-200">source of truth for Windows kernel
              internals</strong> for tooling, and especially for language models.
            </p>
            <p>
              Models trained on scraped code carry a fuzzy, averaged picture of the kernel. They mix up
              kernel-mode and user-mode APIs, invent plausible-looking structure fields, and quote offsets
              that were true for some build, once, somewhere. The failure is quiet: the answer looks right
              and the machine bugchecks.
            </p>
            <p>
              Everything here is extracted from real binaries and Microsoft&apos;s published PDBs, and every
              answer is pinned to <em className="text-zinc-300">one exact build</em>. Instead of recalling
              that <code className="rounded bg-black/40 px-1 py-0.5 font-mono text-xs text-cyan-100">_EPROCESS</code>{" "}
              has a field at some remembered offset, a model can look up the layout for 26100.8875 x64 and
              be correct, or find out the field does not exist in that build.
            </p>
            <p className="text-zinc-500">
              Start an agent at{" "}
              <Link className="text-cyan-200 underline decoration-cyan-300/40 underline-offset-2 hover:decoration-cyan-300" href="/llms.txt">/llms.txt</Link>{" "}
              or{" "}
              <Link className="text-cyan-200 underline decoration-cyan-300/40 underline-offset-2 hover:decoration-cyan-300" href="/api/v1/ai/manifest">/api/v1/ai/manifest</Link>.
            </p>
          </div>
        </section>

        <section className="ka-panel min-w-0 rounded-xl p-5">
          <div className="mb-4 flex items-center gap-2">
            <Terminal className="h-4 w-4 text-emerald-300" />
            <h2 className="text-base font-semibold text-zinc-100">Example request and response</h2>
          </div>
          <div className="space-y-4">
            <CodeBlock code={example_request} label="Request" />
            <CodeBlock code={example_response} label="Response: 200" />
            <p className="text-sm leading-relaxed text-zinc-400">
              Every successful response uses the same envelope: <code className="rounded bg-black/40 px-1 py-0.5 font-mono text-xs text-cyan-100">data</code> holds
              the result, an object here, an array on list endpoints, where{" "}
              <code className="rounded bg-black/40 px-1 py-0.5 font-mono text-xs text-cyan-100">pagination</code> is also
              present as <code className="rounded bg-black/40 px-1 py-0.5 font-mono text-xs text-cyan-100">{"{ page, limit, total }"}</code>.{" "}
              <code className="rounded bg-black/40 px-1 py-0.5 font-mono text-xs text-cyan-100">meta.request_id</code> identifies
              the call in server logs. Quote it when reporting a problem.
            </p>
            <CodeBlock code={example_error} label="Response: 4xx and 5xx" />
            <p className="text-sm leading-relaxed text-zinc-400">
              Errors never use the success envelope. Branch on the HTTP status, then on{" "}
              <code className="rounded bg-black/40 px-1 py-0.5 font-mono text-xs text-cyan-100">error.code</code>, which is
              stable; <code className="rounded bg-black/40 px-1 py-0.5 font-mono text-xs text-cyan-100">error.message</code> is
              written for humans and may be reworded.
            </p>
          </div>
        </section>

        <section className="ka-panel min-w-0 rounded-xl p-5">
          <div className="mb-4 flex items-center gap-2">
            <Gauge className="h-4 w-4 text-amber-300" />
            <h2 className="text-base font-semibold text-zinc-100">Rate limits</h2>
          </div>
          <div className="space-y-4 text-sm leading-relaxed text-zinc-400">
            <p>
              Limits are counted per IP address over a rolling one-minute window. Exceeding one returns{" "}
              <code className="rounded bg-black/40 px-1 py-0.5 font-mono text-xs text-cyan-100">429 Too Many Requests</code>.
            </p>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[420px] border-collapse text-sm">
                <thead>
                  <tr className="border-b border-white/10 text-left text-xs uppercase tracking-wider text-zinc-500">
                    <th className="py-2 pr-4 font-medium">Tier</th>
                    <th className="py-2 pr-4 font-medium">Requests / minute</th>
                    <th className="py-2 font-medium">How to use it</th>
                  </tr>
                </thead>
                <tbody className="text-zinc-400">
                  <tr className="border-b border-white/5">
                    <td className="py-2 pr-4 text-zinc-200">Anonymous</td>
                    <td className="py-2 pr-4 font-mono text-cyan-100">300</td>
                    <td className="py-2">No key needed. Suits browsing and normal tooling.</td>
                  </tr>
                  <tr>
                    <td className="py-2 pr-4 text-zinc-200">API key</td>
                    <td className="py-2 pr-4 font-mono text-cyan-100">1200</td>
                    <td className="py-2">
                      Send <code className="rounded bg-black/40 px-1 py-0.5 font-mono text-xs text-cyan-100">x-api-key</code> on every request.
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
            <CodeBlock code={`curl -H "x-api-key: $KERNELARCHIVE_API_KEY" \\
  "https://<host>/api/v1/builds/catalog"`} label="Authenticated request" />
            <div className="rounded-md border border-amber-300/25 bg-amber-300/5 p-3">
              <p className="flex items-start gap-2 text-xs text-amber-100/90">
                <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0" />
                <span>
                  Read endpoints are cached for a few seconds and served with{" "}
                  <code className="font-mono">Cache-Control: public, max-age=5, stale-while-revalidate=30</code>. Honour
                  it. Repeating an identical query in a tight loop spends your quota on a response you already
                  have. Pattern and admin routes are always <code className="font-mono">no-store</code>.
                </span>
              </p>
            </div>
            <p>
              If you hit 429, back off rather than retrying immediately. For a legitimate bulk project, ask for
              a key instead of working around the limit.
            </p>
          </div>
        </section>

        <section className="ka-panel min-w-0 rounded-xl p-5">
          <div className="mb-4 flex items-center gap-2">
            <Braces className="h-4 w-4 text-cyan-300" />
            <h2 className="text-base font-semibold text-zinc-100">Endpoints</h2>
          </div>
          <div className="space-y-6">
            {endpoint_groups.map((group) => (
              <div key={group.title}>
                <h3 className="mb-2 text-xs font-medium uppercase tracking-wider text-zinc-500">{group.title}</h3>
                <div className="divide-y divide-white/5">
                  {group.endpoints.map(([method, path, description]) => (
                    <div className="grid min-w-0 items-baseline gap-2 py-2.5 md:grid-cols-[64px_minmax(0,300px)_minmax(0,1fr)] md:gap-3" key={path}>
                      <Badge tone={method === "GET" ? "green" : "blue"}>{method}</Badge>
                      <code className="min-w-0 break-all font-mono text-sm text-zinc-100">{path}</code>
                      <span className="text-sm text-zinc-400">{description}</span>
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </section>
      </div>

      <aside className="min-w-0 space-y-4">
        <div className="ka-panel rounded-xl p-4">
          <h2 className="mb-3 text-sm font-semibold text-zinc-100">Conventions</h2>
          <dl className="space-y-3 text-sm text-zinc-400">
            <div>
              <dt className="text-zinc-300">Paging</dt>
              <dd><code className="font-mono text-xs text-cyan-100">?page=</code> from 1, <code className="font-mono text-xs text-cyan-100">?limit=</code> up to 100.</dd>
            </div>
            <div>
              <dt className="text-zinc-300">Filtering</dt>
              <dd><code className="font-mono text-xs text-cyan-100">?q=</code> on list endpoints, up to 128 characters.</dd>
            </div>
            <div>
              <dt className="text-zinc-300">Versioning</dt>
              <dd>Everything lives under <code className="font-mono text-xs text-cyan-100">/api/v1</code>. Breaking changes get a new prefix.</dd>
            </div>
            <div>
              <dt className="text-zinc-300">Addresses</dt>
              <dd>RVAs are hex strings such as <code className="font-mono text-xs text-cyan-100">0x00a1b2c0</code>, relative to the image base.</dd>
            </div>
          </dl>
        </div>

        <div className="ka-panel rounded-xl p-4">
          <div className="mb-3 flex items-center gap-2">
            <KeyRound className="h-4 w-4 text-amber-300" />
            <h2 className="text-sm font-semibold text-zinc-100">Machine-readable</h2>
          </div>
          <div className="space-y-2">
            <Link className="inline-flex h-9 w-full items-center justify-center gap-2 rounded-md border border-cyan-400/60 bg-cyan-400/15 px-3 text-sm font-medium text-cyan-100 transition-colors hover:bg-cyan-400/25" href="/api/v1/openapi.json" target="_blank">
              <ExternalLink className="h-4 w-4" />
              OpenAPI document
            </Link>
            <Link className="inline-flex h-9 w-full items-center justify-center gap-2 rounded-md border border-white/10 bg-black/30 px-3 text-sm text-zinc-300 transition-colors hover:border-cyan-300/60 hover:text-cyan-100" href="/api/docs" target="_blank">
              <ExternalLink className="h-4 w-4" />
              Swagger UI
            </Link>
            <Link className="inline-flex h-9 w-full items-center justify-center gap-2 rounded-md border border-white/10 bg-black/30 px-3 text-sm text-zinc-300 transition-colors hover:border-cyan-300/60 hover:text-cyan-100" href="/llms.txt" target="_blank">
              <ExternalLink className="h-4 w-4" />
              llms.txt
            </Link>
          </div>
        </div>

        <div className="ka-panel rounded-xl p-4">
          <h2 className="mb-2 text-sm font-semibold text-zinc-100">Accuracy</h2>
          <p className="text-sm leading-relaxed text-zinc-400">
            Layouts and patterns come from automated analysis and are pinned to a specific build. Verify against
            the binary before shipping kernel-mode code. See the{" "}
            <Link className="text-cyan-200 underline decoration-cyan-300/40 underline-offset-2 hover:decoration-cyan-300" href="/terms">Terms</Link>.
          </p>
        </div>
      </aside>
    </div>
  );
}
