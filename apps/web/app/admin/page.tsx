import { AdminAccountBar } from "@/components/admin-account-bar";
import { AdminIngestionPanel } from "@/components/admin-ingestion-panel";
import { require_admin_session } from "@/lib/auth-server";

export default async function AdminPage() {
  const user = await require_admin_session();
  return (
    <>
      <AdminAccountBar user={user} />
      {!user.must_change_password && <AdminIngestionPanel />}
    </>
  );
}
