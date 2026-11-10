// The parts of the facts contract and of the core's flattened SARIF findings that the scores read
// (contracts/facts.schema.json, extension/src/core/model.ts). Nothing here names a programming language.

export type Metrics = Record<string, number | null | undefined>;
export interface Place { file: string; startLine: number }
export interface Entity { id: string; name: string; module: string; kind?: string; isAbstract?: boolean; type?: string; location?: Place; metrics: Metrics }
export interface Module { id: string; name: string; files: string[]; loc: number; metrics: Metrics }
export interface Dependency { from: string; to: string; kind: string; phase?: string; external?: boolean; count?: number }
export interface Cycle { level: "type" | "module"; members: string[] }
export interface HealthCategory { category: string; score?: number }

export interface Facts {
  analyzer: { language: string };
  files: { path: string; loc: number; module?: string }[];
  modules: Module[];
  types: Entity[];
  functions: Entity[];
  dependencies: Dependency[];
  cycles?: Cycle[];
  health?: { score: number; categories?: HealthCategory[] };
}

export interface Finding {
  ruleId: string;
  category: string;
  severity: string;
  confidence: string;
  message: string;
  file: string;
  startLine: number;
  module: string;
  entity?: string;
}

/** One analyzer run as the core's NomosApi gives it. */
export interface AnalysisRun { language: string; root: string; facts: Facts; findings: Finding[] }

/** Ordinal comparison: UTF-16 code units, as everywhere in Nomos. */
export function ordinal(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
