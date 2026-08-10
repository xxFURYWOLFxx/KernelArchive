import Link from "next/link";
import { Bitcoin, Github } from "lucide-react";
import { site } from "@/lib/site";

export function SiteFooter() {
  return (
    <footer className="border-t border-white/10 bg-[#05070d]/80 backdrop-blur-xl">
      <div className="mx-auto grid max-w-7xl gap-6 px-4 py-8 text-sm md:grid-cols-[1.6fr_1fr_1fr] xl:px-6">
        <div className="min-w-0">
          <p className="font-semibold text-zinc-100">{site.name}</p>
          <p className="mt-2 max-w-md text-zinc-500">{site.tagline}</p>
          <p className="mt-3 max-w-md text-xs leading-relaxed text-zinc-600">
            Self-hosted and free for the community. Symbol data is derived from Microsoft&apos;s public
            symbol server. Windows and Microsoft are trademarks of Microsoft Corporation. This project is
            not affiliated with or endorsed by Microsoft.
          </p>
        </div>

        <nav className="flex flex-col gap-2">
          <span className="text-xs font-medium uppercase tracking-wider text-zinc-500">Project</span>
          <a className="inline-flex w-fit items-center gap-2 text-zinc-400 transition-colors hover:text-cyan-200" href={site.source_url} rel="noreferrer noopener" target="_blank">
            <Github className="h-4 w-4" />
            Source on GitHub
          </a>
          <Link className="w-fit text-zinc-400 transition-colors hover:text-cyan-200" href="/api-docs">
            API documentation
          </Link>
          {site.donate_btc && (
            <Link className="inline-flex w-fit items-center gap-2 text-zinc-400 transition-colors hover:text-cyan-200" href="/donate">
              <Bitcoin className="h-4 w-4" />
              Donate
            </Link>
          )}
        </nav>

        <nav className="flex flex-col gap-2">
          <span className="text-xs font-medium uppercase tracking-wider text-zinc-500">Legal</span>
          <Link className="w-fit text-zinc-400 transition-colors hover:text-cyan-200" href="/terms">Terms of Service</Link>
          <Link className="w-fit text-zinc-400 transition-colors hover:text-cyan-200" href="/privacy">Privacy</Link>
          <Link className="w-fit text-zinc-400 transition-colors hover:text-cyan-200" href="/contact">Contact us</Link>
        </nav>
      </div>

      <div className="border-t border-white/5 px-4 py-4 xl:px-6">
        <div className="mx-auto max-w-7xl text-xs text-zinc-600">
          Built by{" "}
          <a className="font-medium text-zinc-400 transition-colors hover:text-cyan-200" href={site.author_url} rel="noreferrer noopener" target="_blank">
            {site.author}
          </a>
        </div>
      </div>
    </footer>
  );
}
