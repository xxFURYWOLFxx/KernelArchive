import { redirect } from "next/navigation";
import type { Metadata } from "next";
import { noindex_metadata } from "@/lib/seo";
import { safe_next_path } from "@/lib/auth-server";

export const metadata: Metadata = noindex_metadata("Sign in");

export default async function LegacyLoginPage({ searchParams }: { searchParams: Promise<{ next?: string }> }) {
  const next_path = safe_next_path((await searchParams).next);
  redirect(`/admin/login?next=${encodeURIComponent(next_path)}`);
}
