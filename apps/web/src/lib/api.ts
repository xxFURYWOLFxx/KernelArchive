import type { ArchiveFileRecord, ArchiveScanStatus, BinaryIngestionRecord, KernelFunction, KernelModule, KernelType, KernelTypeSummary, ModulePdbStatus, PatternResult, SearchResult, WindowsBuild } from "@kernelarchive/shared";

export const api_base = typeof window === "undefined"
  ? process.env.KERNELARCHIVE_API_INTERNAL_URL ?? process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://127.0.0.1:4002"
  : "";

export interface Pagination {
  page: number;
  limit: number;
  total: number;
}

export interface ApiEnvelope<T> {
  data: T;
  pagination?: Pagination;
  meta?: {
    request_id: string;
    api_version: "v1";
    source?: string;
  };
}

interface ApiErrorPayload {
  error?: { message?: unknown };
}

function response_error_message(body: unknown) {
  if (!body || typeof body !== "object") { return ""; }
  const message = (body as ApiErrorPayload).error?.message;
  return typeof message === "string" ? message.trim() : "";
}

export async function read_api_response<T>(response: Response): Promise<T> {
  const text = await response.text();
  let body: unknown;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = undefined;
    }
  }
  if (!response.ok) {
    const message = response_error_message(body);
    if (message && message.toLowerCase() !== "internal server error") { throw new Error(message); }
    if (response.status >= 500) { throw new Error(`KernelArchive could not complete this request (HTTP ${response.status}). Please retry.`); }
    if (text.trim() && !text.trimStart().startsWith("<")) { throw new Error(text.trim().slice(0, 240)); }
    throw new Error(`Request failed (HTTP ${response.status}).`);
  }
  if (body === undefined) { throw new Error("KernelArchive returned an invalid response. Please retry."); }
  return body as T;
}

export interface CacheStats {
  builds: number;
  modules: number;
  functions: number;
  types: number;
  patterns: number;
  ingestions: number;
}

export interface ArchiveDatabaseStats {
  path: string;
  revision: number;
}

export interface CatalogData {
  builds: WindowsBuild[];
  stats: CacheStats;
}

export interface BuildCatalogEntry extends WindowsBuild {
  module_count: number;
  symbol_count: number;
  function_count: number;
  type_count: number;
}

export interface AdminCacheData {
  ingestions: BinaryIngestionRecord[];
  archive: {
    status: ArchiveScanStatus;
    files: ArchiveFileRecord[];
    stats: {
      total: number;
      indexed: number;
      cached: number;
      skipped: number;
      failed: number;
      pending: number;
      missing: number;
    };
  };
  stats: CacheStats;
  database: ArchiveDatabaseStats;
  pagination: Pagination;
}

export interface FunctionWithPattern extends KernelFunction {
  pattern?: PatternResult | null;
}

export interface TypeDetailContext {
  type: KernelType;
  module: KernelModule | null;
  build: WindowsBuild | null;
}

export interface FunctionDetailContext {
  fn: FunctionWithPattern;
  module: KernelModule | null;
  build: WindowsBuild | null;
}

export interface ModuleDetailContext {
  module: KernelModule;
  build: WindowsBuild | null;
  pdb: ModulePdbStatus;
}

type NextRequestInit = RequestInit & { next?: { revalidate?: number } };

interface BrowserCacheEntry {
  expires_at: number;
  value: ApiEnvelope<unknown>;
}

const browser_cache = new Map<string, BrowserCacheEntry>();
const browser_inflight = new Map<string, Promise<ApiEnvelope<unknown>>>();
const browser_cache_limit = 300;
const public_index_ttl_ms = 60 * 60 * 1000;
const api_list_all_max_pages = 10;

function public_browser_ttl(path: string, method: string) {
  if (typeof window === "undefined" || method !== "GET") { return 0; }
  if (/\/api\/v1\/(admin|auth|me|jobs)(\/|\?|$)/.test(path)) { return 0; }
  if (path.includes("/pattern")) { return 0; }
  if (path.includes("/scan-status")) { return 0; }
  if (/\/api\/v1\/modules\/[^/]+\/(?:types|functions)\?/.test(path) && /[?&]q=/.test(path)) { return 0; }
  if (path.startsWith("/api/v1/search")) { return 15_000; }
  if (path.startsWith("/api/v1/diff/")) { return 30_000; }
  if (path === "/api/v1/catalog" || path === "/api/v1/stats") { return public_index_ttl_ms; }
  if (/^\/api\/v1\/builds(\/catalog)?(\?|$)/.test(path) || /^\/api\/v1\/builds\/[^/?]+(\?|$)/.test(path)) { return public_index_ttl_ms; }
  return 60_000;
}

function remember_browser_response(key: string, value: ApiEnvelope<unknown>, ttl: number) {
  if (browser_cache.has(key)) { browser_cache.delete(key); }
  browser_cache.set(key, { value, expires_at: Date.now() + ttl });
  while (browser_cache.size > browser_cache_limit) {
    const oldest = browser_cache.keys().next().value;
    if (!oldest) { break; }
    browser_cache.delete(oldest);
  }
}

export function invalidate_api_cache() {
  browser_cache.clear();
  browser_inflight.clear();
}

export async function api_json<T>(path: string, init?: NextRequestInit): Promise<ApiEnvelope<T>> {
  const method = (init?.method ?? "GET").toUpperCase();
  const server_get = typeof window === "undefined" && method === "GET";
  const ttl = public_browser_ttl(path, method);
  const key = `${api_base}${path}`;
  if (ttl > 0) {
    const cached = browser_cache.get(key);
    if (cached && cached.expires_at > Date.now()) {
      browser_cache.delete(key);
      browser_cache.set(key, cached);
      return cached.value as ApiEnvelope<T>;
    }
    if (cached) { browser_cache.delete(key); }
    const pending = browser_inflight.get(key);
    if (pending) { return pending as Promise<ApiEnvelope<T>>; }
  }

  const request = (async () => {
    const response = await fetch(key, {
      cache: server_get ? "force-cache" : method === "GET" ? "default" : "no-store",
      ...(server_get ? { next: { revalidate: 30 } } : {}),
      credentials: "include",
      ...init,
      headers: {
        ...(init?.headers ?? {}),
      },
    });
    const body = await read_api_response<ApiEnvelope<T>>(response);
    if (ttl > 0) { remember_browser_response(key, body, ttl); }
    return body as ApiEnvelope<T>;
  })();

  if (ttl > 0) { browser_inflight.set(key, request as Promise<ApiEnvelope<unknown>>); }
  try {
    return await request;
  } finally {
    if (browser_inflight.get(key) === request) { browser_inflight.delete(key); }
  }
}

export async function api_data<T>(path: string, fallback: T, init?: NextRequestInit): Promise<T> {
  try {
    return (await api_json<T>(path, init)).data;
  } catch {
    return fallback;
  }
}

export async function api_list<T>(path: string, fallback: T[] = []): Promise<T[]> {
  return api_data<T[]>(path, fallback);
}

export async function api_list_all<T>(path: string, fallback: T[] = []): Promise<T[]> {
  try {
    const separator = path.includes("?") ? "&" : "?";
    const first = await api_json<T[]>(`${path}${separator}page=1&limit=100`);
    const items = [...first.data];
    const total = first.pagination?.total ?? items.length;
    const limit = first.pagination?.limit ?? 100;
    const pages = Math.min(Math.ceil(total / limit), api_list_all_max_pages);
    for (let page = 2; page <= pages; page += 1) {
      const next = await api_json<T[]>(`${path}${separator}page=${page}&limit=${limit}`);
      items.push(...next.data);
    }

    return items;
  } catch {
    return fallback;
  }
}

export type { KernelFunction, KernelModule, KernelType, KernelTypeSummary, SearchResult, WindowsBuild };
