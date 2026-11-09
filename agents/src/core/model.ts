// Shapes of facts and findings that the agents read, limited to the fields they use (contracts/facts.schema.json,
// contracts/sarif-profile.md). The agents never change these documents.

export interface Place { file: string; startLine: number; startColumn?: number; endLine?: number; endColumn?: number }
export type Metrics = Record<string, number | null>;

export interface FunctionEntity {
  id: string;
  name: string;
  module: string;
  type?: string;
  kind?: string;
  location: Place;
  metrics: Metrics;
  parameters?: { name: string; typeName?: string }[];
  returnTypeName?: string;
}

export interface TypeEntity { id: string; name: string; module: string; kind?: string; location?: Place; metrics: Metrics }
export interface Evidence { paradigm: string; kind: string; count: number; description?: string; examples?: string[] }
export interface Module { id: string; name: string; files: string[]; loc: number; metrics: Metrics; paradigmEvidence: Evidence[]; activeParadigms?: string[] }
export interface SkippedRule { ruleId: string; module?: string; reason: string; message: string }

export interface Facts {
  schemaVersion: string;
  analyzer: { name: string; version: string; language: string };
  files: { path: string; loc: number; lines: number; module?: string; parsed?: boolean }[];
  modules: Module[];
  types: TypeEntity[];
  functions: FunctionEntity[];
  skippedRules: SkippedRule[];
  health?: { score: number; explanation?: string[] };
}

/** One SARIF result, flattened as the core extension flattens it. */
export interface Finding {
  ruleId: string;
  ruleTitle: string;
  category: string;
  level: string;
  confidence: string;
  message: string;
  explanation: string;
  file: string;
  startLine: number;
  endLine: number;
  module: string;
  entity?: string;
  measured?: { metric: string; value: number; threshold?: number };
}

/** Texts of a rule from the catalog (spec/rules, as extension/rules.json). */
export interface RuleText { id: string; category?: string; title: string; description?: string; rationale?: string; paradigms?: string[] }
export interface PracticeText { id: string; title: string; description?: string; rules: string[] }

export interface LanguageRun { language: string; facts: Facts; findings: Finding[] }

/** Everything the agents know about one analyzed root. */
export interface Snapshot { root: string; runs: LanguageRun[]; rules: RuleText[]; practices: PracticeText[] }

/** Which code an agent looks at: what changed against git, or the whole root. */
export type Scope = "changes" | "all";
