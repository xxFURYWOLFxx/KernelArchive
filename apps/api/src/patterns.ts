import { existsSync, readFileSync, statSync } from "node:fs";
import { basename, isAbsolute, join } from "node:path";
import { is_executable_section, parse_hex, section_for_rva } from "@kernelarchive/shared";
import type { KernelFunction, KernelModule, PatternCrossReferenceResult, PatternCrossReferenceRow, PatternCrossReferenceTarget, PatternResult, PatternStatus } from "@kernelarchive/shared";
import { volatile_operand_mask } from "./x86-mask";

interface FunctionBytes {
  module: KernelModule;
  fn: KernelFunction;
  data: Buffer;
  bytes: Buffer;
  build_id: string;
}

interface BinaryCacheEntry {
  data: Buffer;
  mtime_ms: number;
  size: number;
}

interface MaskedCandidate {
  bytes: Buffer;
  mask: string;
  length: number;
  start: number;
  specific_count: number;
  anchor_length: number;
}

const binary_cache = new Map<string, BinaryCacheEntry>();
const binary_cache_max_bytes = 512 * 1024 * 1024;
let binary_cache_bytes = 0;

function read_binary_cached(path: string) {
  const stat = statSync(path);
  const cached = binary_cache.get(path);
  if (cached && cached.mtime_ms === stat.mtimeMs && cached.size === stat.size) {
    binary_cache.delete(path);
    binary_cache.set(path, cached);
    return cached.data;
  }
  if (cached) { binary_cache_bytes -= cached.data.length; }
  const data = readFileSync(path);
  binary_cache.set(path, { data, mtime_ms: stat.mtimeMs, size: stat.size });
  binary_cache_bytes += data.length;
  while (binary_cache_bytes > binary_cache_max_bytes && binary_cache.size > 1) {
    const oldest_path = binary_cache.keys().next().value;
    if (!oldest_path) { break; }
    const oldest = binary_cache.get(oldest_path);
    binary_cache.delete(oldest_path);
    binary_cache_bytes -= oldest?.data.length ?? 0;
  }
  return data;
}

function format_hex(byte: number) {
  return byte.toString(16).padStart(2, "0").toUpperCase();
}

function pattern_text(bytes: Buffer, mask: string) {
  return Array.from(bytes).map((byte, index) => mask[index] === "x" ? format_hex(byte) : "??").join(" ");
}

function count_matches(data: Buffer, candidate: Buffer) {
  if (candidate.length === 0 || data.length < candidate.length) { return 0; }
  let count = 0;
  let offset = 0;
  while (offset <= data.length - candidate.length) {
    const match = data.indexOf(candidate, offset);
    if (match < 0) { break; }
    count += 1;
    offset = match + 1;
  }
  return count;
}

function longest_fixed_run(mask: string) {
  let best_start = 0;
  let best_length = 0;
  let current_start = 0;
  let current_length = 0;
  for (let index = 0; index <= mask.length; index += 1) {
    if (mask[index] === "x") {
      if (current_length === 0) { current_start = index; }
      current_length += 1;
    } else {
      if (current_length > best_length) {
        best_start = current_start;
        best_length = current_length;
      }
      current_length = 0;
    }
  }
  return { start: best_start, length: best_length };
}

function count_masked_matches(data: Buffer, candidate: Buffer, mask: string) {
  if (candidate.length === 0 || data.length < candidate.length) { return 0; }
  const fixed = longest_fixed_run(mask);
  if (fixed.length === 0) { return data.length - candidate.length + 1; }
  const anchor = candidate.subarray(fixed.start, fixed.start + fixed.length);
  let count = 0;
  let search_offset = 0;
  while (search_offset <= data.length - anchor.length) {
    const anchor_offset = data.indexOf(anchor, search_offset);
    if (anchor_offset < 0) { break; }
    search_offset = anchor_offset + 1;
    const index = anchor_offset - fixed.start;
    if (index < 0 || index > data.length - candidate.length) { continue; }
    let matched = true;
    for (let byte_index = 0; byte_index < candidate.length; byte_index += 1) {
      if (mask[byte_index] === "x" && data[index + byte_index] !== candidate[byte_index]) {
        matched = false;
        break;
      }
    }
    if (matched) { count += 1; }
  }
  return count;
}

function score_status(length: number, collision_count: number): { confidence: number; status: PatternStatus } {
  if (collision_count === 0 && length >= 32) { return { confidence: 0.94, status: "excellent" }; }
  if (collision_count === 0 && length >= 16) { return { confidence: 0.86, status: "good" }; }
  if (collision_count <= 2 && length >= 16) { return { confidence: 0.62, status: "risky" }; }
  return { confidence: 0.2, status: "rejected" };
}

function score_masked_status(length: number, collision_count: number, specific_count: number, build_count: number): { confidence: number; status: PatternStatus } {
  const specific_ratio = specific_count / Math.max(1, length);
  if (collision_count === 0 && build_count > 1 && length >= 32 && specific_ratio >= 0.45) {
    return { confidence: 0.97, status: "excellent" };
  }
  if (collision_count === 0 && build_count > 1 && length >= 16 && specific_ratio >= 0.35) {
    return { confidence: 0.9, status: "good" };
  }
  if (collision_count <= 2 && specific_count >= 8) {
    return { confidence: 0.64, status: "risky" };
  }
  return { confidence: 0.2, status: "rejected" };
}

// source_path is an absolute path recorded on whichever machine did the indexing,
// so it is meaningless once the archive is copied to a server. The binary cache is
// laid out as binaries/<sha256>/<name>, which can be rebuilt from the module itself,
// so fall back to that before giving up.
function resolve_module_binary(module: KernelModule) {
  if (module.source_path && existsSync(module.source_path)) { return module.source_path; }
  if (!module.sha256) { return undefined; }
  const cache_dir = process.env.KERNELARCHIVE_LOCAL_CACHE_DIR ?? "local-cache";
  const root = isAbsolute(cache_dir) ? cache_dir : join(process.cwd(), cache_dir);
  const safe_name = basename(module.name).replace(/[^a-zA-Z0-9._-]+/g, "_") || "upload.bin";
  const rebuilt = join(root, "binaries", module.sha256, safe_name);
  return existsSync(rebuilt) ? rebuilt : undefined;
}

function function_bytes(module: KernelModule, fn: KernelFunction): FunctionBytes {
  const source_path = resolve_module_binary(module);
  if (!source_path) {
    throw new Error("Module does not have a local source path");
  }

  const data = read_binary_cached(source_path);
  const rva = parse_hex(fn.rva);
  const section = section_for_rva(module, rva);
  if (!section) {
    throw new Error("Function RVA does not map to a section");
  }
  if (!is_executable_section(section)) {
    throw new Error("Function RVA is not inside an executable section");
  }

  const section_rva = parse_hex(section.virtual_address);
  const section_raw = parse_hex(section.raw_offset);
  const file_offset = section_raw + (rva - section_rva);
  const available = Math.min(fn.size > 0 ? fn.size : 96, data.length - file_offset);
  if (file_offset < 0 || available < 8) {
    throw new Error("Function has too few bytes for a pattern");
  }

  return {
    module,
    fn,
    data,
    bytes: data.subarray(file_offset, file_offset + available),
    build_id: module.build_id,
  };
}

export function generate_pattern(module: KernelModule, fn: KernelFunction, binary_sha256: string): PatternResult {
  const sample = function_bytes(module, fn);
  const preferred_lengths = [64, 56, 48, 40, 32, 24, 16, 12, 8].filter((length) => length <= sample.bytes.length);
  const initial_length = preferred_lengths[0];
  if (!initial_length) {
    throw new Error("Function has too few bytes for a pattern");
  }

  let selected = sample.bytes.subarray(0, initial_length);
  let selected_collisions = Number.MAX_SAFE_INTEGER;

  for (const length of preferred_lengths) {
    const candidate = sample.bytes.subarray(0, length);
    const matches = count_matches(sample.data, candidate);
    const collisions = Math.max(0, matches - 1);
    selected = candidate;
    selected_collisions = collisions;
    if (collisions === 0) { break; }
  }

  let mask = "x".repeat(selected.length);
  const relaxed = volatile_operand_mask(selected);
  if (relaxed.includes("?") && longest_fixed_run(relaxed).length >= 8) {
    const relaxed_matches = count_masked_matches(sample.data, selected, relaxed);
    if (relaxed_matches === 1) {
      mask = relaxed;
      selected_collisions = 0;
    }
  }

  const quality = score_status(selected.length, selected_collisions);
  return {
    id: `pattern_${fn.id}`,
    function_id: fn.id,
    module_id: module.id,
    binary_sha256,
    pattern: pattern_text(selected, mask),
    mask,
    format: "ida",
    length: selected.length,
    confidence: quality.confidence,
    collision_count: selected_collisions,
    tested_builds_json: [module.build_id],
    status: quality.status,
    created_at: new Date().toISOString(),
  };
}

function unique_samples(samples: FunctionBytes[]) {
  const seen = new Set<string>();
  return samples.filter((sample) => {
    if (seen.has(sample.module.id)) { return false; }
    seen.add(sample.module.id);
    return true;
  });
}

function collect_local_samples(module: KernelModule, fn: KernelFunction, targets: PatternCrossReferenceTarget[]) {
  const samples: FunctionBytes[] = [function_bytes(module, fn)];
  for (const target of targets) {
    if (!target.module?.source_path || !target.fn || target.module.id === module.id) { continue; }
    try {
      samples.push(function_bytes(target.module, target.fn));
    } catch {
      continue;
    }
  }
  return unique_samples(samples);
}

export function generate_best_pattern(module: KernelModule, fn: KernelFunction, binary_sha256: string, targets: PatternCrossReferenceTarget[]): PatternResult {
  const samples = collect_local_samples(module, fn, targets);
  if (samples.length < 2) {
    return generate_pattern(module, fn, binary_sha256);
  }
  const source_sample = samples[0];
  if (!source_sample) {
    return generate_pattern(module, fn, binary_sha256);
  }

  const minimum_length = Math.min(...samples.map((sample) => sample.bytes.length));
  const preferred_lengths = [64, 56, 48, 40, 32, 24, 16, 12, 8].filter((length) => length <= minimum_length);
  const candidates: MaskedCandidate[] = [];

  for (const length of preferred_lengths) {
    const max_start = Math.min(96, minimum_length - length);
    for (let start = 0; start <= max_start; start += 1) {
      const bytes = Buffer.from(source_sample.bytes.subarray(start, start + length));
      let specific_count = 0;
      const mask = Array.from(bytes, (_byte, index) => {
        const fixed = samples.every((sample) => sample.bytes[start + index] === bytes[index]);
        if (fixed) { specific_count += 1; }
        return fixed ? "x" : "?";
      }).join("");
      if (specific_count < 8 || specific_count / length < 0.35) { continue; }
      candidates.push({
        bytes,
        mask,
        length,
        start,
        specific_count,
        anchor_length: longest_fixed_run(mask).length,
      });

    }
  }

  candidates.sort((left, right) =>
    right.anchor_length - left.anchor_length ||
    right.specific_count - left.specific_count ||
    right.length - left.length ||
    left.start - right.start);

  for (const candidate of candidates) {
    let collision_count = 0;
    let matches_all = true;
    for (const sample of samples) {
      const match_count = count_masked_matches(sample.data, candidate.bytes, candidate.mask);
      collision_count += Math.max(0, match_count - 1);
      if (match_count !== 1) {
        matches_all = false;
        break;
      }
    }
    if (matches_all) {
      const quality = score_masked_status(candidate.length, collision_count, candidate.specific_count, samples.length);
      return {
        id: `pattern_${fn.id}`,
        function_id: fn.id,
        module_id: module.id,
        binary_sha256,
        pattern: pattern_text(candidate.bytes, candidate.mask),
        mask: candidate.mask,
        format: candidate.start === 0 ? "ida" : `ida+0x${candidate.start.toString(16)}`,
        length: candidate.length,
        confidence: quality.confidence,
        collision_count,
        tested_builds_json: samples.map((sample) => sample.build_id),
        status: quality.status,
        created_at: new Date().toISOString(),
      };
    }
  }

  const fallback = generate_pattern(module, fn, binary_sha256);
  return {
    ...fallback,
    format: "ida-per-build-checked-v2",
    tested_builds_json: samples.map((sample) => sample.build_id),
  };
}

function row_from_pattern(base: Omit<PatternCrossReferenceRow, "status" | "note">, pattern: PatternResult, note: string, status: PatternCrossReferenceRow["status"] = "tested", pattern_scope: PatternCrossReferenceRow["pattern_scope"] = "per-build"): PatternCrossReferenceRow {
  return {
    ...base,
    pattern_id: pattern.id,
    pattern_status: pattern.status,
    confidence: pattern.confidence,
    collision_count: pattern.collision_count,
    length: pattern.length,
    pattern: pattern.pattern,
    mask: pattern.mask,
    pattern_scope,
    status,
    note,
  };
}

export function cross_reference_pattern(
  fn: KernelFunction,
  targets: PatternCrossReferenceTarget[],
  resolve_pattern: (module: KernelModule, fn: KernelFunction) => PatternResult = (module, target_fn) => generate_pattern(module, target_fn, module.sha256),
  source_pattern?: PatternResult,
): PatternCrossReferenceResult {
  const source_module = targets.find((target) => target.module?.id === fn.module_id)?.module;
  const module_name = source_module?.name ?? fn.module_id;
  const stable_builds = new Set(source_pattern && source_pattern.tested_builds_json.length > 1 && !source_pattern.format.startsWith("ida-per-build") ? source_pattern.tested_builds_json : []);

  const rows: PatternCrossReferenceRow[] = targets.map((target) => {
    const base = {
      build_id: target.build.id,
      build_label: target.build_label,
      architecture: target.build.architecture,
      module_name: target.module_name,
      function_name: fn.name,
    };

    if (!target.module) {
      return {
        ...base,
        status: "module-missing",
        note: `${target.module_name} is not indexed for this build.`,
      };
    }

    if (!target.fn) {
      return {
        ...base,
        module_id: target.module.id,
        binary_sha256: target.module.sha256,
        status: "function-missing",
        note: `${fn.name} is not indexed in ${target.module.name} for this build.`,
      };
    }

    const function_base = {
      ...base,
      module_id: target.module.id,
      function_id: target.fn.id,
      rva: target.fn.rva,
      binary_sha256: target.module.sha256,
    };

    if (source_pattern && stable_builds.has(target.build.id)) {
      return row_from_pattern(function_base, source_pattern, "Stable multi-build pattern validated uniquely on this build.", "tested", "multi-build");
    }

    if (target.stored_pattern) {
      return row_from_pattern(function_base, target.stored_pattern, "Loaded the cached pattern for this build.", "stored-pattern", "stored");
    }

    if (target.module.source_path) {
      try {
        const pattern = resolve_pattern(target.module, target.fn);
        const note = source_pattern && stable_builds.size > 0
          ? "Stable pattern did not cover this build; generated a per-build fallback."
          : "Generated a per-build fallback pattern for this build.";
        return row_from_pattern(function_base, pattern, note, "tested", "per-build");
      } catch (error) {
        return {
          ...function_base,
          status: "error",
          note: error instanceof Error ? error.message : "Pattern validation failed for this build.",
        };
      }
    }

    return {
      ...function_base,
      status: "symbol-only",
      note: "Function symbol is indexed, but no stored pattern or local binary is available for validation.",
    };
  });

  return {
    function_id: fn.id,
    function_name: fn.name,
    module_name,
    rows,
  };
}
