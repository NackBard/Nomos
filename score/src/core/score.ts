// The scores of spec/score.md: components of a module, scores of a module and of the system, scalability of the unit
// graph and the split of what the system's overall score misses. Numbers with their derivation, never a verdict (D-021, D-065).
import type { AnalysisRun, Entity, Finding } from "./model";
import { ordinal } from "./model";
import type { UnitGraph, VisibilityClass } from "./graph";
import { criticalShare, percolationCurve, reachCounts, removalOrder, robustnessOf, undirected, unitGraph, visibilityClasses } from "./graph";

export type ScoreKey = "stability" | "extensibility" | "conformance" | "maintainability";
export type ComponentKey =
  | "mainSequence" | "acyclic" | "containment"
  | "coupling" | "cohesion" | "typeSize" | "inheritance"
  | "designFindings"
  | "maintainabilityIndex" | "complexity" | "codeFindings";

export const ScoreKeys: ScoreKey[] = ["stability", "extensibility", "conformance", "maintainability"];
export const ScoreComponents: Record<ScoreKey, ComponentKey[]> = {
  stability: ["mainSequence", "acyclic", "containment"],
  extensibility: ["coupling", "cohesion", "typeSize", "inheritance"],
  conformance: ["designFindings"],
  maintainability: ["maintainabilityIndex", "complexity", "codeFindings"],
};

/** Sensitivities of spec/score.md: where soft() gives 50. */
export const Half = { cbo: 10, wmc: 40, dit: 4, cyclomatic: 15 };
/** Defaults of the health score in spec/metrics.md, which findings() reuses. */
export const SeverityPenalties: Record<string, number> = { info: 0, minor: 1, major: 3, critical: 8 };
export const ConfidenceFactors: Record<string, number> = { low: 0.25, medium: 0.6, high: 1 };
export const DecayPerKloc = 20;
export const MinKloc = 0.2;
/** Categories of the Code group; every other category belongs to Design. */
export const CodeCategories = new Set(["Maintainability", "Algorithms"]);
export const ZoneDistance = 0.5;
export const HubShare = 0.25;

export type Inputs = Record<string, number | null>;
export interface Component { key: ComponentKey; value: number | null; inputs: Inputs }
export interface Score { key: ScoreKey; value: number | null; components: Component[] }
export type Zone = "pain" | "uselessness";

export interface ModuleScore {
  id: string;
  name: string;
  loc: number;
  ca: number | null;
  ce: number | null;
  instability: number | null;
  abstractness: number | null;
  distance: number | null;
  zone: Zone | null;
  inModuleCycle: boolean;
  units: number;
  types: number;
  functions: number;
  findings: number;
  scores: Score[];
  overall: number | null;
}

export interface Loss { module: string; score: ScoreKey; component: ComponentKey; value: number; lost: number; inputs: Inputs }

export interface Scalability {
  value: number | null;
  propagation: number | null;
  core: number | null;
  decomposability: number | null;
  /** R of spec/score.md, 0…0.5. */
  robustness: number | null;
  propagationCost: number | null;
  largestCycle: number;
  criticalShare: number | null;
}

export interface UnitScore { index: number; blastRadius: number; fanOut: number; degree: number; cls: VisibilityClass; inCycle: boolean }

export interface Analysis {
  run: AnalysisRun;
  graph: UnitGraph;
  units: UnitScore[];
  modules: ModuleScore[];
  system: { scores: { key: ScoreKey; value: number | null }[]; overall: number | null; loc: number };
  scalability: Scalability;
  losses: Loss[];
  curves: { degree: number[]; blast: number[] } | null;
}

export const soft = (x: number, half: number) => 100 / (1 + (Math.max(0, x) / half) ** 2);

export function mean(values: (number | null | undefined)[]): number | null {
  const known = values.filter((v): v is number => typeof v === "number" && Number.isFinite(v));
  return known.length ? known.reduce((a, b) => a + b, 0) / known.length : null;
}

export function wmean(pairs: [number | null | undefined, number][]): number | null {
  let sum = 0;
  let weight = 0;
  for (const [value, w] of pairs) {
    if (typeof value !== "number" || !Number.isFinite(value)) continue;
    sum += value * w;
    weight += w;
  }
  return weight ? sum / weight : null;
}

const metric = (e: { metrics: Record<string, number | null | undefined> }, name: string) => {
  const value = e.metrics[name];
  return typeof value === "number" ? value : null;
};

/** The metric of each entity that has it. */
const known = (entities: Entity[], name: string) => entities.map((e) => metric(e, name)).filter((v): v is number => v !== null);

function findingsComponent(key: ComponentKey, findings: Finding[], ran: string[], loc: number): Component {
  const kloc = Math.max(loc / 1000, MinKloc);
  if (!ran.length) return { key, value: null, inputs: { findings: findings.length, penalty: null, kloc } };
  const penalty = findings.reduce((sum, f) => sum + (SeverityPenalties[f.severity] ?? 0) * (ConfidenceFactors[f.confidence] ?? 0), 0);
  return { key, value: 100 * Math.exp(-penalty / kloc / DecayPerKloc), inputs: { findings: findings.length, penalty, kloc } };
}

export function analyse(run: AnalysisRun): Analysis {
  const { facts } = run;
  const graph = unitGraph(facts);
  const n = graph.ids.length;
  const blast = reachCounts(graph.in);
  const fanOut = reachCounts(graph.out);
  const neighbours = undirected(graph);
  const degree = neighbours.map((l) => l.length);
  const classes = visibilityClasses(blast, fanOut);
  const typeCycles = (facts.cycles ?? []).filter((c) => c.level === "type");
  const inTypeCycle = new Set(typeCycles.flatMap((c) => c.members));
  const inModuleCycle = new Set((facts.cycles ?? []).filter((c) => c.level === "module").flatMap((c) => c.members));
  const units: UnitScore[] = graph.ids.map((id, index) => ({ index, blastRadius: blast[index], fanOut: fanOut[index], degree: degree[index], cls: classes[index], inCycle: inTypeCycle.has(id) }));

  // Categories that ran: those of the health score, otherwise those that have findings.
  const ran = facts.health?.categories?.map((c) => c.category) ?? [...new Set(run.findings.map((f) => f.category))];
  const ranCode = ran.filter((c) => CodeCategories.has(c));
  const ranDesign = ran.filter((c) => !CodeCategories.has(c));
  const fileModule = new Map(facts.files.map((f) => [f.path, f.module]));
  const findingsOf = new Map<string, Finding[]>();
  for (const f of run.findings) {
    const module = f.module || fileModule.get(f.file) || "";
    const list = findingsOf.get(module) ?? [];
    list.push(f);
    findingsOf.set(module, list);
  }

  const unitsOf = new Map<string, UnitScore[]>();
  for (const u of units) {
    const list = unitsOf.get(graph.modules[u.index]) ?? [];
    list.push(u);
    unitsOf.set(graph.modules[u.index], list);
  }

  const modules: ModuleScore[] = [...facts.modules].sort((a, b) => ordinal(a.id, b.id)).map((m) => {
    const types = facts.types.filter((t) => t.module === m.id);
    const functions = facts.functions.filter((f) => f.module === m.id);
    const own = unitsOf.get(m.id) ?? [];
    const findings = findingsOf.get(m.id) ?? [];
    const I = metric(m, "instability");
    const A = metric(m, "abstractness");
    const D = metric(m, "distance");
    const cycled = inModuleCycle.has(m.id);
    const inCycles = own.filter((u) => u.inCycle).length;
    const maxBlast = own.length ? Math.max(...own.map((u) => u.blastRadius)) : null;
    const cbo = known(types, "cbo");
    const lcom = known(types, "lcom4");
    const wmc = known(types, "wmc");
    const dit = known(types, "dit");
    const weighted = (name: string, f: (v: number) => number) =>
      functions.map((e) => [metric(e, name) === null ? null : f(metric(e, name)!), Math.max(1, metric(e, "lines") ?? 1)] as [number | null, number]);
    const cyclomatic = known(functions, "cyclomatic");

    const components: Record<ComponentKey, Component> = {
      mainSequence: { key: "mainSequence", value: D === null ? null : 100 * (1 - D), inputs: { instability: I, abstractness: A, distance: D } },
      acyclic: { key: "acyclic", value: cycled ? 0 : own.length ? 100 * (1 - inCycles / own.length) : null, inputs: { moduleCycle: cycled ? 1 : 0, unitsInCycles: inCycles, units: own.length } },
      containment: { key: "containment", value: n > 1 && maxBlast !== null ? 100 * (1 - maxBlast / (n - 1)) : null, inputs: { maxBlastRadius: maxBlast, systemUnits: n } },
      coupling: { key: "coupling", value: mean(cbo.map((v) => soft(v, Half.cbo))), inputs: { meanCbo: mean(cbo), maxCbo: cbo.length ? Math.max(...cbo) : null, types: cbo.length } },
      cohesion: { key: "cohesion", value: mean(lcom.map((v) => 100 / Math.max(1, v))), inputs: { meanLcom4: mean(lcom), maxLcom4: lcom.length ? Math.max(...lcom) : null, types: lcom.length } },
      typeSize: { key: "typeSize", value: mean(wmc.map((v) => soft(v, Half.wmc))), inputs: { meanWmc: mean(wmc), maxWmc: wmc.length ? Math.max(...wmc) : null, types: wmc.length } },
      inheritance: { key: "inheritance", value: mean(dit.map((v) => soft(v, Half.dit))), inputs: { meanDit: mean(dit), maxDit: dit.length ? Math.max(...dit) : null, types: dit.length } },
      designFindings: findingsComponent("designFindings", findings.filter((f) => !CodeCategories.has(f.category)), ranDesign, m.loc),
      maintainabilityIndex: { key: "maintainabilityIndex", value: wmean(weighted("maintainabilityIndex", (v) => v)), inputs: { meanMi: wmean(weighted("maintainabilityIndex", (v) => v)), functions: known(functions, "maintainabilityIndex").length } },
      complexity: { key: "complexity", value: wmean(weighted("cyclomatic", (v) => soft(v, Half.cyclomatic))), inputs: { meanCyclomatic: mean(cyclomatic), maxCyclomatic: cyclomatic.length ? Math.max(...cyclomatic) : null, functions: cyclomatic.length } },
      codeFindings: findingsComponent("codeFindings", findings.filter((f) => CodeCategories.has(f.category)), ranCode, m.loc),
    };
    const scores: Score[] = ScoreKeys.map((key) => {
      const list = ScoreComponents[key].map((c) => components[c]);
      return { key, value: mean(list.map((c) => c.value)), components: list };
    });
    const zone: Zone | null = A === null || I === null || D === null || D < ZoneDistance ? null : A + I < 1 ? "pain" : A + I > 1 ? "uselessness" : null;
    return {
      id: m.id, name: m.name, loc: m.loc,
      ca: metric(m, "ca"), ce: metric(m, "ce"), instability: I, abstractness: A, distance: D, zone,
      inModuleCycle: cycled, units: own.length, types: types.length, functions: functions.length, findings: findings.length,
      scores, overall: mean(scores.map((s) => s.value)),
    };
  });

  const weight = (m: ModuleScore) => Math.max(1, m.loc);
  const system = {
    scores: ScoreKeys.map((key, i) => ({ key, value: wmean(modules.map((m) => [m.scores[i].value, weight(m)])) })),
    overall: wmean(modules.map((m) => [m.overall, weight(m)])),
    loc: modules.reduce((sum, m) => sum + m.loc, 0),
  };

  // The split of 100 − overall without remainder (spec/score.md, "Недобор").
  const scored = modules.filter((m) => m.overall !== null);
  const total = scored.reduce((sum, m) => sum + weight(m), 0);
  const losses: Loss[] = [];
  for (const m of scored) {
    const defined = m.scores.filter((s) => s.value !== null);
    for (const s of defined) {
      const parts = s.components.filter((c) => c.value !== null);
      for (const c of parts) {
        if (c.value! >= 100) continue;
        losses.push({ module: m.id, score: s.key, component: c.key, value: c.value!, lost: (weight(m) / total) * (100 - c.value!) / parts.length / defined.length, inputs: c.inputs });
      }
    }
  }
  const componentOrder = ScoreKeys.flatMap((k) => ScoreComponents[k]);
  losses.sort((a, b) => b.lost - a.lost || ordinal(a.module, b.module) || componentOrder.indexOf(a.component) - componentOrder.indexOf(b.component));

  const largestCycle = typeCycles.reduce((max, c) => Math.max(max, c.members.length), 0);
  let curves: Analysis["curves"] = null;
  let robustness: number | null = null;
  let critical: number | null = null;
  if (n) {
    const degreeCurve = percolationCurve(neighbours, removalOrder(n, degree));
    robustness = robustnessOf(degreeCurve);
    if (graph.edgeCount) {
      curves = { degree: degreeCurve, blast: percolationCurve(neighbours, removalOrder(n, blast, degree)) };
      critical = criticalShare(degreeCurve);
    }
  }
  const propagationCost = n > 1 ? blast.reduce((a, b) => a + b, 0) / (n * (n - 1)) : null;
  const propagation = propagationCost === null ? null : 100 * (1 - propagationCost);
  const core = n ? 100 * (1 - largestCycle / n) : null;
  // R near 0.5: the graph holds together however many of its best linked units go; near 0: it falls apart into independent parts.
  const decomposability = robustness === null ? null : 100 * (1 - 2 * robustness);
  const scalability: Scalability = {
    value: mean([propagation, core, decomposability]), propagation, core, decomposability, robustness, propagationCost, largestCycle, criticalShare: critical,
  };
  return { run, graph, units, modules, system, scalability, losses, curves };
}

/** Units whose change reaches at least a quarter of the system, most reaching first. */
export function hubs(analysis: Analysis): UnitScore[] {
  const n = analysis.graph.ids.length;
  if (n <= 1) return [];
  return analysis.units
    .filter((u) => u.blastRadius / (n - 1) >= HubShare)
    .sort((a, b) => b.blastRadius - a.blastRadius || a.index - b.index);
}
