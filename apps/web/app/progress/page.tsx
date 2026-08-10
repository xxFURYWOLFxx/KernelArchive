"use client";

import { useEffect, useState } from "react";
import { Activity, AlertTriangle, CheckCircle2, Clock, Database, FileCheck, FileMinus, FileWarning, HardDrive, Loader2, RefreshCw } from "lucide-react";
import { api_json } from "@/lib/api";

interface ScanStatus {
  state: string;
  reason?: string;
  root: string;
  watching: boolean;
  queued: boolean;
  scan_id?: string;
  started_at?: string;
  completed_at?: string;
  discovered_files: number;
  portable_executables: number;
  processed_files: number;
  unchanged_files: number;
  indexed_files: number;
  cached_files: number;
  skipped_files: number;
  failed_files: number;
  current_file?: string;
  last_error?: string;
}

function elapsed(started_at: string) {
  const ms = Date.now() - Date.parse(started_at);
  if (ms < 0) return "0s";
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  if (hours > 0) return `${hours}h ${minutes % 60}m ${seconds % 60}s`;
  if (minutes > 0) return `${minutes}m ${seconds % 60}s`;
  return `${seconds}s`;
}

function eta(processed: number, total: number, started_at: string) {
  if (processed <= 0 || total <= 0) return "calculating...";
  const ms_elapsed = Date.now() - Date.parse(started_at);
  const ms_per_file = ms_elapsed / processed;
  const remaining = total - processed;
  const ms_remaining = remaining * ms_per_file;
  const minutes = Math.floor(ms_remaining / 60_000);
  const hours = Math.floor(minutes / 60);
  if (hours > 0) return `~${hours}h ${minutes % 60}m`;
  if (minutes > 0) return `~${minutes}m`;
  return "<1m";
}

function StatCard({ icon: Icon, label, value, sub, tone = "zinc" }: { icon: typeof Database; label: string; value: number | string; sub?: string; tone?: string }) {
  const colors: Record<string, string> = {
    cyan: "border-cyan-400/30 bg-cyan-400/8 text-cyan-200",
    green: "border-emerald-400/30 bg-emerald-400/8 text-emerald-200",
    yellow: "border-amber-400/30 bg-amber-400/8 text-amber-200",
    red: "border-red-400/30 bg-red-400/8 text-red-200",
    zinc: "border-white/10 bg-white/5 text-zinc-300",
  };
  return (
    <div className={`flex flex-col gap-1 rounded-lg border p-3 ${colors[tone] ?? colors.zinc}`}>
      <div className="flex items-center gap-2 text-xs opacity-70">
        <Icon className="h-3.5 w-3.5" />
        {label}
      </div>
      <div className="text-xl font-semibold tabular-nums">{typeof value === "number" ? value.toLocaleString() : value}</div>
      {sub && <div className="text-xs opacity-50">{sub}</div>}
    </div>
  );
}

export default function ProgressPage() {
  const [status, set_status] = useState<ScanStatus | null>(null);
  const [error, set_error] = useState("");
  const [tick, set_tick] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    void api_json<ScanStatus>("/api/v1/archive/scan-status", { signal: controller.signal })
      .then((r) => { if (!controller.signal.aborted) { set_status(r.data); set_error(""); } })
      .catch((e: unknown) => { if (!controller.signal.aborted) { set_error(e instanceof Error ? e.message : "Failed to fetch status"); } });
    return () => { controller.abort(); };
  }, [tick]);

  useEffect(() => {
    const interval = setInterval(() => {
      if (document.visibilityState !== "visible") { return; }
      set_tick((t) => t + 1);
    }, 2000);
    return () => clearInterval(interval);
  }, []);

  const scanning = status?.state === "scanning";
  const completed = status?.state === "completed";
  const failed = status?.state === "failed";

  const total_checked = status ? status.processed_files + status.unchanged_files : 0;
  const progress_pct = status && status.discovered_files > 0
    ? Math.min(100, (total_checked / status.discovered_files) * 100)
    : 0;

  const pe_progress_pct = status && status.portable_executables > 0
    ? Math.min(100, (status.processed_files / status.portable_executables) * 100)
    : 0;

  return (
    <div className="ka-shell">
      <div className="mx-auto max-w-3xl px-4 py-8">
        <div className="mb-6 flex items-center gap-3">
          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md border border-cyan-300/40 bg-cyan-300/12">
            <Database className="h-5 w-5 text-cyan-100" />
          </span>
          <div>
            <h1 className="text-lg font-semibold text-zinc-100">Archive Analysis Progress</h1>
            <p className="text-xs text-zinc-500">PDB symbol extraction and database indexing</p>
          </div>
        </div>

        {error && (
          <div className="mb-4 rounded-lg border border-red-400/30 bg-red-400/8 p-3 text-sm text-red-200">
            <AlertTriangle className="mb-1 inline h-4 w-4" /> {error}
          </div>
        )}

        {!status && !error && (
          <div className="flex items-center justify-center py-20 text-zinc-500">
            <Loader2 className="mr-2 h-5 w-5 animate-spin" /> Loading scan status...
          </div>
        )}

        {status && (
          <>
            <div className="mb-6 rounded-xl border border-white/10 bg-white/[0.03] p-5">
              <div className="mb-3 flex items-center justify-between">
                <div className="flex items-center gap-2">
                  {scanning && <Loader2 className="h-4 w-4 animate-spin text-cyan-300" />}
                  {completed && <CheckCircle2 className="h-4 w-4 text-emerald-400" />}
                  {failed && <AlertTriangle className="h-4 w-4 text-red-400" />}
                  <span className="text-sm font-medium text-zinc-200">
                    {scanning ? "Scanning archive..." : completed ? "Scan complete" : failed ? "Scan failed" : status.state}
                  </span>
                  {status.reason && <span className="rounded bg-white/10 px-1.5 py-0.5 text-xs text-zinc-400">{status.reason}</span>}
                </div>
                {status.started_at && (
                  <div className="flex items-center gap-1 text-xs text-zinc-500">
                    <Clock className="h-3 w-3" />
                    {elapsed(status.started_at)}
                  </div>
                )}
              </div>

              <div className="mb-2 flex items-baseline justify-between text-xs text-zinc-400">
                <span>Overall: {total_checked.toLocaleString()} / {status.discovered_files.toLocaleString()} files checked</span>
                <span className="tabular-nums font-medium text-zinc-200">{progress_pct.toFixed(1)}%</span>
              </div>
              <div className="mb-4 h-3 overflow-hidden rounded-full bg-white/10">
                <div
                  className="h-full rounded-full bg-gradient-to-r from-cyan-500 to-cyan-300 transition-all duration-700 ease-out"
                  style={{ width: `${progress_pct}%` }}
                />
              </div>

              {status.portable_executables > 0 && (
                <>
                  <div className="mb-2 flex items-baseline justify-between text-xs text-zinc-400">
                    <span>PE modules processed: {status.processed_files.toLocaleString()} / {status.portable_executables.toLocaleString()}</span>
                    <span className="tabular-nums font-medium text-zinc-200">{pe_progress_pct.toFixed(1)}%</span>
                  </div>
                  <div className="mb-4 h-2 overflow-hidden rounded-full bg-white/10">
                    <div
                      className="h-full rounded-full bg-gradient-to-r from-emerald-500 to-emerald-300 transition-all duration-700 ease-out"
                      style={{ width: `${pe_progress_pct}%` }}
                    />
                  </div>
                </>
              )}

              {scanning && status.started_at && status.processed_files > 3 && (
                <div className="flex items-center gap-1 text-xs text-zinc-500">
                  <RefreshCw className="h-3 w-3" />
                  ETA: {eta(total_checked, status.discovered_files, status.started_at)}
                </div>
              )}

              {status.current_file && scanning && (
                <div className="mt-3 truncate rounded border border-white/5 bg-black/30 px-3 py-2 font-mono text-xs text-zinc-400">
                  <Activity className="mr-1.5 inline h-3 w-3 text-cyan-400" />
                  {status.current_file}
                </div>
              )}
            </div>

            <div className="mb-6 grid grid-cols-2 gap-3 sm:grid-cols-4">
              <StatCard icon={FileCheck} label="Indexed" value={status.indexed_files} sub="New to database" tone="green" />
              <StatCard icon={HardDrive} label="Cached" value={status.cached_files} sub="From local cache" tone="cyan" />
              <StatCard icon={FileMinus} label="Unchanged" value={status.unchanged_files} sub="Already up to date" tone="zinc" />
              <StatCard icon={FileWarning} label="Failed" value={status.failed_files} sub="Processing errors" tone={status.failed_files > 0 ? "red" : "zinc"} />
            </div>

            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
              <StatCard icon={Database} label="Discovered" value={status.discovered_files} sub="Total files in archive" />
              <StatCard icon={HardDrive} label="PE Files" value={status.portable_executables} sub="Portable executables" />
              <StatCard icon={FileMinus} label="Skipped" value={status.skipped_files} sub="Non-PE or oversized" />
            </div>

            {status.last_error && (
              <div className="mt-4 rounded-lg border border-red-400/20 bg-red-400/5 p-3 text-xs text-red-300">
                <AlertTriangle className="mr-1 inline h-3.5 w-3.5" /> Last error: {status.last_error}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
