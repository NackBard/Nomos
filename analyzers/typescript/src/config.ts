import fs from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

/** One rule of spec/rules; rules.json is generated from them (npm run spec-json in conformance/runner). */
export interface SpecRule {
  id: string;
  category: string;
  title: string;
  description: string;
  rationale: string;
  paradigms: string[];
  severity: string;
  confidence: string;
  threshold?: Record<string, unknown>;
  requires?: string[];
  messages?: Record<string, { text: string; ru?: string }>;
}

/** One practice of spec/practices.yaml (practices.json). */
export interface SpecPractice { id: string; title: string; description: string; rules: string[] }

let rules: SpecRule[] | undefined;
let practices: SpecPractice[] | undefined;

/** The rules of spec, shipped next to the analyzer. */
export function specRules(): SpecRule[] {
  return (rules ??= require("./rules.json") as SpecRule[]);
}

/** The practice catalog of spec. */
export function specPractices(): SpecPractice[] {
  return (practices ??= require("./practices.json") as SpecPractice[]);
}

export interface RuleConfig { enabled?: boolean; severity?: string; threshold?: Record<string, unknown> }
export interface Layer { name: string; patterns: string[]; mayDependOn: string[] }
export interface Scoring {
  categoryWeights: Record<string, number>;
  severityPenalties: Record<string, number>;
  confidenceFactors: Record<string, number>;
  decayPerKloc: number;
  minKloc: number;
}

/** The input is unusable: exit code 3. */
export class ConfigError extends Error {}

/** The part of the workspace file (contracts/nomos.schema.json) this analyzer reads. */
export class Config {
  analyzers: { language: string; include?: string[]; exclude?: string[] }[] = [];
  rules: Record<string, RuleConfig> = {};
  practices?: string[];
  paradigms: Record<string, string[]> = {};
  layers: Layer[] = [];
  scoring: Scoring;
  readonly language: string;

  constructor(raw: any, language: string) {
    this.language = language;
    this.analyzers = raw.analyzers ?? [];
    this.rules = raw.rules ?? {};
    this.practices = raw.practices;
    this.paradigms = raw.paradigms ?? {};
    this.layers = raw.layers ?? [];
    const scoring = raw.scoring ?? {};
    this.scoring = {
      categoryWeights: scoring.categoryWeights ?? {},
      severityPenalties: { info: 0, minor: 1, major: 3, critical: 8, ...scoring.severityPenalties },
      confidenceFactors: { low: 0.25, medium: 0.6, high: 1, ...scoring.confidenceFactors },
      decayPerKloc: scoring.decayPerKloc || 20,
      minKloc: scoring.minKloc || 0.2,
    };
  }

  /** The include and exclude globs of this language. */
  scope(): { include: string[]; exclude: string[] } {
    const own = this.analyzers.find((a) => a.language === this.language);
    return { include: own?.include ?? [], exclude: own?.exclude ?? [] };
  }

  /** D-011: the functional style is opt-in, like in the C# and Go analyzers. */
  enabledParadigms(): Set<string> {
    return new Set(this.paradigms[this.language] ?? ["oop", "structural"]);
  }

  /**
   * For each rule outside the practices the workspace file selects, the message recorded in skippedRules (D-051).
   * Undefined when the file selects no practices: every rule runs.
   */
  outsidePractices(): Map<string, string> | undefined {
    if (!this.practices) return undefined;
    const selected = new Set(this.practices);
    const owners = new Map<string, string[]>();
    for (const practice of specPractices()) {
      for (const rule of practice.rules) owners.set(rule, [...(owners.get(rule) ?? []), practice.id]);
    }
    const outside = new Map<string, string>();
    for (const [rule, list] of owners) {
      if (!list.some((p) => selected.has(p))) {
        outside.set(rule, `Rule belongs to practice ${[...list].sort(ordinal).join(" or ")}, which is not selected; 'practices' in nomos.json selects them`);
      }
    }
    return outside;
  }

  threshold(rule: SpecRule, name: string): unknown {
    const own = this.rules[rule.id]?.threshold;
    if (own && name in own) return own[name];
    return rule.threshold?.[name];
  }

  number(rule: SpecRule, name: string): number {
    const value = this.threshold(rule, name);
    return typeof value === "number" ? value : 0;
  }

  layerOf(module: string): Layer | undefined {
    for (const layer of this.layers) {
      for (const pattern of layer.patterns) {
        const expression = pattern.split("*").map(escape).join(".*");
        if (new RegExp(`^${expression}$`, "i").test(module)) return layer;
      }
    }
    return undefined;
  }
}

function escape(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Ordinal comparison, the order of every array in the output. */
export function ordinal(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Reads the file named by --config; no path gives the defaults. */
export function loadConfig(file: string | undefined, language: string): Config {
  if (!file) return new Config({}, language);
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    throw new ConfigError(`config file not found: ${file}`);
  }
  let raw: any;
  try {
    raw = JSON.parse(text.replace(/^﻿/, ""));
  } catch (e) {
    throw new ConfigError(`${file}: ${(e as Error).message}`);
  }
  if (typeof raw?.schemaVersion !== "string" || !raw.schemaVersion.startsWith("1.")) {
    throw new ConfigError(`${file}: expected schemaVersion 1.x, found '${raw?.schemaVersion ?? ""}'`);
  }
  if (raw.practices) {
    const known = new Set(specPractices().map((p) => p.id));
    for (const id of raw.practices) if (!known.has(id)) throw new ConfigError(`${file}: unknown practice '${id}'`);
  }
  return new Config(raw, language);
}
