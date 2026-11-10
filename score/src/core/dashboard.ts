// The data of the score page: plain JSON, built from an Analysis, with no words — the page takes its texts from the
// strings the extension sends (D-052). The system view and the view of one module.
import type { Analysis, Inputs, Loss, ModuleScore, Scalability, ScoreKey } from "./score";
import { ConfidenceFactors, SeverityPenalties, hubs } from "./score";
import type { VisibilityClass } from "./graph";
import { ordinal } from "./model";

export interface ModuleRow {
  id: string; name: string; loc: number;
  ca: number | null; ce: number | null; instability: number | null; abstractness: number | null; distance: number | null;
  zone: ModuleScore["zone"]; inModuleCycle: boolean; units: number; findings: number;
  scores: Record<ScoreKey, number | null>; overall: number | null;
}

export interface UnitPoint { id: string; name: string; module: string; blastRadius: number; fanOut: number; cls: VisibilityClass; file?: string; line?: number }
export interface Hub extends UnitPoint { share: number; inCycle: boolean }
export interface Problem extends Loss { name: string }
export interface Bucket { from: number; to: number; count: number }

export interface SystemView {
  view: "system";
  language: string;
  units: number;
  edges: number;
  loc: number;
  overall: number | null;
  scores: { key: ScoreKey; value: number | null }[];
  scalability: Scalability;
  classes: Record<VisibilityClass, number>;
  modules: ModuleRow[];
  points: UnitPoint[];
  /** Units left off the visibility plot, which keeps the most visible. */
  pointsOmitted: number;
  percolation: { degree: [number, number][]; blast: [number, number][]; critical: number | null } | null;
  histogram: Bucket[];
  problems: Problem[];
  hubs: Hub[];
  cycles: { modules: number; types: number; largest: number };
}

export interface UnitRow {
  id: string; name: string; isType: boolean; blastRadius: number; fanOut: number; cls: VisibilityClass; inCycle: boolean;
  metrics: Inputs; file?: string; line?: number;
}
export interface FunctionRow { id: string; name: string; cyclomatic: number | null; maintainabilityIndex: number | null; lines: number | null; file?: string; line?: number }
export interface Link { module: string; name: string; count: number }

export interface ModuleView {
  view: "module";
  language: string;
  module: ModuleRow & { components: ModuleScore["scores"] };
  /** Every module, for the module's place on Martin's diagram. */
  modules: ModuleRow[];
  systemOverall: number | null;
  units: UnitRow[];
  functions: FunctionRow[];
  categories: { category: string; count: number; penalty: number }[];
  problems: Problem[];
  incoming: Link[];
  outgoing: Link[];
  selected?: string;
}

const MaxPoints = 3000;
const MaxProblems = 30;
/** Losses below this many points round to nothing on the page and are not listed. */
const MinLost = 0.01;
const MaxHubs = 30;
const MaxFunctions = 15;
const MaxCurvePoints = 200;
/** Edges of the blast radius distribution, as shares of the rest of the system. */
const BucketEdges = [0, 0.01, 0.05, 0.1, 0.25, 0.5, 1];

function row(m: ModuleScore): ModuleRow {
  return {
    id: m.id, name: m.name, loc: m.loc, ca: m.ca, ce: m.ce, instability: m.instability, abstractness: m.abstractness, distance: m.distance,
    zone: m.zone, inModuleCycle: m.inModuleCycle, units: m.units, findings: m.findings,
    scores: Object.fromEntries(m.scores.map((s) => [s.key, s.value])) as Record<ScoreKey, number | null>, overall: m.overall,
  };
}

function curvePoints(curve: number[]): [number, number][] {
  const n = curve.length - 1;
  const step = Math.max(1, Math.ceil(n / MaxCurvePoints));
  const points: [number, number][] = [];
  for (let q = 0; q <= n; q += step) points.push([q / n, curve[q]]);
  if (points[points.length - 1][0] !== 1) points.push([1, curve[n]]);
  return points;
}

function point(a: Analysis, index: number): UnitPoint {
  const g = a.graph;
  const u = a.units[index];
  return { id: g.ids[index], name: g.names[index], module: g.modules[index], blastRadius: u.blastRadius, fanOut: u.fanOut, cls: u.cls, file: g.files[index], line: g.lines[index] };
}

function problem(a: Analysis, loss: Loss): Problem {
  return { ...loss, name: a.modules.find((m) => m.id === loss.module)?.name ?? loss.module };
}

export function systemView(a: Analysis): SystemView {
  const n = a.graph.ids.length;
  const classes: Record<VisibilityClass, number> = { core: 0, shared: 0, control: 0, periphery: 0 };
  for (const u of a.units) classes[u.cls]++;
  const visible = [...a.units].sort((x, y) => y.blastRadius + y.fanOut - (x.blastRadius + x.fanOut) || x.index - y.index);
  const shown = visible.slice(0, MaxPoints).sort((x, y) => x.index - y.index);
  // The first bucket holds the units whose change reaches nothing; the others are (from, to].
  const histogram: Bucket[] = [{ from: 0, to: 0, count: 0 }, ...BucketEdges.slice(1).map((to, i) => ({ from: BucketEdges[i], to, count: 0 }))];
  if (n > 1) {
    for (const u of a.units) {
      const share = u.blastRadius / (n - 1);
      histogram[share === 0 ? 0 : histogram.findIndex((b, i) => i > 0 && share <= b.to)].count++;
    }
  }
  const facts = a.run.facts;
  return {
    view: "system",
    language: a.run.language,
    units: n,
    edges: a.graph.edgeCount,
    loc: a.system.loc,
    overall: a.system.overall,
    scores: a.system.scores,
    scalability: a.scalability,
    classes,
    modules: a.modules.map(row),
    points: shown.map((u) => point(a, u.index)),
    pointsOmitted: Math.max(0, n - MaxPoints),
    percolation: a.curves && { degree: curvePoints(a.curves.degree), blast: curvePoints(a.curves.blast), critical: a.scalability.criticalShare },
    histogram,
    problems: a.losses.filter((l) => l.lost >= MinLost).slice(0, MaxProblems).map((l) => problem(a, l)),
    hubs: hubs(a).slice(0, MaxHubs).map((u) => ({ ...point(a, u.index), share: u.blastRadius / (n - 1), inCycle: u.inCycle })),
    cycles: {
      modules: (facts.cycles ?? []).filter((c) => c.level === "module").length,
      types: (facts.cycles ?? []).filter((c) => c.level === "type").length,
      largest: a.scalability.largestCycle,
    },
  };
}

/** The module a double click names: a module itself, or the module of a unit or of a member folded into it. */
export function moduleOfTarget(a: Analysis, id: string): { module: string; unit?: string } | undefined {
  if (a.modules.some((m) => m.id === id)) return { module: id };
  const facts = a.run.facts;
  const entity = [...facts.types, ...facts.functions].find((e) => e.id === id);
  if (!entity) return undefined;
  const unit = entity.type && facts.types.some((t) => t.id === entity.type) ? entity.type : entity.id;
  return { module: entity.module, unit };
}

export function moduleView(a: Analysis, moduleId: string, selected?: string): ModuleView | undefined {
  const m = a.modules.find((x) => x.id === moduleId);
  if (!m) return undefined;
  const facts = a.run.facts;
  const g = a.graph;
  const byId = new Map([...facts.types, ...facts.functions].map((e) => [e.id, e]));
  const value = (id: string, name: string) => {
    const v = byId.get(id)?.metrics[name];
    return typeof v === "number" ? v : null;
  };
  const units: UnitRow[] = a.units
    .filter((u) => g.modules[u.index] === moduleId)
    .sort((x, y) => y.blastRadius - x.blastRadius || x.index - y.index)
    .map((u) => {
      const id = g.ids[u.index];
      const metrics: Inputs = g.isType[u.index]
        ? { cbo: value(id, "cbo"), lcom4: value(id, "lcom4"), wmc: value(id, "wmc"), dit: value(id, "dit") }
        : { cyclomatic: value(id, "cyclomatic"), maintainabilityIndex: value(id, "maintainabilityIndex") };
      return { id, name: g.names[u.index], isType: g.isType[u.index], blastRadius: u.blastRadius, fanOut: u.fanOut, cls: u.cls, inCycle: u.inCycle, metrics, file: g.files[u.index], line: g.lines[u.index] };
    });
  const functions: FunctionRow[] = facts.functions
    .filter((f) => f.module === moduleId)
    .map((f) => ({ id: f.id, name: f.type ? `${byId.get(f.type)?.name ?? ""}.${f.name}` : f.name, cyclomatic: value(f.id, "cyclomatic"), maintainabilityIndex: value(f.id, "maintainabilityIndex"), lines: value(f.id, "lines"), file: f.location?.file, line: f.location?.startLine }))
    .sort((x, y) => (y.cyclomatic ?? -1) - (x.cyclomatic ?? -1) || ordinal(x.id, y.id))
    .slice(0, MaxFunctions);

  const fileModule = new Map(facts.files.map((f) => [f.path, f.module]));
  const categories = new Map<string, { category: string; count: number; penalty: number }>();
  for (const f of a.run.findings) {
    if ((f.module || fileModule.get(f.file)) !== moduleId) continue;
    const c = categories.get(f.category) ?? { category: f.category, count: 0, penalty: 0 };
    c.count++;
    c.penalty += (SeverityPenalties[f.severity] ?? 0) * (ConfidenceFactors[f.confidence] ?? 0);
    categories.set(f.category, c);
  }

  const incoming = new Map<string, number>();
  const outgoing = new Map<string, number>();
  for (const [from, targets] of g.out.entries()) {
    for (const to of targets) {
      const a1 = g.modules[from];
      const b1 = g.modules[to];
      if (a1 === b1) continue;
      if (b1 === moduleId) incoming.set(a1, (incoming.get(a1) ?? 0) + 1);
      if (a1 === moduleId) outgoing.set(b1, (outgoing.get(b1) ?? 0) + 1);
    }
  }
  const names = new Map(a.modules.map((x) => [x.id, x.name]));
  const links = (map: Map<string, number>): Link[] =>
    [...map].map(([module, count]) => ({ module, name: names.get(module) ?? module, count })).sort((x, y) => y.count - x.count || ordinal(x.module, y.module));

  return {
    view: "module",
    language: a.run.language,
    module: { ...row(m), components: m.scores },
    modules: a.modules.map(row),
    systemOverall: a.system.overall,
    units,
    functions,
    categories: [...categories.values()].sort((x, y) => y.penalty - x.penalty || y.count - x.count || ordinal(x.category, y.category)),
    problems: a.losses.filter((l) => l.module === moduleId && l.lost >= MinLost).map((l) => problem(a, l)),
    incoming: links(incoming),
    outgoing: links(outgoing),
    selected,
  };
}
