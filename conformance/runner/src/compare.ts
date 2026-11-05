export interface Tolerance { absolute?: number; relative?: number }
export interface CaseSpec {
  id: string;
  languages: string[];
  tolerance?: { default?: Tolerance; metrics?: Record<string, Tolerance> };
  covers?: string[];
  expectSarif?: boolean;
  config?: boolean;
  exceptions?: { language: string; reason: string }[];
  parity?: { metric: string; scope: "module" | "type" | "function"; entities: Record<string, string> }[];
}

const DEFAULT_ABSOLUTE = 0.001;
// spec/metrics.md, "Допуски в conformance": token-dependent metrics are order-of-magnitude only.
const BUILTIN: Record<string, Tolerance> = {
  halsteadVolume: { relative: 0.15 },
  maintainabilityIndex: { relative: 0.15 },
};

export function toleranceFor(spec: CaseSpec, metric: string): Tolerance {
  return spec.tolerance?.metrics?.[metric] ?? BUILTIN[metric] ?? spec.tolerance?.default ?? { absolute: DEFAULT_ABSOLUTE };
}

/** Integers are exact; other numbers use the tolerance; null only equals null. */
export function valuesMatch(expected: unknown, actual: unknown, tolerance: Tolerance): boolean {
  if (expected === null || actual === null) return expected === actual;
  if (typeof expected !== "number" || typeof actual !== "number") return expected === actual;
  if (Number.isInteger(expected) && Number.isInteger(actual)) return expected === actual;
  const diff = Math.abs(expected - actual);
  return diff <= (tolerance.absolute ?? 0) || diff <= (tolerance.relative ?? 0) * Math.abs(expected);
}

type Metrics = Record<string, number | null>;

function compareMetrics(where: string, expected: Metrics, actual: Metrics, spec: CaseSpec, errors: string[]): void {
  for (const [name, value] of Object.entries(expected)) {
    if (!(name in actual)) {
      errors.push(`${where}: metric ${name} is missing (expected ${value})`);
    } else if (!valuesMatch(value, actual[name], toleranceFor(spec, name))) {
      errors.push(`${where}: metric ${name} is ${actual[name]}, expected ${value}`);
    }
  }
}

function compareById(kind: string, expected: any[], actual: any[], errors: string[], each: (id: string, e: any, a: any) => void): void {
  const byId = new Map<string, any>(actual.map((x) => [x.id, x]));
  const expectedIds = new Set<string>(expected.map((x) => x.id));
  for (const e of expected) {
    const a = byId.get(e.id);
    if (!a) errors.push(`${kind} ${e.id}: expected but not reported`);
    else each(e.id, e, a);
  }
  for (const a of actual) if (!expectedIds.has(a.id)) errors.push(`${kind} ${a.id}: reported but not expected`);
}

/** Every expected item must be present; extra actual items are not an error. */
function compareSubset(kind: string, expected: string[], actual: string[], errors: string[]): void {
  const a = new Set(actual);
  for (const x of [...new Set(expected)].sort()) if (!a.has(x)) errors.push(`${kind} ${x}: expected but not reported`);
}

function compareSets(kind: string, expected: string[], actual: string[], errors: string[]): void {
  const e = new Set(expected);
  const a = new Set(actual);
  for (const x of [...e].sort()) if (!a.has(x)) errors.push(`${kind} ${x}: expected but not reported`);
  for (const x of [...a].sort()) if (!e.has(x)) errors.push(`${kind} ${x}: reported but not expected`);
}

// spec/structure.md: absent fields take their defaults, so a hand-written expectation can leave them out.
const member = (m: any) => ({ name: m.name, kind: m.kind, visibility: m.visibility ?? "unspecified", typeName: m.typeName ?? null, type: m.type ?? null,
  isStatic: m.isStatic ?? false, isCollection: m.isCollection ?? false, isEmbedded: m.isEmbedded ?? false });
const parameter = (p: any) => `${p.name}: ${p.typeName ?? "-"}`;

function compareList(where: string, expected: unknown[], actual: unknown[], errors: string[]): void {
  const e = expected.map((x) => JSON.stringify(x));
  const a = actual.map((x) => JSON.stringify(x));
  if (e.join("\n") !== a.join("\n")) errors.push(`${where} is [${a.join(", ")}], expected [${e.join(", ")}]`);
}

/** Structure fields of facts 1.3.0, in declaration order; only for cases that cover "structure". */
function compareStructure(kind: "type" | "function", id: string, e: any, a: any, errors: string[]): void {
  if (kind === "type") {
    compareList(`type ${id}: typeParameters`, e.typeParameters ?? [], a.typeParameters ?? [], errors);
    compareList(`type ${id}: members`, (e.members ?? []).map(member), (a.members ?? []).map(member), errors);
    compareList(`type ${id}: satisfies`, [...(e.satisfies ?? [])].sort(), [...(a.satisfies ?? [])].sort(), errors);
    return;
  }
  compareList(`function ${id}: parameters`, (e.parameters ?? []).map(parameter), (a.parameters ?? []).map(parameter), errors);
  for (const key of ["returnTypeName", "isStatic", "isAbstract"]) {
    const fallback = key === "returnTypeName" ? null : false;
    if ((e[key] ?? fallback) !== (a[key] ?? fallback)) errors.push(`function ${id}: ${key} is ${a[key] ?? fallback}, expected ${e[key] ?? fallback}`);
  }
}

/** Compares actual facts with the hand-computed ones. Array order is irrelevant, except for the structure lists. */
export function compareFacts(expected: any, actual: any, spec: CaseSpec): string[] {
  const errors: string[] = [];
  const structure = spec.covers?.includes("structure") ?? false;

  compareById("file", (expected.files ?? []).map((f: any) => ({ ...f, id: f.path })), (actual.files ?? []).map((f: any) => ({ ...f, id: f.path })), errors, (id, e, a) => {
    for (const key of ["lines", "loc"]) if (e[key] !== a[key]) errors.push(`file ${id}: ${key} is ${a[key]}, expected ${e[key]}`);
    if ((e.parsed ?? true) !== (a.parsed ?? true)) errors.push(`file ${id}: parsed is ${a.parsed ?? true}, expected ${e.parsed ?? true}`);
    if (e.coverage !== undefined && !valuesMatch(e.coverage, a.coverage ?? null, toleranceFor(spec, "coverage"))) errors.push(`file ${id}: coverage is ${a.coverage}, expected ${e.coverage}`);
  });

  compareById("module", expected.modules, actual.modules, errors, (id, e, a) => {
    if (e.loc !== a.loc) errors.push(`module ${id}: loc is ${a.loc}, expected ${e.loc}`);
    compareMetrics(`module ${id}`, e.metrics, a.metrics, spec, errors);
    const evidence = (list: any[]) => list.map((x) => `${x.kind}=${x.count}`);
    // Evidence is exact only for cases that declare they cover it; elsewhere a language may report more kinds.
    (spec.covers?.includes("paradigmEvidence") ? compareSets : compareSubset)(`module ${id} evidence`, evidence(e.paradigmEvidence), evidence(a.paradigmEvidence), errors);
    if (e.activeParadigms) compareSets(`module ${id} active paradigm`, e.activeParadigms, a.activeParadigms ?? [], errors);
    if (e.health && a.health && !valuesMatch(e.health.score, a.health.score, toleranceFor(spec, "health"))) {
      errors.push(`module ${id}: health.score is ${a.health.score}, expected ${e.health.score}`);
    }
  });

  compareById("type", expected.types, actual.types, errors, (id, e, a) => {
    for (const key of ["module", "kind", "isAbstract"]) if (e[key] !== a[key]) errors.push(`type ${id}: ${key} is ${a[key]}, expected ${e[key]}`);
    compareMetrics(`type ${id}`, e.metrics, a.metrics, spec, errors);
    if (structure) compareStructure("type", id, e, a, errors);
  });

  compareById("function", expected.functions, actual.functions, errors, (id, e, a) => {
    for (const key of ["module", "type"]) if (e[key] !== a[key]) errors.push(`function ${id}: ${key} is ${a[key]}, expected ${e[key]}`);
    compareMetrics(`function ${id}`, e.metrics, a.metrics, spec, errors);
    if (structure) compareStructure("function", id, e, a, errors);
  });

  // Edges are compared by (from, to, kind, phase); kinds are defined in spec/metrics.md. External targets are
  // optional detail and are left out on both sides.
  const dependency = (d: any) => `${d.from} -> ${d.to} [${d.kind}, ${d.phase}]`;
  const internal = (list: any[]) => list.filter((d) => !d.external && !d.stdlib).map(dependency);
  compareSets("dependency", internal(expected.dependencies), internal(actual.dependencies), errors);

  const cycle = (c: any) => `${c.level}: ${[...c.members].sort().join(", ")}`;
  compareSets("cycle", (expected.cycles ?? []).map(cycle), (actual.cycles ?? []).map(cycle), errors);

  const skipped = (s: any) => `${s.ruleId} @ ${s.module ?? "*"} (${s.reason})`;
  // Expected diagnostics that name a file (syntax errors) must be reported; others are analyzer-specific notes.
  const diagnostic = (d: any) => `${d.level} ${d.file} ${d.code ?? ""}`;
  compareSubset("diagnostic", (expected.diagnostics ?? []).filter((d: any) => d.file).map(diagnostic), (actual.diagnostics ?? []).map(diagnostic), errors);

  // Completeness of paradigm-not-detected records is checked separately against the analyzer's supportedRules.
  compareSubset("skipped rule", expected.skippedRules.map(skipped), actual.skippedRules.map(skipped), errors);

  if (expected.health && actual.health && !valuesMatch(expected.health.score, actual.health.score, toleranceFor(spec, "health"))) {
    errors.push(`health.score is ${actual.health.score}, expected ${expected.health.score}`);
  }
  return errors;
}

/**
 * Applicability by spec/paradigms.md, for every module: the active paradigms follow from the evidence kinds marked as
 * activating, a rule without any of its paradigms active has a paradigm-not-detected record, and a rule with one has none.
 */
export function checkApplicability(facts: any, activating: Map<string, string>, rules: { id: string; paradigms: string[] }[]): string[] {
  const errors: string[] = [];
  const known = new Set(activating.values());
  const scoped = rules.filter((r) => r.paradigms.length > 0 && r.paradigms.every((p) => known.has(p)));
  for (const module of facts.modules as any[]) {
    const active = new Set<string>(module.paradigmEvidence.flatMap((e: any) => (activating.has(e.kind) ? [activating.get(e.kind)!] : [])));
    if (module.activeParadigms) compareSets(`module ${module.id} activeParadigms`, [...active], module.activeParadigms, errors);
    for (const rule of scoped) {
      const applies = rule.paradigms.some((p) => active.has(p));
      const recorded = facts.skippedRules.some((s: any) => s.ruleId === rule.id && s.module === module.id && s.reason === "paradigm-not-detected");
      if (!applies && !recorded) errors.push(`module ${module.id} shows none of [${rule.paradigms}] but rule ${rule.id} has no paradigm-not-detected record`);
      if (applies && recorded) errors.push(`module ${module.id} shows a paradigm of rule ${rule.id} but it is recorded as paradigm-not-detected`);
    }
  }
  return errors;
}

/** The inputs of `requires` in spec/rules that a workspace file provides for one rule. */
function providedInputs(config: any, ruleId: string): Set<string> {
  const inputs = new Set<string>();
  if (config?.layers?.length) inputs.add("layer-config");
  if (config?.rules?.[ruleId]?.threshold?.report !== undefined) inputs.add("coverage-report");
  return inputs;
}

/**
 * A rule without its external input has a missing-input record for the whole run, and a rule with it has none.
 * A rule the configuration switched off does not run, so whether it has its input does not matter (practices, D-051).
 */
export function checkRequiredInputs(facts: any, config: any, rules: { id: string; requires?: string[] }[]): string[] {
  const errors: string[] = [];
  const off = (id: string) => facts.skippedRules.some((s: any) => s.ruleId === id && s.module === undefined && s.reason === "disabled-by-config");
  for (const rule of rules.filter((r) => r.requires?.length && !off(r.id))) {
    const provided = providedInputs(config, rule.id);
    const complete = rule.requires!.every((input) => provided.has(input));
    const recorded = facts.skippedRules.some((s: any) => s.ruleId === rule.id && s.module === undefined && s.reason === "missing-input");
    if (!complete && !recorded) errors.push(`rule ${rule.id} lacks [${rule.requires}] but has no missing-input record`);
    if (complete && recorded) errors.push(`rule ${rule.id} has its input but is recorded as missing-input`);
  }
  return errors;
}

/** The evidence kinds marked "да" in the tables of spec/paradigms.md, as kind to paradigm. */
export function activatingKinds(paradigmsSpec: string): Map<string, string> {
  const kinds = new Map<string, string>();
  let paradigm = "";
  for (const line of paradigmsSpec.split("\n")) {
    const heading = /^### (\w+)$/.exec(line);
    if (heading) paradigm = heading[1];
    const row = /^\| `([a-z]+\.[a-z0-9-]+)` \|.*\| \*\*да\*\* \|$/.exec(line.trimEnd());
    if (row) kinds.set(row[1], paradigm);
  }
  return kinds;
}

function entityMetric(facts: any, scope: string, id: string, metric: string): number | null | undefined {
  const list = scope === "module" ? facts.modules : scope === "type" ? facts.types : facts.functions;
  const entity = list.find((x: any) => x.id === id);
  return entity ? (entity.metrics[metric] ?? undefined) : undefined;
}

/** Parity: the same metric of equivalent entities is equal across languages (facts per language). */
export function checkParity(spec: CaseSpec, factsByLanguage: Map<string, any>): string[] {
  const errors: string[] = [];
  for (const rule of spec.parity ?? []) {
    const values = Object.entries(rule.entities)
      .filter(([language]) => factsByLanguage.has(language))
      .map(([language, id]) => ({ language, id, value: entityMetric(factsByLanguage.get(language), rule.scope, id, rule.metric) }));
    if (values.length < 2) continue;
    const [first, ...rest] = values;
    for (const other of rest) {
      if (first.value === undefined || other.value === undefined || !valuesMatch(first.value, other.value, toleranceFor(spec, rule.metric))) {
        errors.push(`parity ${rule.metric}: ${first.language} ${first.id} = ${first.value ?? "missing"}, ${other.language} ${other.id} = ${other.value ?? "missing"}`);
      }
    }
  }
  return errors;
}
