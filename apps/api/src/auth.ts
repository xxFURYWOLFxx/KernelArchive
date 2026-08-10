import { timingSafeEqual } from "node:crypto";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { AdminUser } from "./auth-store";
import { find_admin_session } from "./auth-store";
import { env } from "./env";
import { fail } from "./http";

export const admin_session_cookie = "kernelarchive_session";
const authenticated_admins = new WeakMap<FastifyRequest, AdminUser>();

function safe_equal(left: string, right: string) {
  const left_buffer = Buffer.from(left);
  const right_buffer = Buffer.from(right);
  return left_buffer.length === right_buffer.length && timingSafeEqual(left_buffer, right_buffer);
}

export function has_valid_api_key(request: FastifyRequest) {
  const configured = env.KERNELARCHIVE_API_KEY;
  const provided = request.headers["x-api-key"];
  return Boolean(configured && typeof provided === "string" && safe_equal(provided, configured));
}

export function is_trusted_origin(origin: string | undefined, request?: FastifyRequest) {
  if (!origin) { return false; }
  try {
    const requested_url = new URL(origin);
    // Same origin by construction. The browser reports Origin honestly and cannot be
    // made to lie about it, and Host is the name the request was actually addressed
    // to. When they match, the request came from the site itself, whichever domain
    // that happens to be, so the app never needs to be told its own public URL.
    // A page on another origin still fails: its Origin is its own, not this host.
    const host = request?.headers.host;
    if (host && requested_url.host.toLowerCase() === host.toLowerCase()) { return true; }
    const requested = requested_url.origin;
    const application = new URL(env.PUBLIC_APP_URL);
    const trusted = new Set([
      application.origin,
      ...env.TRUSTED_ORIGINS.split(",").map((value) => value.trim()).filter(Boolean).map((value) => new URL(value).origin),
    ]);
    if (application.hostname === "localhost") {
      trusted.add(`${application.protocol}//127.0.0.1${application.port ? `:${application.port}` : ""}`);
    } else if (application.hostname === "127.0.0.1") {
      trusted.add(`${application.protocol}//localhost${application.port ? `:${application.port}` : ""}`);
    }
    return trusted.has(requested);
  } catch {
    return false;
  }
}

function cookie_value(request: FastifyRequest, name: string) {
  const header = request.headers.cookie;
  if (!header) { return undefined; }
  for (const value of header.split(";")) {
    const separator = value.indexOf("=");
    if (separator < 0 || value.slice(0, separator).trim() !== name) { continue; }
    try {
      return decodeURIComponent(value.slice(separator + 1).trim());
    } catch {
      return undefined;
    }
  }
  return undefined;
}

export function admin_session_token(request: FastifyRequest) {
  return cookie_value(request, admin_session_cookie);
}

function mutation_request(request: FastifyRequest) {
  return request.method !== "GET" && request.method !== "HEAD" && request.method !== "OPTIONS";
}

export async function require_admin(request: FastifyRequest, reply: FastifyReply) {
  if (has_valid_api_key(request)) {
    authenticated_admins.set(request, { id: "api-key", username: "api-key", role: "ADMIN", must_change_password: false });
    return;
  }
  const session = find_admin_session(admin_session_token(request));
  if (!session) {
    return reply.send(fail(reply, request, 401, "UNAUTHORIZED", "Administrator login required"));
  }
  if (mutation_request(request) && !is_trusted_origin(request.headers.origin, request)) {
    return reply.send(fail(reply, request, 403, "ORIGIN_REJECTED", "Request origin was not accepted"));
  }
  const password_routes = new Set(["/api/v1/auth/session", "/api/v1/auth/change-password", "/api/v1/auth/logout"]);
  if (session.user.must_change_password && !password_routes.has(request.url.split("?")[0] ?? request.url)) {
    return reply.send(fail(reply, request, 403, "PASSWORD_CHANGE_REQUIRED", "Change the temporary administrator password before continuing"));
  }
  authenticated_admins.set(request, session.user);
}

export function authenticated_admin(request: FastifyRequest) {
  return authenticated_admins.get(request);
}

// The Next.js rewrite proxy forwards no x-forwarded-proto, so the API sees plain
// http even when the site is served over TLS and the cookie would ship without
// Secure. Treat an https PUBLIC_APP_URL as authoritative for the deployment.
function secure_request(request: FastifyRequest) {
  if (env.PUBLIC_APP_URL.startsWith("https://")) { return true; }
  return request.protocol === "https" || request.headers["x-forwarded-proto"] === "https";
}

export function session_cookie_header(request: FastifyRequest, token: string, expires_at: number) {
  const max_age = Math.max(0, Math.floor((expires_at - Date.now()) / 1000));
  return `${admin_session_cookie}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${max_age}${secure_request(request) ? "; Secure" : ""}`;
}

export function clear_session_cookie_header(request: FastifyRequest) {
  return `${admin_session_cookie}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${secure_request(request) ? "; Secure" : ""}`;
}
