import type { AnalysisRun, Cycle, Entity, Facts, Finding } from "./model";

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

export interface GraphNode { id: string; label: string; language: string; cycle: boolean; size: number; layer: number; file?: string; line?: number }
export interface GraphEdge { from: string; to: string; weight: number; cycle: boolean }
export interface Graph { nodes: GraphNode[]; edges: GraphEdge[] }
export type GraphLevel = "module" | "type";

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

/** Builds the graph of one level from facts; dependencies on external targets stay out, as in spec/metrics.md. */
export function buildGraph(runs: AnalysisRun[], level: GraphLevel): Graph {
  const nodes: GraphNode[] = [];
  const weights = new Map<string, GraphEdge>();
  for (const { language, facts } of runs) {
    const cycles = cycleMembers(facts.cycles, level);
    const inCycle = (id: string) => cycles.some((c) => c.has(id));
    const moduleOf = new Map(facts.types.map((t) => [t.id, t.module]));
    const functionOwner = new Map(facts.functions.map((f) => [f.id, f.module]));
    const known = new Set(level === "module" ? facts.modules.map((m) => m.id) : facts.types.map((t) => t.id));

    if (level === "module") {
      for (const m of facts.modules) nodes.push({ id: m.id, label: m.name, language, cycle: inCycle(m.id), size: m.loc, layer: 0, file: m.files[0] });
    } else {
      for (const t of facts.types) nodes.push({ id: t.id, label: t.name, language, cycle: inCycle(t.id), size: t.metrics.lines ?? 1, layer: 0, file: t.location?.file, line: t.location?.startLine });
    }

    const unit = (id: string) => (level === "module" ? moduleOf.get(id) ?? functionOwner.get(id) : id);
    for (const dependency of facts.dependencies) {
      if (dependency.external) continue;
      const from = unit(dependency.from);
      const to = unit(dependency.to);
      if (!from || !to || from === to || !known.has(from) || !known.has(to)) continue;
      const key = `${from}\u0000${to}`;
      const edge = weights.get(key);
      if (edge) edge.weight += dependency.count ?? 1;
      else weights.set(key, { from, to, weight: dependency.count ?? 1, cycle: cycles.some((c) => c.has(from) && c.has(to)) });
    }
  }
  const edges = [...weights.values()];
  const layers = dependencyLayers(nodes.map((n) => n.id), edges);
  for (const node of nodes) node.layer = layers.get(node.id)!;
  return { nodes, edges };
}
