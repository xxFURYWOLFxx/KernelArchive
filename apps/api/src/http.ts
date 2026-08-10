import type { FastifyReply, FastifyRequest } from "fastify";

export function request_id(request: FastifyRequest) {
  return request.id;
}

export function ok<T>(request: FastifyRequest, data: T, source?: string) {
  return {
    data,
    meta: {
      request_id: request_id(request),
      api_version: "v1" as const,
      ...(source ? { source } : {}),
    },
  };
}

export function list<T>(request: FastifyRequest, data: T[], page = 1, limit = 50) {
  return {
    data: data.slice((page - 1) * limit, page * limit),
    pagination: {
      page,
      limit,
      total: data.length,
    },
    meta: {
      request_id: request_id(request),
      api_version: "v1" as const,
    },
  };
}

export function fail(reply: FastifyReply, request: FastifyRequest, status_code: number, code: string, message: string) {
  reply.code(status_code);
  return {
    error: {
      code,
      message,
      request_id: request_id(request),
    },
  };
}

