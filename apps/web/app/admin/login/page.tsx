import { Database, ShieldCheck } from "lucide-react";
import { redirect } from "next/navigation";
import { LoginForm } from "@/components/login-form";
import { read_admin_session, safe_next_path } from "@/lib/auth-server";

export default async function AdminLoginPage({ searchParams }: { searchParams: Promise<{ next?: string }> }) {
  const next_path = safe_next_path((await searchParams).next);
  if (await read_admin_session()) { redirect(next_path); }
  return (
    <main className="ka-bg flex min-h-screen items-center justify-center overflow-hidden px-4 py-10">
      <section className="ka-panel w-full max-w-sm rounded-xl p-6">
        <div className="mb-6 flex items-center gap-3">
          <span className="flex h-11 w-11 items-center justify-center rounded-md border border-cyan-300/40 bg-cyan-300/10">
            <Database className="h-5 w-5 text-cyan-100" />
          </span>
          <div className="min-w-0">
            <h1 className="text-lg font-semibold text-zinc-50">KernelArchive</h1>
            <div className="flex items-center gap-1.5 text-xs text-zinc-500"><ShieldCheck className="h-3.5 w-3.5" />Administrator</div>
          </div>
        </div>
        <LoginForm nextPath={next_path} />
      </section>
    </main>
  );
}
