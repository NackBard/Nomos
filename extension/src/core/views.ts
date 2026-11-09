import { english } from "./l10n";
import type { UmlClass } from "./uml";
import type { Translate } from "./l10n";
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

/** Metric names are the ids of spec/metrics.md in every language, like names in code. */
export function formatMetrics(metrics: Record<string, number | null>, names?: string[], t: Translate = english): string {
  const keys = names ?? Object.keys(metrics).sort();
  return keys.filter((k) => k in metrics).map((k) => `${k} ${metrics[k] ?? t("n/a")}`).join(" · ");
}

/** "low", "medium" or "high" confidence in the interface language. */
export function confidenceText(confidence: string, t: Translate = english): string {
  const names: Record<string, string> = { low: t("low"), medium: t("medium"), high: t("high") };
  return names[confidence] ?? confidence;
}

/** The tooltip text: statement, heuristic label and explanation, so a finding never reads as a verdict. */
export function describeFinding(f: Finding, t: Translate = english): string {
  const measured = !f.measured ? "" : "\n\n" + (f.measured.threshold === undefined
    ? `${f.measured.metric} = ${f.measured.value}`
    : t("{0} = {1} (reported from {2})", f.measured.metric, f.measured.value, f.measured.threshold));
  return `${f.ruleId} ${f.ruleTitle}: ${f.message}\n\n${t("Heuristic, {0} confidence.", confidenceText(f.confidence, t))}\n\n${f.explanation}${measured}`;
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
/** A type node drawn as a UML class carries the class (core/uml.ts). */
export interface GraphNode { id: string; label: string; language: string; cycle: boolean; size: number; layer: number; role: "module" | "type" | "folder"; shape: NodeShape; kind?: string; file?: string; line?: number; uml?: UmlClass; folder?: string; members?: number }
/**
 * One edge per kind of dependency between two nodes. A pair names the two modules this edge opens, when it joins modules.
 * Via names the types behind a folded module at the far end of the edge, in order: what is called, used or inherited there, or who does it.
 */
export interface GraphEdge { from: string; to: string; kind: string; weight: number; cycle: boolean; pair?: [string, string]; via?: string[]; label?: string; many?: boolean }
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

/** Kind of a type as the graph names it; kinds outside the facts contract show as they are. */
function typeKindLabel(type: Entity, t: Translate): string {
  const kind = type.kind ?? "type";
  if (type.isAbstract && shapeOf(type.kind, true) === "triangle") {
    const abstract: Record<string, string> = { class: t("abstract class"), record: t("abstract record"), struct: t("abstract struct") };
    return abstract[kind] ?? t("abstract {0}", kind);
  }
  const names: Record<string, string> = {
    class: t("class"), struct: t("struct"), record: t("record"), enum: t("enum"), interface: t("interface"),
    protocol: t("protocol"), trait: t("trait"), type: t("type"), alias: t("alias"), delegate: t("delegate"),
  };
  return names[kind] ?? kind;
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
  private readonly via = new Map<GraphEdge, Set<string>>();

  add(from: string, to: string, kind: string, count: number | undefined, cycle: boolean, pair?: [string, string], via?: string): void {
    const key = `${from}\u0000${to}\u0000${kind}`;
    let edge = this.edges.get(key);
    if (edge) {
      edge.weight += count ?? 1;
      edge.cycle ||= cycle;
    } else this.edges.set(key, (edge = { from, to, kind, weight: count ?? 1, cycle, pair }));
    if (via !== undefined) {
      const names = this.via.get(edge) ?? new Set<string>();
      this.via.set(edge, names.add(via));
    }
  }

  list(): GraphEdge[] {
    for (const [edge, names] of this.via) edge.via = [...names].sort(compare);
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

/** How the compact graph folds modules into their folders (D-064). Without it every module is drawn. */
export interface Folding {
  /** Folders the person opened; opening a folder opens the folders above it. */
  opened: readonly string[];
  /** The compact graph opens folders while it shows at most this many nodes: a sensitivity of the view, not a verdict. */
  limit?: number;
}

export const CompactNodes = 30;

/** The folder of a module: the longest folder all its files share, "" for the root. Paths in facts use "/". */
export function moduleFolder(files: readonly string[]): string {
  if (!files.length) return "";
  let common = files[0].split("/").slice(0, -1);
  for (const file of files.slice(1)) {
    const parts = file.split("/").slice(0, -1);
    let same = 0;
    while (same < common.length && same < parts.length && common[same] === parts[same]) same++;
    common = common.slice(0, same);
  }
  return common.join("/");
}

function prefixes(folder: string): string[] {
  const parts = folder ? folder.split("/") : [];
  return parts.map((_, i) => parts.slice(0, i + 1).join("/"));
}

/**
 * The node each module is drawn as: itself, or `<folder>/` for the folder that holds it. A folder folds only when it holds
 * two modules or more; a chain of folders that hold nothing but one folder folds as its deepest link, so the name says where
 * the modules are. Folders open by the person's choice and then, the shallowest first, while the graph stays within the limit.
 */
function foldModules(modules: { id: string; folder: string }[], folding: Folding): Map<string, string> {
  const limit = folding.limit ?? CompactNodes;
  const count = new Map<string, number>();
  const direct = new Map<string, number>();
  const children = new Map<string, Set<string>>();
  for (const m of modules) {
    const chain = prefixes(m.folder);
    chain.forEach((p, i) => {
      count.set(p, (count.get(p) ?? 0) + 1);
      if (i > 0) children.set(chain[i - 1], (children.get(chain[i - 1]) ?? new Set<string>()).add(p));
    });
    if (m.folder) direct.set(m.folder, (direct.get(m.folder) ?? 0) + 1);
  }
  const deepest = (folder: string): string => {
    let at = folder;
    for (;;) {
      const below = children.get(at);
      if ((direct.get(at) ?? 0) > 0 || !below || below.size !== 1) return at;
      at = [...below][0];
    }
  };
  const open = new Set<string>();
  const openWith = (set: Set<string>, folder: string) => {
    for (const p of prefixes(folder)) set.add(p);
  };
  for (const folder of folding.opened) openWith(open, folder);
  const unitsWith = (opened: Set<string>) => {
    const units = new Map<string, string>();
    for (const m of modules) {
      const closed = prefixes(m.folder).find((p) => !opened.has(p) && (count.get(p) ?? 0) >= 2);
      units.set(m.id, closed === undefined ? m.id : `${deepest(closed)}/`);
    }
    return units;
  };
  const size = (units: Map<string, string>) => new Set(units.values()).size;
  const depth = (unit: string) => unit.split("/").length;
  let units = unitsWith(open);
  for (let grown = true; grown; ) {
    grown = false;
    const folded = [...new Set([...units].filter(([id, unit]) => id !== unit).map(([, unit]) => unit))];
    folded.sort((a, b) => depth(a) - depth(b) || compare(a, b));
    for (const unit of folded) {
      const trial = new Set(open);
      openWith(trial, unit.slice(0, -1));
      const next = unitsWith(trial);
      if (size(next) > limit) continue;
      openWith(open, unit.slice(0, -1));
      units = next;
      grown = true;
      break;
    }
  }
  return units;
}

/**
 * The graph of modules from facts; dependencies on external targets stay out, as in spec/metrics.md. With folding the
 * modules of a folded folder are one node and their links add up; only a line between two modules opens the types of a pair.
 */
export function buildGraph(runs: AnalysisRun[], folding?: Folding, translate: Translate = english): Graph {
  const modules: { id: string; folder: string; node: GraphNode }[] = [];
  const links: { from: string; to: string; kind: string; count?: number; cycle: boolean }[] = [];
  for (const { language, facts } of runs) {
    const cycles = cycleMembers(facts.cycles, "module");
    const known = new Set(facts.modules.map((m) => m.id));
    for (const m of facts.modules) modules.push({ id: m.id, folder: moduleFolder(m.files), node: moduleNode(m, language, cycles.some((c) => c.has(m.id))) });
    const owners = new Map([...facts.types, ...facts.functions].map((e) => [e.id, e.module]));
    const unit = (id: string) => (known.has(id) ? id : owners.get(id));
    for (const dependency of facts.dependencies) {
      if (dependency.external) continue;
      const from = unit(dependency.from);
      const to = unit(dependency.to);
      if (!from || !to || from === to) continue;
      links.push({ from, to, kind: dependency.kind, count: dependency.count, cycle: cycles.some((c) => c.has(from) && c.has(to)) });
    }
  }
  const units = folding ? foldModules(modules, folding) : new Map(modules.map((m) => [m.id, m.id]));
  const nodes = new Map<string, GraphNode>();
  for (const { id, node } of modules) {
    const unit = units.get(id)!;
    if (unit === id) {
      nodes.set(id, node);
      continue;
    }
    const folder = nodes.get(unit);
    if (folder) {
      folder.size += node.size;
      folder.cycle ||= node.cycle;
      folder.members! += 1;
      continue;
    }
    const path = unit.slice(0, -1);
    nodes.set(unit, { id: unit, label: path.slice(path.lastIndexOf("/") + 1), language: node.language, cycle: node.cycle, size: node.size, layer: 0, role: "folder", shape: "rounded", kind: translate("folder"), folder: path, members: 1 });
  }
  for (const node of nodes.values()) if (node.role === "folder") node.label = `${node.label}/ (${node.members})`;
  const edges = new EdgeSet();
  for (const link of links) {
    const from = units.get(link.from)!;
    const to = units.get(link.to)!;
    if (from === to) continue;
    edges.add(from, to, link.kind, link.count, link.cycle, from === link.from && to === link.to ? [from, to] : undefined);
  }
  return withLayers([...nodes.values()], edges.list());
}

/**
 * The types of one module with a line to each other module they touch or, with a peer, only the links between the types of the two.
 * Members fold into their type; a free function has no type to fold into and is drawn on its own when it has links.
 * Undefined means the module is gone from the facts.
 */
export function buildFocus(runs: AnalysisRun[], module: string, peer?: string, translate: Translate = english): Graph | undefined {
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
    unitNode.set(t.id, () => ({ id: t.id, label: t.name, language, cycle: inTypeCycle(t.id), size: t.metrics.lines ?? 1, layer: 0, role: "type", shape: shapeOf(t.kind, t.isAbstract), kind: typeKindLabel(t, translate), file: t.location?.file, line: t.location?.startLine }));
  }
  for (const f of facts.functions) {
    if (f.type) {
      unitOf.set(f.id, f.type);
      continue;
    }
    unitOf.set(f.id, f.id);
    unitModule.set(f.id, f.module);
    unitNode.set(f.id, () => ({ id: f.id, label: f.name, language, cycle: false, size: 1, layer: 0, role: "type", shape: "dot", kind: translate("function"), file: f.location?.file, line: f.location?.startLine }));
  }

  const names = new Map([...facts.types, ...facts.functions].map((e) => [e.id, e.name]));
  const nameOf = (unit: string) => names.get(unit) ?? unit;
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
      edges.add(from, b, dependency.kind, dependency.count, modulesLinked(a, b), [module, b], nameOf(to));
      shown.add(from);
      peers.add(b);
    } else if (b === module) {
      edges.add(a, to, dependency.kind, dependency.count, modulesLinked(a, b), [module, a], nameOf(from));
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
