import { parentPort } from "node:worker_threads";
import type { PatternResult } from "@kernelarchive/shared";
import { cross_reference_pattern, generate_best_pattern, generate_pattern } from "./patterns";
import type { PatternWorkerRequest, PatternWorkerResponse } from "./pattern-worker-protocol";

const port = parentPort;
if (!port) { throw new Error("Pattern worker requires a parent port"); }

function reusable_source_pattern(pattern: PatternResult | undefined, local_target_count: number) {
  if (!pattern) { return false; }
  if (local_target_count < 2) { return true; }
  const multi_build = pattern.tested_builds_json.length > 1 && !pattern.format.startsWith("ida-per-build");
  const checked_fallback = pattern.format === "ida-per-build-checked-v2" && pattern.tested_builds_json.length >= local_target_count;
  return multi_build || checked_fallback;
}

function error_message(error: unknown) {
  return error instanceof Error ? error.message : "Pattern analysis failed";
}

port.on("message", (request: PatternWorkerRequest) => {
  try {
    if (request.operation === "generate") {
      const response: PatternWorkerResponse = {
        id: request.id,
        operation: request.operation,
        ok: true,
        pattern: request.targets?.length
          ? generate_best_pattern(request.module, request.fn, request.binary_sha256, request.targets)
          : generate_pattern(request.module, request.fn, request.binary_sha256),
      };
      port.postMessage(response);
      return;
    }

    const local_target_count = request.targets.filter((target) => target.module?.source_path && target.fn).length;
    const generated_patterns: PatternResult[] = [];
    let source_pattern = request.source_pattern;
    if (request.module?.source_path && !reusable_source_pattern(source_pattern, local_target_count)) {
      source_pattern = generate_best_pattern(request.module, request.fn, request.module.sha256, request.targets);
      generated_patterns.push(source_pattern);
    }

    const targets = request.targets.map((target) =>
      target.fn?.id === request.fn.id && source_pattern ? { ...target, stored_pattern: source_pattern } : target);
    const result = cross_reference_pattern(request.fn, targets, (module, fn) => {
      const pattern = generate_pattern(module, fn, module.sha256);
      generated_patterns.push(pattern);
      return pattern;
    }, source_pattern);
    const patterns = Array.from(new Map(generated_patterns.map((pattern) => [pattern.id, pattern])).values());
    const response: PatternWorkerResponse = {
      id: request.id,
      operation: request.operation,
      ok: true,
      result,
      patterns,
    };
    port.postMessage(response);
  } catch (error) {
    const response: PatternWorkerResponse = {
      id: request.id,
      operation: request.operation,
      ok: false,
      error: error_message(error),
    };
    port.postMessage(response);
  }
});
