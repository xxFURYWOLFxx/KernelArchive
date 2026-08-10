import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { authenticate_admin, change_admin_password, record_audit_event, revoke_admin_session } from "./auth-store";
import { admin_session_token, authenticated_admin, clear_session_cookie_header, require_admin, session_cookie_header } from "./auth";
import { fail, ok } from "./http";

const credentials_schema = z.object({
  username: z.string().trim().min(3).max(64),
  password: z.string().min(1).max(256),
});

export async function register_auth_routes(server: FastifyInstance) {
  server.post("/api/v1/auth/login", {
    config: { rateLimit: { max: 5, timeWindow: "1 minute" } },
    schema: { tags: ["auth"] },
  }, async (request, reply) => {
    const body = credentials_schema.parse(request.body);
    const result = await authenticate_admin(body.username, body.password, request.ip, request.headers["user-agent"]);
    reply.header("cache-control", "no-store");
    if (result.status !== "ok") {
      record_audit_event({
        action: "auth.login",
        target_type: "admin",
        success: false,
        ip_address: request.ip,
        user_agent: request.headers["user-agent"],
        details: { username: body.username, result: result.status },
      });
      if (result.status === "locked") { reply.header("retry-after", String(Math.max(1, Math.ceil(result.retry_after_ms / 1000)))); }
      return fail(reply, request, result.status === "locked" ? 429 : 401, "INVALID_CREDENTIALS", "Invalid credentials or account temporarily locked");
    }
    record_audit_event({
      user_id: result.session.user.id,
      action: "auth.login",
      target_type: "admin",
      target_id: result.session.user.id,
      success: true,
      ip_address: request.ip,
      user_agent: request.headers["user-agent"],
    });
    reply.header("set-cookie", session_cookie_header(request, result.session.token, result.session.expires_at));
    return ok(request, { user: result.session.user, expires_at: new Date(result.session.expires_at).toISOString() }, "auth-database");
  });

  server.get("/api/v1/auth/session", { preHandler: require_admin, schema: { tags: ["auth"] } }, async (request) => {
    const user = authenticated_admin(request);
    return ok(request, { user }, "auth-database");
  });

  server.post("/api/v1/auth/logout", { preHandler: require_admin, schema: { tags: ["auth"] } }, async (request, reply) => {
    const user = authenticated_admin(request);
    revoke_admin_session(admin_session_token(request));
    record_audit_event({ user_id: user?.id === "api-key" ? null : user?.id, action: "auth.logout", target_type: "admin", target_id: user?.id, success: true, ip_address: request.ip, user_agent: request.headers["user-agent"] });
    reply.header("set-cookie", clear_session_cookie_header(request));
    reply.header("cache-control", "no-store");
    return ok(request, { logged_out: true }, "auth-database");
  });

  server.post("/api/v1/auth/change-password", {
    preHandler: require_admin,
    config: { rateLimit: { max: 5, timeWindow: "1 minute" } },
    schema: { tags: ["auth"] },
  }, async (request, reply) => {
    const body = z.object({ current_password: z.string().min(1).max(256), new_password: z.string().min(1).max(256) }).parse(request.body);
    const user = authenticated_admin(request);
    if (!user || user.id === "api-key") { return fail(reply, request, 400, "PASSWORD_CHANGE_UNAVAILABLE", "Password change requires an administrator session"); }
    const result = await change_admin_password(user.username, body.current_password, body.new_password, request.ip, request.headers["user-agent"]);
    if (result.status === "policy") { return fail(reply, request, 400, "PASSWORD_POLICY", result.message); }
    if (result.status !== "ok") {
      record_audit_event({ user_id: user.id, action: "auth.password_changed", target_type: "admin", target_id: user.id, success: false, ip_address: request.ip, user_agent: request.headers["user-agent"] });
      return fail(reply, request, 401, "INVALID_CREDENTIALS", "Current password is incorrect");
    }
    record_audit_event({ user_id: user.id, action: "auth.password_changed", target_type: "admin", target_id: user.id, success: true, ip_address: request.ip, user_agent: request.headers["user-agent"] });
    reply.header("set-cookie", session_cookie_header(request, result.session.token, result.session.expires_at));
    reply.header("cache-control", "no-store");
    return ok(request, { changed: true, user: result.session.user }, "auth-database");
  });
}
