import { redirect } from "next/navigation";
import { safe_next_path } from "@/lib/auth-server";

export default async function LegacyLoginPage({ searchParams }: { searchParams: Promise<{ next?: string }> }) {
  const next_path = safe_next_path((await searchParams).next);
  redirect(`/admin/login?next=${encodeURIComponent(next_path)}`);
}
