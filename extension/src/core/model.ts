// Shapes of the contract documents, limited to the fields the extension reads.

export interface Place { file: string; startLine: number; startColumn?: number; endLine?: number; endColumn?: number }
export type Metrics = Record<string, number | null>;

export interface Entity { id: string; name: string; module: string; location?: Place; metrics: Metrics }
export interface Evidence { paradigm: string; kind: string; count: number; description?: string; examples?: string[] }
export interface Module { id: string; name: string; files: string[]; loc: number; metrics: Metrics; paradigmEvidence: Evidence[]; activeParadigms?: string[] }
export interface Dependency { from: string; to: string; kind: string; phase: string; external?: boolean; stdlib?: boolean; count?: number }
export interface Cycle { level: "type" | "module"; members: string[] }
export interface SkippedRule { ruleId: string; module?: string; reason: string; message: string }
export interface Diagnostic { level: string; code?: string; message: string; file?: string }

export interface Facts {
  schemaVersion: string;
  analyzer: { name: string; version: string; language: string };
  files: { path: string; loc: number; lines: number; module?: string; parsed?: boolean }[];
  modules: Module[];
  types: Entity[];
  functions: Entity[];
  dependencies: Dependency[];
  cycles?: Cycle[];
  health?: { score: number; explanation?: string[] };
  skippedRules: SkippedRule[];
  diagnostics: Diagnostic[];
  checks?: { sarifFile?: string; resultCount?: number };
}

export interface Measured { metric: string; value: number; threshold?: number }

/** One SARIF result, flattened. */
export interface Finding {
  ruleId: string;
  ruleTitle: string;
  category: string;
  level: "error" | "warning" | "note";
  severity: string;
  confidence: string;
  message: string;
  explanation: string;
  file: string;
  startLine: number;
  startColumn: number;
  endLine: number;
  endColumn: number;
  module: string;
  entity?: string;
  measured?: Measured;
}

export interface AnalyzerConfig {
  language: string;
  command: string[];
  cwd?: string;
  env?: Record<string, string>;
  timeoutSeconds?: number;
}

export interface Workspace { schemaVersion: string; analyzers: AnalyzerConfig[]; root?: string }

/** The result of one analyzer run: partial means exit code 4, some files were not parsed. */
export interface AnalysisRun { language: string; root: string; facts: Facts; findings: Finding[]; partial: boolean }
