"use client";

import { useState, type FormEvent } from "react";
import { KeyRound, LoaderCircle, LogOut, ShieldAlert, ShieldCheck } from "lucide-react";
import { Button } from "@kernelarchive/ui";
import { api_base, read_api_response, type ApiEnvelope } from "@/lib/api";
import type { AdminSessionUser } from "@/lib/auth-server";

export function AdminAccountBar({ user }: { user: AdminSessionUser }) {
  const [must_change_password, set_must_change_password] = useState(user.must_change_password);
  const [current_password, set_current_password] = useState("");
  const [new_password, set_new_password] = useState("");
  const [confirm_password, set_confirm_password] = useState("");
  const [loading_action, set_loading_action] = useState<"" | "logout" | "password">("");
  const [message, set_message] = useState("");
  const [error, set_error] = useState("");

  async function logout() {
    set_loading_action("logout");
    try {
      await fetch(`${api_base}/api/v1/auth/logout`, { method: "POST", credentials: "include" });
    } finally {
      window.location.replace("/admin/login");
    }
  }

  async function change_password(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    set_error("");
    set_message("");
    if (new_password !== confirm_password) {
      set_error("New passwords do not match.");
      return;
    }
    set_loading_action("password");
    try {
      const response = await fetch(`${api_base}/api/v1/auth/change-password`, {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ current_password, new_password }),
      });
      await read_api_response<ApiEnvelope<unknown>>(response);
      set_current_password("");
      set_new_password("");
      set_confirm_password("");
      set_message("Password changed.");
      set_must_change_password(false);
      window.location.reload();
    } catch (request_error) {
      set_error(request_error instanceof Error ? request_error.message : "Password change failed");
    } finally {
      set_loading_action("");
    }
  }

  return (
    <section className="ka-panel mb-4 rounded-xl">
      <div className="flex items-center justify-between gap-3 px-4 py-3">
        <span className="flex min-w-0 items-center gap-2 text-sm text-zinc-100">
          <ShieldCheck className="h-4 w-4 shrink-0 text-emerald-300" />
          <span className="truncate font-medium">{user.username}</span>
          <span className="text-xs text-zinc-500">Administrator</span>
          {must_change_password && <span className="rounded bg-amber-400/15 px-2 py-1 text-xs text-amber-100">password change required</span>}
        </span>
        <Button disabled={Boolean(loading_action)} icon={loading_action === "logout" ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <LogOut className="h-4 w-4" />} onClick={() => void logout()}>{loading_action === "logout" ? "Signing out" : "Sign out"}</Button>
      </div>
      {must_change_password && (
        <div className="flex items-start gap-2 border-t border-amber-300/20 bg-amber-400/10 px-4 py-3 text-sm text-amber-100">
          <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0" />
          Replace the temporary password to unlock ingestion and other administrator actions.
        </div>
      )}
      <details className="group border-t border-white/10" open={must_change_password || undefined}>
        <summary className="cursor-pointer px-4 py-3 text-sm font-medium text-zinc-300">Change password</summary>
        <form className="grid gap-3 border-t border-white/10 p-4 md:grid-cols-3" onSubmit={change_password}>
          <input autoComplete="current-password" className="h-10 rounded-md border border-white/10 bg-black/30 px-3 text-sm text-zinc-100 outline-none focus:border-cyan-300/70" onChange={(event) => set_current_password(event.target.value)} placeholder="Current password" required type="password" value={current_password} />
          <input autoComplete="new-password" className="h-10 rounded-md border border-white/10 bg-black/30 px-3 text-sm text-zinc-100 outline-none focus:border-cyan-300/70" onChange={(event) => set_new_password(event.target.value)} placeholder="New password" required type="password" value={new_password} />
          <input autoComplete="new-password" className="h-10 rounded-md border border-white/10 bg-black/30 px-3 text-sm text-zinc-100 outline-none focus:border-cyan-300/70" onChange={(event) => set_confirm_password(event.target.value)} placeholder="Confirm password" required type="password" value={confirm_password} />
          <div className="flex flex-wrap items-center gap-3 md:col-span-3">
            <Button disabled={Boolean(loading_action)} icon={loading_action === "password" ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <KeyRound className="h-4 w-4" />} type="submit">{loading_action === "password" ? "Changing password" : "Change password"}</Button>
            {message && <span className="text-sm text-emerald-200">{message}</span>}
            {error && <span className="text-sm text-red-200">{error}</span>}
          </div>
        </form>
      </details>
    </section>
  );
}
