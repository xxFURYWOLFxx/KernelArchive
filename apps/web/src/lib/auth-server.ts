import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { api_base, read_api_response } from "./api";

export interface AdminSessionUser {
  id: string;
  username: string;
  role: "ADMIN";
  must_change_password: boolean;
}

// Only same-origin absolute paths may be redirected to after login; anything else
// falls back to /admin. A plain "starts with / but not //" check misses three cases.
// Browsers normalise a backslash to a slash, so "/\evil.com" leaves the site as
// "//evil.com". Control characters smuggle the same trick past a prefix test. And a
// repeated ?next= yields an array, where calling .startsWith would throw.
export function safe_next_path(value: unknown) {
  if (typeof value !== "string") { return "/admin"; }
  if (!value.startsWith("/") || value.startsWith("//")) { return "/admin"; }
  if (value.includes("\\")) { return "/admin"; }
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 0x20 || code === 0x7f) { return "/admin"; }
  }
  return value;
}

export async function read_admin_session() {
  const store = await cookies();
  const cookie_header = store.getAll().map((item) => `${item.name}=${encodeURIComponent(item.value)}`).join("; ");
  if (!cookie_header) { return undefined; }
  try {
    const response = await fetch(`${api_base}/api/v1/auth/session`, {
      cache: "no-store",
      headers: { cookie: cookie_header },
    });
    if (!response.ok) { return undefined; }
    const body = await read_api_response<{ data?: { user?: AdminSessionUser } }>(response);
    return body.data?.user as AdminSessionUser | undefined;
  } catch {
    return undefined;
  }
}

export async function require_admin_session() {
  const user = await read_admin_session();
  if (!user) { redirect("/admin/login?next=/admin"); }
  return user;
}
