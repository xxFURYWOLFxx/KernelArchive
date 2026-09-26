import { AdminAccountBar } from "@/components/admin-account-bar";
import type { Metadata } from "next";
import { noindex_metadata } from "@/lib/seo";
import { AdminIngestionPanel } from "@/components/admin-ingestion-panel";
import { require_admin_session } from "@/lib/auth-server";

export const metadata: Metadata = noindex_metadata("Administration");

export default async function AdminPage() {
  const user = await require_admin_session();
  return (
    <>
      <AdminAccountBar user={user} />
      {!user.must_change_password && <AdminIngestionPanel />}
    </>
  );
}
