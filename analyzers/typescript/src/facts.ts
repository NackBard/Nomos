import fs from "node:fs";
import path from "node:path";
import type { Config, SpecRule } from "./config.ts";
import { ordinal, specRules } from "./config.ts";
import { Coverage } from "./coverage.ts";
import { timeEstimates } from "./estimate.ts";
import { buildGraphs, collectEdges, components } from "./graph.ts";
import {
  allocationDepth, atfd, cyclomatic, dit, halsteadVolume, hofOrder, isInstanceMethod, lambdaNesting, lcom4, lineSpan, maintainabilityIndex,
  maxNesting, memberUse, mostUsedForeign, parameterCount, round, spaceDegree, tcc, testedTypes, wmc,
} from "./metrics.ts";
import type { Evidence } from "./paradigms.ts";
import { activeParadigms, collectEvidence, pureFunctions } from "./paradigms.ts";
import type { Project } from "./project.ts";
import { extensions } from "./project.ts";
import type { Finding } from "./rules.ts";
import { Run, detectors, fingerprint, sortFindings, supported } from "./rules.ts";
import { selfCalls } from "./estimate.ts";
import { members, parameters, returnTypeName, satisfies } from "./structure.ts";

/** Protocol identity. */
export const analyzerName = "nomos-typescript";
export const analyzerVersion = "0.1.0";
const factsVersion = "1.3.0";
const manifestVersion = "1.2.0";

const languageNames: Record<string, string> = { typescript: "TypeScript", javascript: "JavaScript" };

/** The manifest of one language: the analyzer is one program with two registry entries (D-055). */
export function manifest(language: string): unknown {
  const byId = new Map(specRules().map((r) => [r.id, r]));
  return {
    name: analyzerName,
    language,
    version: analyzerVersion,
    schemaVersion: manifestVersion,
    paradigms: ["functional", "oop", "structural"],
    files: extensions[language].map((e) => `**/*${e}`),
    capabilities: { semantic: true, supportedRules: supported, partialAnalysis: false, sarif: true },
    rules: supported.map((id) => {
      const rule = byId.get(id)!;
      return { id, category: rule.category, paradigms: [...rule.paradigms].sort(ordinal), title: rule.title };
    }),
  };
}

interface Skipped { ruleId: string; module?: string; reason: string; message: string }

function notApplicable(paradigm: string): string {
  switch (paradigm) {
    case "oop": return "OOP rule not applicable: module has no classes";
    case "functional": return "Functional rule not applicable: module shows no functional style";
    case "structural": return "Structural rule not applicable: module has no free functions or branching";
  }
  return `Rule for paradigm '${paradigm}' not applicable: no evidence of it in the module`;
}

function level(severity: string): string {
  return severity === "critical" ? "error" : severity === "info" ? "note" : "warning";
}

function score(config: Config, loc: number, findings: Finding[], categories: string[]) {
  const { scoring } = config;
  const weight = (category: string) => scoring.categoryWeights[category] ?? 1;
  const totalWeight = categories.reduce((sum, c) => sum + weight(c), 0);
  const kloc = Math.max(loc / 1000, scoring.minKloc);
  let total = 0;
  const list = categories.map((category) => {
    let penalty = 0;
    let own = 0;
    for (const f of findings) {
      if (f.category !== category) continue;
      own++;
      penalty += (scoring.severityPenalties[f.severity] ?? 0) * (scoring.confidenceFactors[f.confidence] ?? 0);
    }
    const value = 100 * Math.exp(-penalty / kloc / scoring.decayPerKloc);
    const share = totalWeight > 0 ? weight(category) / totalWeight : 0;
    total += value * share;
    return { category, score: round(value, 1), weight: round(share, 3), penalty: round(penalty, 2), findingCount: own };
  });
  return { score: total, categories: list, explanation: [`Weighted mean over ${categories.length} categories, normalized by ${kloc.toFixed(3)} KLOC.`] };
}

export interface Result { facts: string; partial: boolean }

export interface Options { root: string; sarif?: string; selected?: Set<string>; config: Config }

/** Runs the detectors and builds facts; SARIF goes to the file named in the options. */
export function analyze(p: Project, options: Options): Result {
  const { config } = options;
  const edges = collectEdges(p);
  const graphs = buildGraphs(p, edges);
  const estimates = timeEstimates(p);
  const run = new Run(p, config, edges, graphs, estimates);
  const pure = pureFunctions(p);
  const enabled = config.enabledParadigms();
  const report = config.rules.MNT004?.threshold?.report;
  if (typeof report === "string" && report !== "") {
    try {
      run.coverage = Coverage.load(path.join(options.root, report));
    } catch {
      run.coverage = undefined;
    }
  }
  const evidence = new Map<string, Evidence[]>();
  const shown = new Map<string, string[]>();
  for (const m of p.modules) {
    evidence.set(m.id, collectEvidence(p, m, pure));
    shown.set(m.id, activeParadigms(evidence.get(m.id)!));
    run.active.set(m.id, new Set(shown.get(m.id)!.filter((x) => enabled.has(x))));
  }

  const rules = specRules();
  const supportedSet = new Set(supported);
  const outside = config.outsidePractices();
  const skips: Skipped[] = [];
  const categories = new Set<string>();
  const inputs: Record<string, boolean> = { "layer-config": config.layers.length > 0, "coverage-report": !!run.coverage };
  const languageName = languageNames[p.language];
  for (const rule of rules) {
    if (!supportedSet.has(rule.id)) {
      if (!rule.id.includes(".")) {
        skips.push({ ruleId: rule.id, reason: "not-supported", message: rule.id === "STR001" ? `${languageName} has no goto` : `Rule is not implemented for ${languageName}` });
      }
      continue;
    }
    const explicit = config.rules[rule.id]?.enabled;
    const byConfig = explicit === false || (options.selected !== undefined && !options.selected.has(rule.id));
    // An explicit rules.<id>.enabled wins over the practices (D-051).
    const practiceMessage = explicit === undefined ? outside?.get(rule.id) : undefined;
    const anyEnabled = rule.paradigms.length === 0 || rule.paradigms.some((x) => enabled.has(x));
    if (!anyEnabled) {
      skips.push({ ruleId: rule.id, reason: "disabled-by-config", message: `Rule needs paradigm ${[...rule.paradigms].sort(ordinal).join(" or ")}, which is off for this language; 'paradigms' in nomos.json selects them` });
    } else if (byConfig) {
      skips.push({ ruleId: rule.id, reason: "disabled-by-config", message: "Rule is off by nomos.json or by --rules" });
    } else if (practiceMessage) {
      skips.push({ ruleId: rule.id, reason: "disabled-by-config", message: practiceMessage });
    }
    if (byConfig || practiceMessage || !anyEnabled) continue;
    run.rule = rule;
    run.ran.set(rule.id, rule);
    categories.add(rule.category);
    detectors[rule.id](run);
    for (const input of rule.requires ?? []) {
      if (!inputs[input]) skips.push({ ruleId: rule.id, reason: "missing-input", message: `Rule not applied: no ${input} in the configuration` });
    }
  }
  for (const rule of rules) {
    if (!supportedSet.has(rule.id) || rule.paradigms.length === 0) continue;
    const ran = run.ran.has(rule.id);
    for (const m of p.modules) {
      const own = shown.get(m.id)!;
      const applies = rule.paradigms.some((x) => own.includes(x));
      const isActive = rule.paradigms.some((x) => own.includes(x) && enabled.has(x));
      if (!applies) skips.push({ ruleId: rule.id, module: m.id, reason: "paradigm-not-detected", message: notApplicable(rule.paradigms[0]) });
      else if (ran && !isActive) skips.push({ ruleId: rule.id, module: m.id, reason: "disabled-by-config", message: "Rule not applied: every paradigm the module shows for it is off for this language" });
    }
  }
  skips.sort((a, b) => ordinal(a.ruleId, b.ruleId) || ordinal(a.module ?? "", b.module ?? "") || ordinal(a.reason, b.reason));

  const byFile = new Map(p.files.map((f) => [f.path, f]));
  const sorted = sortFindings(run.findings);
  const findings = sorted.filter((f) => !byFile.get(f.place.file)?.directives.covers(f.rule, f.place.startLine));
  const suppressed = sorted.length - findings.length;
  for (const f of findings) if (!f.module && byFile.get(f.place.file)) f.module = byFile.get(f.place.file)!.module.id;
  const categoryList = [...categories].sort(ordinal);

  const diagnostics: { level: string; message: string; file?: string; code?: string }[] = [...p.notes];
  let partial = false;
  const files = p.files.map((f) => {
    const entry: Record<string, unknown> = { path: f.path, lines: f.lines, loc: f.loc };
    if (run.coverage) {
      const percent = run.coverage.percent(f.path);
      if (percent !== undefined) entry.coverage = percent;
    }
    entry.module = f.module.id;
    entry.parsed = !f.broken;
    if (f.broken) {
      partial = true;
      diagnostics.push({ level: "warning", message: "Syntax errors: declarations in this file may be missing from the facts.", file: f.path, code: "syntax-error" });
    }
    return entry;
  });
  if (suppressed > 0) diagnostics.push({ level: "info", message: `${suppressed} finding(s) suppressed by directives.`, code: "suppressed" });
  if (p.files.length === 0) diagnostics.push({ level: "info", message: `No ${languageName} files under the root outside dependency and build folders.`, code: "no-files" });

  let total = 0;
  let totalLoc = 0;
  const modules = p.modules.map((m) => {
    const loc = m.file.loc;
    const own = findings.filter((f) => f.module === m.id);
    const health = score(config, loc, own, categoryList);
    total += health.score * loc;
    totalLoc += loc;
    const { ca, ce, instability, abstractness, distance } = run.martin(m);
    return {
      id: m.id, name: m.name, files: [m.file.path], loc,
      metrics: { ca, ce, instability, abstractness, distance },
      paradigmEvidence: evidence.get(m.id)!, activeParadigms: shown.get(m.id)!,
      health: { ...health, score: round(health.score, 1) },
    };
  });
  const projectScore = totalLoc > 0 ? total / totalLoc : 100;
  const projectCategories = categoryList.map((category) => score(config, Math.max(totalLoc, 1), findings.filter((f) => f.category === category), [category]).categories[0]);

  const allTypes = p.allTypes();
  const types = allTypes.map((t) => {
    const metrics: Record<string, number | null> = {
      lines: lineSpan(t.place),
      memberCount: t.members.length + t.methods.filter((m) => m.kind !== "accessor").length,
      methodCount: t.methods.filter((m) => m.kind === "method" || m.kind === "constructor").length,
      blastRadius: graphs.radius.get(t.id) ?? 0,
    };
    if (t.kind === "class") {
      metrics.dit = dit(p, t);
      metrics.cbo = run.cbo(t);
      metrics.lcom4 = lcom4(p, t);
      metrics.wmc = wmc(t);
      metrics.atfd = atfd(p, t);
      metrics.tcc = tcc(p, t);
    }
    const entry: Record<string, unknown> = { id: t.id, name: t.name, module: t.module.id, kind: t.kind, isAbstract: t.isAbstract, location: t.place };
    if (t.typeParameters.length > 0) entry.typeParameters = t.typeParameters;
    const own = members(p, t);
    if (own) entry.members = own;
    const implicit = satisfies(p, t, allTypes);
    if (implicit) entry.satisfies = implicit;
    entry.metrics = metrics;
    return entry;
  });

  const functions = p.allFunctions().map((f) => {
    const unit = f.owner ? f.owner.id : f.id;
    const metrics: Record<string, number | null> = {
      cyclomatic: cyclomatic(f), maxNesting: maxNesting(f), parameterCount: parameterCount(f), lines: lineSpan(f.place),
      hofOrder: hofOrder(f), lambdaNesting: lambdaNesting(f), typeTests: testedTypes(p, f).length, blastRadius: graphs.radius.get(unit) ?? 0,
      timeDegree: null, timeLogFactor: null, timeExponential: null, spaceDegree: null, allocationDepth: null, foreignMembers: null, ownMembers: null,
      halsteadVolume: null, maintainabilityIndex: null,
    };
    const volume = halsteadVolume(f);
    if (volume !== null) {
      metrics.halsteadVolume = round(volume, 4);
      metrics.maintainabilityIndex = round(maintainabilityIndex(f)!, 4);
    }
    const growth = estimates.get(f.id);
    if (growth) {
      metrics.timeExponential = growth.exponential ? 1 : 0;
      if (!growth.exponential) {
        metrics.timeDegree = growth.degree;
        metrics.timeLogFactor = growth.log;
      }
      metrics.spaceDegree = spaceDegree(f, selfCalls(p, f).length);
      metrics.allocationDepth = allocationDepth(f);
    }
    if (isInstanceMethod(f)) {
      metrics.foreignMembers = mostUsedForeign(p, f).members.length;
      metrics.ownMembers = memberUse(p, f).own.size;
    }
    const entry: Record<string, unknown> = { id: f.id, name: f.name, module: f.module.id };
    if (f.owner) entry.type = f.owner.id;
    entry.kind = f.kind;
    entry.visibility = f.visibility;
    entry.location = f.place;
    entry.parameters = parameters(f);
    const result = returnTypeName(f);
    if (result) entry.returnTypeName = result;
    if (f.isStatic) entry.isStatic = true;
    if (f.isAbstract) entry.isAbstract = true;
    entry.metrics = metrics;
    return entry;
  });

  const merged = new Map<string, Record<string, unknown>>();
  for (const e of edges) {
    const phase = e.typeOnly ? "type-only" : "runtime";
    const key = `${e.from}\u0000${e.to}\u0000${e.kind}\u0000${phase}`;
    const seen = merged.get(key);
    if (seen) seen.count = (seen.count as number) + 1;
    else merged.set(key, { from: e.from, to: e.to, kind: e.kind, phase, external: e.external, stdlib: e.stdlib, count: 1, location: e.place });
  }
  const dependencies = [...merged.keys()].sort(ordinal).map((key) => merged.get(key)!);
  const cycles = [
    ...components(graphs.runtimeUnits).map((members) => ({ level: "type", members })),
    ...components(graphs.runtimeModules).map((members) => ({ level: "module", members })),
  ];

  const document: Record<string, unknown> = {
    schemaVersion: factsVersion,
    analyzer: { name: analyzerName, version: analyzerVersion, language: p.language, semantic: true },
    files, modules, types, functions, dependencies, cycles,
    health: { score: round(projectScore, 1), categories: projectCategories, explanation: [`Mean of ${modules.length} module score(s), weighted by lines of code (${totalLoc} total).`] },
    skippedRules: skips,
    diagnostics,
  };
  if (options.sarif) {
    fs.writeFileSync(options.sarif, sarif(findings));
    document.checks = { sarifFile: options.sarif, resultCount: findings.length };
  }
  return { facts: JSON.stringify(document, null, 2) + "\n", partial };
}

/** The first key of a rule whose template a text was made from (spec/l10n.md). */
function keyOf(rule: SpecRule | undefined, template: string): string | undefined {
  return Object.entries(rule?.messages ?? {}).filter(([, m]) => m.text === template).map(([k]) => k).sort(ordinal)[0];
}

function sarif(findings: Finding[]): string {
  const byId = new Map(specRules().map((r) => [r.id, r]));
  const ids = [...supported].sort(ordinal);
  const index = new Map(ids.map((id, i) => [id, i]));
  const rules = ids.map((id) => {
    const rule = byId.get(id)!;
    const entry: Record<string, unknown> = {
      id, name: rule.title, shortDescription: { text: rule.description }, fullDescription: { text: rule.rationale },
      defaultConfiguration: { level: level(rule.severity) },
      properties: { category: rule.category, paradigms: [...rule.paradigms].sort(ordinal) },
    };
    if (rule.messages && Object.keys(rule.messages).length > 0) {
      entry.messageStrings = Object.fromEntries(Object.keys(rule.messages).sort(ordinal).map((k) => [k, { text: rule.messages![k].text }]));
    }
    return entry;
  });
  const results = findings.map((f) => {
    const rule = byId.get(f.rule);
    const properties: Record<string, unknown> = { severity: f.severity, confidence: f.confidence, explanation: f.explanation };
    if (f.module) properties.module = f.module;
    if (f.entity) properties.entity = f.entity;
    if (f.measured) properties.measured = f.measured;
    const explanationKey = keyOf(rule, f.explanationText.template);
    if (explanationKey) properties.explanationMessage = { id: explanationKey, arguments: f.explanationText.args };
    const message: Record<string, unknown> = { text: f.message };
    const messageKey = keyOf(rule, f.messageText.template);
    if (messageKey) {
      message.id = messageKey;
      message.arguments = f.messageText.args;
    }
    return {
      ruleId: f.rule, ruleIndex: index.get(f.rule), level: level(f.severity), message,
      locations: [{ physicalLocation: { artifactLocation: { uri: f.place.file }, region: { startLine: f.place.startLine, startColumn: f.place.startColumn, endLine: f.place.endLine, endColumn: f.place.endColumn } } }],
      partialFingerprints: { "nomos/v1": fingerprint(f) },
      properties,
    };
  });
  return JSON.stringify({
    $schema: "https://json.schemastore.org/sarif-2.1.0.json",
    version: "2.1.0",
    runs: [{ tool: { driver: { name: analyzerName, version: analyzerVersion, semanticVersion: analyzerVersion, rules } }, results }],
  }, null, 2) + "\n";
}
