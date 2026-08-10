import type { KernelFunction, KernelModule, PatternCrossReferenceResult, PatternCrossReferenceTarget, PatternResult } from "@kernelarchive/shared";

export type PatternWorkerOperation = "generate" | "cross-reference";

export interface PatternWorkerGenerateRequest {
  id: number;
  operation: "generate";
  module: KernelModule;
  fn: KernelFunction;
  binary_sha256: string;
  targets?: PatternCrossReferenceTarget[];
}

export interface PatternWorkerCrossReferenceRequest {
  id: number;
  operation: "cross-reference";
  module?: KernelModule;
  fn: KernelFunction;
  targets: PatternCrossReferenceTarget[];
  source_pattern?: PatternResult;
}

export type PatternWorkerRequest = PatternWorkerGenerateRequest | PatternWorkerCrossReferenceRequest;

export type PatternWorkerResponse =
  | { id: number; operation: "generate"; ok: true; pattern: PatternResult }
  | { id: number; operation: "cross-reference"; ok: true; result: PatternCrossReferenceResult; patterns: PatternResult[] }
  | { id: number; operation: PatternWorkerOperation; ok: false; error: string };
