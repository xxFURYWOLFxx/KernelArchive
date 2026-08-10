"use client";

import { useState, type FormEvent } from "react";
import { Eye, EyeOff, LoaderCircle, LogIn } from "lucide-react";
import { Button } from "@kernelarchive/ui";
import { api_base, read_api_response, type ApiEnvelope } from "@/lib/api";

export function LoginForm({ nextPath }: { nextPath: string }) {
  const [username, set_username] = useState("");
  const [password, set_password] = useState("");
  const [show_password, set_show_password] = useState(false);
  const [loading, set_loading] = useState(false);
  const [error, set_error] = useState("");

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    set_loading(true);
    set_error("");
    try {
      const response = await fetch(`${api_base}/api/v1/auth/login`, {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ username, password }),
      });
      await read_api_response<ApiEnvelope<unknown>>(response);
      window.location.replace(nextPath);
    } catch (request_error) {
      set_error(request_error instanceof Error ? request_error.message : "Login failed");
    } finally {
      set_loading(false);
    }
  }

  return (
    <form className="space-y-4" onSubmit={submit}>
      <label className="block">
        <span className="mb-1.5 block text-xs font-medium text-zinc-400">Username</span>
        <input
          autoComplete="username"
          autoFocus
          className="h-11 w-full rounded-md border border-white/10 bg-black/35 px-3 text-sm text-zinc-100 outline-none focus:border-cyan-300/70"
          onChange={(event) => set_username(event.target.value)}
          required
          value={username}
        />
      </label>
      <label className="block">
        <span className="mb-1.5 block text-xs font-medium text-zinc-400">Password</span>
        <span className="relative block">
          <input
            autoComplete="current-password"
            className="h-11 w-full rounded-md border border-white/10 bg-black/35 px-3 pr-11 text-sm text-zinc-100 outline-none focus:border-cyan-300/70"
            onChange={(event) => set_password(event.target.value)}
            required
            type={show_password ? "text" : "password"}
            value={password}
          />
          <button
            aria-label={show_password ? "Hide password" : "Show password"}
            className="absolute right-1 top-1 inline-flex h-9 w-9 items-center justify-center rounded text-zinc-500 hover:bg-white/5 hover:text-zinc-200"
            onClick={() => set_show_password((value) => !value)}
            title={show_password ? "Hide password" : "Show password"}
            type="button"
          >
            {show_password ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
          </button>
        </span>
      </label>
      {error && <div aria-live="polite" className="rounded-md border border-red-400/30 bg-red-500/10 p-3 text-sm text-red-100">{error}</div>}
      <Button className="w-full" disabled={loading || !username || !password} icon={loading ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <LogIn className="h-4 w-4" />} type="submit" variant="primary">
        {loading ? "Signing in" : "Sign in"}
      </Button>
    </form>
  );
}
