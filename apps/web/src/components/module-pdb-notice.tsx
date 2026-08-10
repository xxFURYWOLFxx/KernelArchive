"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { CircleCheckBig, Database, RefreshCw, ShieldAlert, SquareX, TriangleAlert } from "lucide-react";
import { Badge, Button } from "@kernelarchive/ui";
import type { ModulePdbStatus } from "@kernelarchive/shared";
import { api_base, read_api_response } from "@/lib/api";

interface StatusEnvelope {
  data?: ModulePdbStatus;
  error?: { message?: string };
}

function checked_label(value: string | undefined) {
  if (!value) { return ""; }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) { return value; }
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(date);
}

export function ModulePdbNotice({ initial_status, module_id }: { initial_status: ModulePdbStatus; module_id: string }) {
  const [status, set_status] = useState(initial_status);
  const [retrying, set_retrying] = useState(false);
  const [polling, set_polling] = useState(initial_status.checking);
  const [error, set_error] = useState("");
  const [needs_login, set_needs_login] = useState(false);

  useEffect(() => {
    if (!polling) { return; }
    let cancelled = false;
    let timer: number | undefined;

    const poll = async () => {
      try {
        const response = await fetch(`${api_base}/api/v1/modules/${encodeURIComponent(module_id)}/pdb`, {
          cache: "no-store",
          credentials: "include",
        });
        const body = await read_api_response<StatusEnvelope>(response);
        if (!body.data) { throw new Error("PDB status refresh failed"); }
        if (cancelled) { return; }
        set_status(body.data);
        set_error("");
        if (body.data.checking) {
          timer = window.setTimeout(poll, 1200);
        } else {
          set_polling(false);
        }
      } catch (poll_error) {
        if (cancelled) { return; }
        set_error(poll_error instanceof Error ? poll_error.message : "PDB status refresh failed");
        set_polling(false);
      }
    };

    timer = window.setTimeout(poll, 900);
    return () => {
      cancelled = true;
      if (timer !== undefined) { window.clearTimeout(timer); }
    };
  }, [module_id, polling]);

  async function retry_pdb() {
    set_retrying(true);
    set_error("");
    set_needs_login(false);
    try {
      const response = await fetch(`${api_base}/api/v1/admin/modules/${encodeURIComponent(module_id)}/pdb/retry`, {
        method: "POST",
        credentials: "include",
      });
      if (response.status === 401) {
        set_needs_login(true);
        return;
      }
      const body = await read_api_response<{ data?: { pdb?: ModulePdbStatus } }>(response);
      set_status((current) => ({
        ...(body.data?.pdb ?? current),
        checking: true,
        message: `${current.provider} is being checked for this module's exact PDB.`,
      }));
      set_polling(true);
    } catch (retry_error) {
      set_error(retry_error instanceof Error ? retry_error.message : "PDB lookup could not be started");
    } finally {
      set_retrying(false);
    }
  }

  const is_error = status.status === "missing" || status.status === "download-failed";
  const is_warning = status.status === "unchecked" || status.status === "no-debug-info";
  const Icon = status.checking
    ? RefreshCw
    : status.available
      ? CircleCheckBig
      : status.status === "missing"
        ? SquareX
        : status.status === "download-failed"
          ? TriangleAlert
          : status.status === "no-debug-info"
            ? ShieldAlert
            : Database;
  const title = status.checking
    ? "Checking PDB availability"
    : status.available
      ? "PDB available"
      : status.status === "missing"
        ? "MISSING PDB"
        : status.status === "download-failed"
          ? "PDB download failed"
          : status.status === "no-debug-info"
            ? "No PDB reference"
            : "PDB has not been checked";
  const badge_tone = status.checking ? "blue" : status.available ? "green" : is_error ? "red" : is_warning ? "yellow" : "zinc";
  const banner_class = status.checking
    ? "border-cyan-400/50 bg-cyan-950/35"
    : status.available
      ? "border-emerald-400/45 bg-emerald-950/30"
      : is_error
        ? "border-red-400/55 bg-red-950/40 shadow-[0_0_0_1px_rgba(248,113,113,0.12)]"
        : "border-amber-400/50 bg-amber-950/35";
  const icon_class = status.checking
    ? "text-cyan-200"
    : status.available
      ? "text-emerald-200"
      : is_error
        ? "text-red-200"
        : "text-amber-200";
  const badge_label = status.checking ? "Checking" : status.status === "missing" ? "MISSING PDB" : status.status;
  const checked = checked_label(status.last_checked_at);
  const login_href = `/admin/login?next=${encodeURIComponent(`/modules/${module_id}`)}`;

  return (
    <section aria-live="polite" className={`relative overflow-hidden rounded-xl border p-4 ${banner_class}`} data-pdb-status={status.status} role={status.status === "missing" ? "alert" : undefined}>
      {(retrying || status.checking) && <div className="ka-operation-progress"><span /></div>}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex min-w-0 gap-3">
          <div className={`mt-0.5 flex h-10 w-10 shrink-0 items-center justify-center rounded-md border border-current/25 bg-black/20 ${icon_class}`}>
            <Icon className={`h-5 w-5 ${status.checking ? "animate-spin" : ""}`} />
          </div>
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="text-base font-semibold text-zinc-50">{title}</h2>
              <Badge tone={badge_tone}>{badge_label}</Badge>
            </div>
            <p className="mt-1 max-w-4xl text-sm leading-6 text-zinc-200">{status.message}</p>
            <div className="mt-2 flex min-w-0 flex-wrap gap-x-4 gap-y-1 text-xs text-zinc-400">
              <span>{status.provider}</span>
              {status.pdb_name && <span className="font-mono text-zinc-300">{status.pdb_name}</span>}
              {status.pdb_identifier && <span className="max-w-full truncate font-mono" title={status.pdb_identifier}>{status.pdb_identifier}</span>}
              {checked && <span>Last checked {checked}</span>}
            </div>
          </div>
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-2 sm:justify-end">
          {needs_login && (
            <Link className="inline-flex h-9 items-center justify-center rounded-md border border-cyan-400/60 bg-cyan-400/15 px-3 text-sm font-medium text-cyan-100 transition-colors hover:bg-cyan-400/25" href={login_href}>
              Admin sign in
            </Link>
          )}
          {status.can_retry && !needs_login && (
            <Button
              disabled={retrying || status.checking}
              icon={<RefreshCw className={`h-4 w-4 ${retrying || status.checking ? "animate-spin" : ""}`} />}
              onClick={() => void retry_pdb()}
              variant={is_error ? "danger" : "primary"}
            >
              {status.checking ? "Checking" : status.status === "unchecked" ? "Check PDB server" : "Retry PDB lookup"}
            </Button>
          )}
        </div>
      </div>
      {error && <div className="mt-3 rounded-md border border-red-400/35 bg-red-500/10 px-3 py-2 text-sm text-red-100">{error}</div>}
    </section>
  );
}
