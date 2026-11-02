import type { AnalysisRun, Cycle, Entity, Facts, Finding, Module, SkippedRule } from "./model";

export interface Group<T> { key: string; items: T[] }

function groupBy<T>(items: T[], key: (item: T) => string): Group<T>[] {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const name = key(item);
    const group = groups.get(name);
    if (group) group.push(item);
    else groups.set(name, [item]);
  }
  return [...groups].sort(([a], [b]) => compare(a, b)).map(([k, items]) => ({ key: k, items }));
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export interface ModuleFindings { module: string; total: number; categories: Group<Finding>[] }

/** The findings tree: module, then category. */
export function groupFindings(findings: Finding[]): ModuleFindings[] {
  return groupBy(findings, (f) => f.module).map((m) => ({ module: m.key, total: m.items.length, categories: groupBy(m.items, (f) => f.category) }));
}

export function formatMetrics(metrics: Record<string, number | null>, names?: string[]): string {
  const keys = names ?? Object.keys(metrics).sort();
  return keys.filter((k) => k in metrics).map((k) => `${k} ${metrics[k] ?? "n/a"}`).join(" · ");
}

/** The tooltip text: statement, heuristic label and explanation, so a finding never reads as a verdict. */
export function describeFinding(f: Finding): string {
  const measured = f.measured ? `\n\n${f.measured.metric} = ${f.measured.value}${f.measured.threshold === undefined ? "" : ` (reported from ${f.measured.threshold})`}` : "";
  return `${f.ruleId} ${f.ruleTitle}: ${f.message}\n\nHeuristic, ${f.confidence} confidence.\n\n${f.explanation}${measured}`;
}

export interface StyleSummary {
  /** All modules of the run. */
  total: number;
  /** Modules per paradigm; a module counts once for each paradigm active in it. */
  paradigms: { paradigm: string; modules: number }[];
  /** Modules per exact set of active paradigms; an empty set means no paradigm is active. */
  styles: { paradigms: string[]; modules: string[] }[];
  /** Modules of an analyzer of contract 1.0.0, which does not report active paradigms. */
  unreported: string[];
}

/** Counts modules by style. It reads what the analyzer reports and judges nothing: no style is better than another. */
export function summarizeStyles(facts: Facts): StyleSummary {
  const reported = facts.modules.filter((m) => m.activeParadigms);
  const counts = groupBy(reported.flatMap((m) => m.activeParadigms!), (p) => p);
  return {
    total: facts.modules.length,
    paradigms: counts.map((c) => ({ paradigm: c.key, modules: c.items.length })),
    styles: groupBy(reported, (m) => m.activeParadigms!.join(" + ")).map((s) => ({ paradigms: s.items[0].activeParadigms!, modules: s.items.map((m) => m.id) })),
    unreported: facts.modules.filter((m) => !m.activeParadigms).map((m) => m.id),
  };
}

export interface SkipReason { reason: string; message: string; rules: string[] }

/** Joins skipped rules that share a reason: analyzers repeat one message for each rule. */
export function groupSkipped(skipped: SkippedRule[]): SkipReason[] {
  return groupBy(skipped, (s) => `${s.reason}\u0000${s.message}`).map((g) => ({
    reason: g.items[0].reason,
    message: g.items[0].message,
    rules: [...new Set(g.items.map((s) => s.ruleId))].sort(compare),
  }));
}

/**
 * The group to open code in, next to the graph: the one before it, or after it when the graph comes first.
 * Undefined means the graph has the only group. Groups of a separate window are in the same list.
 */
export function neighbourGroup(groups: number[], graph: number | undefined): number | undefined {
  const sorted = [...groups].sort((a, b) => a - b);
  const index = graph === undefined ? -1 : sorted.indexOf(graph);
  if (index < 0) return undefined;
  return index > 0 ? sorted[index - 1] : sorted[1];
}

export interface Lens { line: number; text: string }

// All names below are metrics of spec/metrics.md, common to every language.
const FunctionMetrics = ["cyclomatic", "maxNesting", "lines", "parameterCount"];
const TypeMetrics = ["wmc", "cbo", "lcom4", "dit"];

function lensesOf(entities: Entity[], names: string[], file: string): Lens[] {
  return entities.filter((e) => e.location?.file === file).map((e) => ({ line: e.location!.startLine, text: formatMetrics(e.metrics, names) })).filter((l) => l.text.length > 0);
}

/** CodeLens data of one file, with paths relative to the analysis root. */
export function lensesFor(facts: Facts, file: string): Lens[] {
  return [...lensesOf(facts.types, TypeMetrics, file), ...lensesOf(facts.functions, FunctionMetrics, file)].sort((a, b) => a.line - b.line);
}

export type NodeShape = "circle" | "triangle" | "diamond" | "square" | "rounded" | "hexagon" | "pentagon" | "dot";
export interface GraphNode { id: string; label: string; language: string; cycle: boolean; size: number; layer: number; role: "module" | "type"; shape: NodeShape; kind?: string; file?: string; line?: number }
/** One edge per kind of dependency between two nodes. A pair names the two modules this edge opens, when it joins modules. */
export interface GraphEdge { from: string; to: string; kind: string; weight: number; cycle: boolean; pair?: [string, string] }
/** Groups are set for the two modules of a pair: the layer of a node then says which module it is from. */
export interface Graph { nodes: GraphNode[]; edges: GraphEdge[]; groups?: string[] }
export type GraphLevel = "module" | "type";

// Keys are the open set of kinds in the facts contract; anything else gets the pentagon.
const KindShapes: Record<string, NodeShape> = { class: "circle", struct: "square", record: "rounded", enum: "hexagon", interface: "diamond", protocol: "diamond", trait: "diamond" };

/** The drawn form of a type. An abstract class differs from a class, an interface is abstract by nature. */
export function shapeOf(kind: string | undefined, isAbstract: boolean | undefined): NodeShape {
  const shape = (kind && KindShapes[kind]) || "pentagon";
  return isAbstract && shape !== "diamond" ? "triangle" : shape;
}

function typeKindLabel(type: Entity): string {
  const kind = type.kind ?? "type";
  return type.isAbstract && shapeOf(type.kind, true) === "triangle" ? `abstract ${kind}` : kind;
}

function cycleMembers(cycles: Cycle[] | undefined, level: GraphLevel): Set<string>[] {
  return (cycles ?? []).filter((c) => c.level === level).map((c) => new Set(c.members));
}

/**
 * Longest dependency path from each node: 0 depends on nothing shown, members of a cycle share a layer.
 * Tarjan's algorithm finishes a component after everything it depends on, so one pass is enough.
 */
function dependencyLayers(ids: string[], edges: GraphEdge[]): Map<string, number> {
  const targets = new Map<string, string[]>(ids.map((id) => [id, []]));
  for (const edge of edges) targets.get(edge.from)?.push(edge.to);
  const order = new Map<string, number>();
  const low = new Map<string, number>();
  const stack: string[] = [];
  const open = new Set<string>();
  const layers = new Map<string, number>();

  const visit = (id: string): void => {
    order.set(id, order.size);
    low.set(id, order.get(id)!);
    stack.push(id);
    open.add(id);
    for (const next of targets.get(id)!) {
      if (!order.has(next)) {
        visit(next);
        low.set(id, Math.min(low.get(id)!, low.get(next)!));
      } else if (open.has(next)) {
        low.set(id, Math.min(low.get(id)!, order.get(next)!));
      }
    }
    if (low.get(id) !== order.get(id)) return;
    const members = stack.splice(stack.lastIndexOf(id));
    const inside = new Set(members);
    let layer = 0;
    for (const member of members) {
      open.delete(member);
      for (const next of targets.get(member)!) {
        if (!inside.has(next)) layer = Math.max(layer, layers.get(next)! + 1);
      }
    }
    for (const member of members) layers.set(member, layer);
  };

  for (const id of ids) if (!order.has(id)) visit(id);
  return layers;
}

class EdgeSet {
  private readonly edges = new Map<string, GraphEdge>();

  add(from: string, to: string, kind: string, count: number | undefined, cycle: boolean, pair?: [string, string]): void {
    const key = `${from}\u0000${to}\u0000${kind}`;
    const edge = this.edges.get(key);
    if (edge) edge.weight += count ?? 1;
    else this.edges.set(key, { from, to, kind, weight: count ?? 1, cycle, pair });
  }

  list(): GraphEdge[] {
    return [...this.edges.values()];
  }
}

function withLayers(nodes: GraphNode[], edges: GraphEdge[]): Graph {
  const layers = dependencyLayers(nodes.map((n) => n.id), edges);
  for (const node of nodes) node.layer = layers.get(node.id)!;
  return { nodes, edges };
}

function moduleNode(m: Module, language: string, cycle: boolean): GraphNode {
  return { id: m.id, label: m.name, language, cycle, size: m.loc, layer: 0, role: "module", shape: "circle" };
}

/** The graph of modules from facts; dependencies on external targets stay out, as in spec/metrics.md. */
export function buildGraph(runs: AnalysisRun[]): Graph {
  const nodes: GraphNode[] = [];
  const edges = new EdgeSet();
  for (const { language, facts } of runs) {
    const cycles = cycleMembers(facts.cycles, "module");
    const known = new Set(facts.modules.map((m) => m.id));
    for (const m of facts.modules) nodes.push(moduleNode(m, language, cycles.some((c) => c.has(m.id))));
    const owners = new Map([...facts.types, ...facts.functions].map((e) => [e.id, e.module]));
    const unit = (id: string) => (known.has(id) ? id : owners.get(id));
    for (const dependency of facts.dependencies) {
      if (dependency.external) continue;
      const from = unit(dependency.from);
      const to = unit(dependency.to);
      if (!from || !to || from === to) continue;
      edges.add(from, to, dependency.kind, dependency.count, cycles.some((c) => c.has(from) && c.has(to)), [from, to]);
    }
  }
  return withLayers(nodes, edges.list());
}

/**
 * The types of one module with a line to each other module they touch or, with a peer, only the links between the types of the two.
 * Members fold into their type; a free function has no type to fold into and is drawn on its own when it has links.
 * Undefined means the module is gone from the facts.
 */
export function buildFocus(runs: AnalysisRun[], module: string, peer?: string): Graph | undefined {
  const run = runs.find((r) => r.facts.modules.some((m) => m.id === module));
  if (!run || (peer && !run.facts.modules.some((m) => m.id === peer))) return undefined;
  const { language, facts } = run;
  const typeCycles = cycleMembers(facts.cycles, "type");
  const moduleCycles = cycleMembers(facts.cycles, "module");
  const inTypeCycle = (id: string) => typeCycles.some((c) => c.has(id));
  const linked = (a: string, b: string) => typeCycles.some((c) => c.has(a) && c.has(b));
  const modulesLinked = (a: string, b: string) => moduleCycles.some((c) => c.has(a) && c.has(b));
  const unitNode = new Map<string, () => GraphNode>();
  const unitModule = new Map<string, string>();
  const unitOf = new Map<string, string>();

  for (const t of facts.types) {
    unitOf.set(t.id, t.id);
    unitModule.set(t.id, t.module);
    unitNode.set(t.id, () => ({ id: t.id, label: t.name, language, cycle: inTypeCycle(t.id), size: t.metrics.lines ?? 1, layer: 0, role: "type", shape: shapeOf(t.kind, t.isAbstract), kind: typeKindLabel(t), file: t.location?.file, line: t.location?.startLine }));
  }
  for (const f of facts.functions) {
    if (f.type) {
      unitOf.set(f.id, f.type);
      continue;
    }
    unitOf.set(f.id, f.id);
    unitModule.set(f.id, f.module);
    unitNode.set(f.id, () => ({ id: f.id, label: f.name, language, cycle: false, size: 1, layer: 0, role: "type", shape: "dot", kind: "function", file: f.location?.file, line: f.location?.startLine }));
  }

  const edges = new EdgeSet();
  const shown = new Set<string>(peer ? [] : facts.types.filter((t) => t.module === module).map((t) => t.id));
  const peers = new Set<string>();
  for (const dependency of facts.dependencies) {
    if (dependency.external) continue;
    const from = unitOf.get(dependency.from);
    const to = unitOf.get(dependency.to);
    if (!from || !to || from === to) continue;
    const a = unitModule.get(from);
    const b = unitModule.get(to);
    if (!a || !b) continue;
    if (peer) {
      if ((a !== module || b !== peer) && (a !== peer || b !== module)) continue;
      edges.add(from, to, dependency.kind, dependency.count, linked(from, to));
      shown.add(from).add(to);
    } else if (a === module && b === module) {
      edges.add(from, to, dependency.kind, dependency.count, linked(from, to));
      shown.add(from).add(to);
    } else if (a === module) {
      edges.add(from, b, dependency.kind, dependency.count, modulesLinked(a, b), [module, b]);
      shown.add(from);
      peers.add(b);
    } else if (b === module) {
      edges.add(a, to, dependency.kind, dependency.count, modulesLinked(a, b), [module, a]);
      shown.add(to);
      peers.add(a);
    }
  }

  const nodes = [...shown].sort(compare).map((id) => unitNode.get(id)!());
  if (peer) {
    for (const node of nodes) node.layer = unitModule.get(node.id) === module ? 0 : 1;
    return { nodes, edges: edges.list(), groups: [module, peer] };
  }
  for (const m of facts.modules) if (peers.has(m.id)) nodes.push(moduleNode(m, language, modulesLinked(module, m.id)));
  return withLayers(nodes, edges.list());
}
