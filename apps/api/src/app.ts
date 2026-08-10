import cors, { type FastifyCorsOptions } from "@fastify/cors";
import helmet from "@fastify/helmet";
import rate_limit from "@fastify/rate-limit";
import swagger from "@fastify/swagger";
import swagger_ui from "@fastify/swagger-ui";
import Fastify, { type FastifyRequest } from "fastify";
import { ZodError } from "zod";
import { has_valid_api_key, is_trusted_origin } from "./auth";
import { register_auth_routes } from "./auth-routes";
import { close_auth_store } from "./auth-store";
import { start_archive_importer, stop_archive_importer } from "./archive-importer";
import { env } from "./env";
import { archive_database_paths, close_local_cache, warm_local_cache } from "./ingestion-cache";
import { start_archive_read_pool, stop_archive_read_pool } from "./archive-read-pool";
import { close_pattern_worker } from "./pattern-service";
import { register_routes } from "./routes";

export async function create_app() {
  const trust_proxy = env.TRUST_PROXY.split(",").map((value) => value.trim()).filter(Boolean);
  const secure_application = new URL(env.PUBLIC_APP_URL).protocol === "https:";
  const server = Fastify({
    logger: true,
    genReqId: () => crypto.randomUUID(),
    bodyLimit: env.JSON_BODY_MAX_BYTES,
    trustProxy: trust_proxy.length > 0 ? trust_proxy : false,
  });

  server.addContentTypeParser("application/octet-stream", { parseAs: "buffer", bodyLimit: env.UPLOAD_MAX_BYTES }, (_request, body, done) => {
    done(null, body);
  });

  await server.register(helmet, secure_application ? {} : {
    strictTransportSecurity: false,
    contentSecurityPolicy: {
      directives: {
        upgradeInsecureRequests: null,
      },
    },
  });
  // Registered through the delegate form so the origin check can see the request,
  // which is what makes the same-origin-by-Host rule possible.
  await server.register(cors, () => (request: FastifyRequest, callback: (error: Error | null, options: FastifyCorsOptions) => void) => {
    const origin = request.headers.origin;
    if (!origin || is_trusted_origin(origin, request)) {
      callback(null, { origin: true, credentials: true });
      return;
    }
    callback(new Error("Origin not allowed"), { origin: false, credentials: true });
  });
  await server.register(rate_limit, {
    max: (request) => has_valid_api_key(request) ? env.RATE_LIMIT_AUTH_PER_MINUTE : env.RATE_LIMIT_PUBLIC_PER_MINUTE,
    timeWindow: "1 minute",
    hook: "preHandler",
  });
  server.addHook("onSend", async (request, reply, payload) => {
    if (reply.hasHeader("cache-control")) { return payload; }
    const private_route = request.url.startsWith("/api/v1/auth/") || request.url.startsWith("/api/v1/admin/") || request.url.startsWith("/api/v1/me/") || request.url.startsWith("/api/v1/jobs/");
    const pattern_route = request.url.includes("/pattern") || request.url.startsWith("/api/v1/patterns/");
    if (request.method === "GET" && !private_route && !pattern_route && reply.statusCode < 400) {
      reply.header("cache-control", "public, max-age=5, stale-while-revalidate=30");
    } else {
      reply.header("cache-control", "no-store");
    }
    return payload;
  });
  await server.register(swagger, {
    openapi: {
      info: {
        title: "KernelArchive API",
        description: "Windows kernel symbol and structure archive API",
        version: "0.1.0",
      },
      servers: [{ url: "/api/v1" }],
    },
  });
  await server.register(swagger_ui, {
    routePrefix: "/api/docs",
  });

  server.setErrorHandler((error, request, reply) => {
    const request_error = error instanceof Error
      ? error as Error & { code?: string; statusCode?: number }
      : new Error("Request failed") as Error & { code?: string; statusCode?: number };

    if (request_error.message === "Origin not allowed") {
      reply.code(403).send({
        error: {
          code: "ORIGIN_REJECTED",
          message: "Request origin was not accepted",
          request_id: request.id,
        },
      });
      return;
    }

    if (error instanceof ZodError) {
      reply.code(400).send({
        error: {
          code: "BAD_REQUEST",
          message: error.issues.map((issue) => issue.message).join("; "),
          request_id: request.id,
        },
      });
      return;
    }

    const status_code = typeof request_error.statusCode === "number" ? request_error.statusCode : 500;
    if (status_code >= 500) {
      request.log.error(error);
      reply.code(500).send({
        error: {
          code: "INTERNAL_ERROR",
          message: "Internal server error",
          request_id: request.id,
        },
      });
      return;
    }
    reply.code(status_code).send({
      error: {
        code: request_error.code || "REQUEST_FAILED",
        message: request_error.message,
        request_id: request.id,
      },
    });
  });

  await register_auth_routes(server);
  await register_routes(server);
  // Warming counts every collection, so doing it before listen leaves the API
  // unreachable for the whole warm. Defer both to the next tick after listen.
  setImmediate(() => {
    try {
      server.log.info({ cache: warm_local_cache() }, "archive cache ready");
      const database = archive_database_paths();
      server.log.info({ replicas: start_archive_read_pool(database.path, database.legacy_path) }, "archive read pool ready");
      server.log.info({ archive: start_archive_importer() }, "archive importer ready");
    } catch (error) {
      server.log.error(error, "archive warm-up failed");
    }
  });
  server.addHook("onClose", async () => {
    await stop_archive_importer();
    stop_archive_read_pool();
    await close_pattern_worker();
    close_local_cache();
    close_auth_store();
  });

  return server;
}
