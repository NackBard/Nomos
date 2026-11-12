// The class diagram of spec/structure.md, built from facts only: the model the graph page draws and its PlantUML and
// Mermaid text. No VS Code API and no language-specific logic: everything comes from the facts contract.
import type { AnalysisRun, Facts, FunctionEntity, Member, TypeEntity } from "./model";
import { buildFocus } from "./views";
import type { Graph, GraphEdge, GraphNode } from "./views";

export type UmlRelationKind = "embed" | "generalization" | "realization" | "association" | "dependency";

/** One line of an attribute or operation compartment; `text` is how the page shows it. */
export interface UmlMember {
  text: string;
  sign: string;
  name: string;
  /** Attribute type, or the result of an operation. */
  type?: string;
  /** Parameters of an operation, as written in its text. */
  parameters?: string;
  operation: boolean;
  isStatic: boolean;
  isAbstract: boolean;
  stereotype?: string;
  /** Where an operation is declared, relative to the analyzer root: a click on its line opens it. Attributes have none. */
  file?: string;
  line?: number;
}

export interface UmlClass {
  id: string;
  /** Name with type parameters: Box<T>. */
  name: string;
  stereotype?: string;
  isAbstract: boolean;
  isInterface: boolean;
  isEnum: boolean;
  attributes: UmlMember[];
  operations: UmlMember[];
  /** A module's utility (D-066): the free functions folded into it. */
  functions?: string[];
}

export interface UmlRelation { from: string; to: string; kind: UmlRelationKind; label?: string; many?: boolean }

export interface ClassDiagram { title: string; classes: UmlClass[]; relations: UmlRelation[] }

const SIGNS: Record<string, string> = { public: "+", private: "-", protected: "#", internal: "~" };
const INTERFACES = new Set(["interface", "protocol", "trait"]);
const RANK: Record<UmlRelationKind, number> = { embed: 0, generalization: 1, realization: 2, association: 3, dependency: 4 };

const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

const isInterface = (type: TypeEntity | undefined) => INTERFACES.has(type?.kind ?? "");

function attribute(member: Member): UmlMember {
  const sign = SIGNS[member.visibility ?? ""] ?? "";
  if (member.kind === "literal") return { text: member.name, sign: "", name: member.name, operation: false, isStatic: false, isAbstract: false };
  if (member.isEmbedded) {
    // Go: an embedded field is its type; its name repeats the type name.
    const name = member.typeName ?? member.name;
    return { text: `${sign}«embed» ${name}`, sign, name, operation: false, isStatic: false, isAbstract: false, stereotype: "embed" };
  }
  const stereotype = member.kind === "event" ? "event" : undefined;
  const type = member.typeName;
  const text = `${sign}${stereotype ? `«${stereotype}» ` : ""}${member.name}${type ? `: ${type}` : ""}`;
  return { text, sign, name: member.name, type, operation: false, isStatic: member.isStatic === true, isAbstract: false, stereotype };
}

function operation(f: FunctionEntity): UmlMember {
  const sign = SIGNS[f.visibility ?? ""] ?? "";
  const parameters = (f.parameters ?? []).map((p) => (p.name && p.typeName ? `${p.name}: ${p.typeName}` : p.typeName ?? p.name)).join(", ");
  const type = f.kind === "constructor" ? undefined : f.returnTypeName;
  return {
    text: `${sign}${f.name}(${parameters})${type ? `: ${type}` : ""}`,
    sign, name: f.name, type, parameters, operation: true, isStatic: f.isStatic === true, isAbstract: f.isAbstract === true,
    ...(f.location ? { file: f.location.file, line: f.location.startLine } : {}),
  };
}

const byPlace = (a: FunctionEntity, b: FunctionEntity) =>
  compare(a.location?.file ?? "", b.location?.file ?? "") || (a.location?.startLine ?? 0) - (b.location?.startLine ?? 0) || compare(a.id, b.id);

function umlClass(type: TypeEntity, functions: FunctionEntity[]): UmlClass {
  const kind = type.kind ?? "class";
  const params = type.typeParameters?.length ? `<${type.typeParameters.join(", ")}>` : "";
  return {
    id: type.id,
    name: `${type.name}${params}`,
    stereotype: kind === "class" ? undefined : kind,
    isAbstract: type.isAbstract === true && !INTERFACES.has(kind),
    isInterface: INTERFACES.has(kind),
    isEnum: kind === "enum",
    attributes: (type.members ?? []).map(attribute),
    operations: functions.filter((f) => f.type === type.id && f.kind !== "accessor" && f.kind !== "lambda").sort(byPlace).map(operation),
  };
}

/** The id of a module's utility class: the module's own id names the module itself (D-066). */
export const utilityId = (module: string) => `${module} «utility»`;

/** The module a utility id names, or the id itself when it names something else. */
export const moduleOfUtility = (id: string) => (id.endsWith(" «utility»") ? id.slice(0, -" «utility»".length) : id);

const isFree = (f: FunctionEntity) => !f.type && f.kind !== "lambda" && f.kind !== "accessor";

/** One «utility» class per module of the given free functions, its operations static (spec/structure.md, D-066). */
function utilities(facts: Facts, functionIds: Iterable<string>): UmlClass[] {
  const wanted = new Set(functionIds);
  const byModule = new Map<string, FunctionEntity[]>();
  for (const f of facts.functions) {
    if (!wanted.has(f.id) || !isFree(f)) continue;
    if (!byModule.has(f.module)) byModule.set(f.module, []);
    byModule.get(f.module)!.push(f);
  }
  const names = new Map(facts.modules.map((m) => [m.id, m.name]));
  return [...byModule].map(([module, functions]) => ({
    id: utilityId(module),
    name: names.get(module) ?? module,
    stereotype: "utility",
    isAbstract: false,
    isInterface: false,
    isEnum: false,
    attributes: [],
    operations: functions.sort(byPlace).map((f) => ({ ...operation(f), isStatic: true })),
    functions: functions.map((f) => f.id),
  }));
}

/**
 * The classes of the given types, the utilities of the given free functions and the relations between them
 * (spec/structure.md, "Связи диаграммы классов" and "Утилита модуля"). External targets and other units stay out.
 */
export function classDiagram(facts: Facts, typeIds: Iterable<string>, title: string, functionIds: Iterable<string> = []): ClassDiagram {
  const shown = new Set(typeIds);
  const types = facts.types.filter((t) => shown.has(t.id)).sort((a, b) => compare(a.id, b.id));
  const byId = new Map(facts.types.map((t) => [t.id, t]));
  const utilityClasses = utilities(facts, functionIds);
  for (const u of utilityClasses) shown.add(u.id);
  const relations: UmlRelation[] = [];
  const key = (from: string, to: string) => `${from}\u0000${to}`;
  const linked = new Set<string>();
  const add = (relation: UmlRelation) => {
    relations.push(relation);
    linked.add(key(relation.from, relation.to));
  };

  for (const type of types) {
    const embedded = new Set<string>();
    for (const member of type.members ?? []) {
      if (!member.type || !shown.has(member.type) || member.type === type.id) continue;
      if (member.isEmbedded) {
        embedded.add(member.type);
        add({ from: type.id, to: member.type, kind: "embed" });
      } else {
        add({ from: type.id, to: member.type, kind: "association", label: member.name, many: member.isCollection === true });
      }
    }
    for (const target of type.satisfies ?? []) if (shown.has(target)) add({ from: type.id, to: target, kind: "realization" });
    for (const edge of facts.dependencies) {
      if (edge.from !== type.id || edge.kind !== "inheritance" || !shown.has(edge.to) || edge.to === type.id || embedded.has(edge.to)) continue;
      const realization = !isInterface(type) && isInterface(byId.get(edge.to));
      add({ from: type.id, to: edge.to, kind: realization ? "realization" : "generalization" });
    }
  }
  // Members of a type fold into it, as in the graph; a dependency is drawn only where nothing else joins the pair.
  const owner = new Map(facts.functions.filter((f) => f.type).map((f) => [f.id, f.type!]));
  for (const u of utilityClasses) for (const f of u.functions ?? []) owner.set(f, u.id);
  const unit = (id: string) => owner.get(id) ?? id;
  const dependencies = new Set<string>();
  for (const edge of facts.dependencies) {
    if (edge.kind !== "type-ref" && edge.kind !== "call") continue;
    const from = unit(edge.from), to = unit(edge.to);
    if (from === to || !shown.has(from) || !shown.has(to) || linked.has(key(from, to))) continue;
    dependencies.add(key(from, to));
  }
  for (const pair of dependencies) {
    const [from, to] = pair.split("\u0000");
    relations.push({ from, to, kind: "dependency" });
  }
  // Deduplicated: two inheritance edges or a realization both declared and satisfied give one line.
  const unique = new Map(relations.map((r) => [`${r.from}\u0000${r.to}\u0000${r.kind}\u0000${r.label ?? ""}`, r]));
  const sorted = [...unique.values()].sort((a, b) => compare(a.from, b.from) || compare(a.to, b.to) || RANK[a.kind] - RANK[b.kind] || compare(a.label ?? "", b.label ?? ""));
  const functions = facts.functions.filter((f) => f.type && shown.has(f.type));
  const classes = [...types.map((t) => umlClass(t, functions)), ...utilityClasses].sort((a, b) => compare(a.id, b.id));
  return { title, classes, relations: sorted };
}

/** Every type and every module's utility of an analysis: the diagram of the whole project. */
export function projectDiagram(facts: Facts, title: string): ClassDiagram {
  return classDiagram(facts, facts.types.map((t) => t.id), title, facts.functions.map((f) => f.id));
}

/**
 * The focus graph with its types drawn as classes: a type node carries its class, and the links between two classes
 * are the relations of the diagram. Links to folded modules and free functions stay as they are; columns do not move.
 */
export function withClasses(graph: Graph, diagram: ClassDiagram): Graph {
  const classes = new Map(diagram.classes.map((c) => [c.id, c]));
  // The free functions of a module fold into its utility (D-066): one class in place of the first of them, their links its.
  const folded = new Map<string, UmlClass>();
  for (const c of diagram.classes) for (const f of c.functions ?? []) folded.set(f, c);
  const nodes: GraphNode[] = [];
  for (const n of graph.nodes) {
    const utility = folded.get(n.id);
    if (!utility) nodes.push(classes.has(n.id) ? { ...n, uml: classes.get(n.id) } : n);
    else if (!nodes.some((m) => m.id === utility.id)) {
      const first = utility.operations[0];
      nodes.push({ ...n, id: utility.id, label: utility.name, cycle: false, size: utility.operations.length, shape: "square", kind: "«utility»", file: first?.file, line: first?.line, uml: utility });
    }
  }
  // A utility none of whose functions is linked still stands on the diagram, as an unlinked type does.
  const language = graph.nodes.find((n) => n.role === "type")?.language ?? graph.nodes[0]?.language ?? "";
  for (const c of diagram.classes) {
    if (!c.functions || nodes.some((n) => n.id === c.id)) continue;
    const first = c.operations[0];
    nodes.push({ id: c.id, label: c.name, language, cycle: false, size: c.operations.length, layer: 0, role: "type", shape: "square", kind: "«utility»", file: first?.file, line: first?.line, uml: c });
  }
  const merged = new Map<string, GraphEdge>();
  for (const e of graph.edges) {
    const from = folded.get(e.from)?.id ?? e.from, to = folded.get(e.to)?.id ?? e.to;
    if (from === to) continue;
    const key = `${from}\u0000${to}\u0000${e.kind}\u0000${e.pair?.join("\u0000") ?? ""}`;
    const known = merged.get(key);
    if (!known) merged.set(key, { ...e, from, to });
    else merged.set(key, { ...known, weight: known.weight + e.weight, cycle: known.cycle || e.cycle, ...(known.via || e.via ? { via: [...new Set([...(known.via ?? []), ...(e.via ?? [])])] } : {}) });
  }
  const kept = [...merged.values()].filter((e) => !(classes.has(e.from) && classes.has(e.to)));
  const relations: GraphEdge[] = diagram.relations.map((r) => ({
    from: r.from, to: r.to, kind: `uml-${r.kind}`, weight: 1, cycle: graph.edges.some((e) => e.cycle && e.from === r.from && e.to === r.to),
    ...(r.label !== undefined ? { label: r.label } : {}), ...(r.many ? { many: true } : {}),
  }));
  return { ...graph, nodes, edges: [...kept, ...relations] };
}

// ---- PlantUML ------------------------------------------------------------------------------------------------------

const quote = (text: string) => `"${text.replace(/"/g, "'")}"`;

/** Text for PlantUML: classes by id with short aliases, members in order, then the relations. */
export function toPlantUml(diagram: ClassDiagram): string {
  const alias = new Map(diagram.classes.map((c, i) => [c.id, `C${i + 1}`]));
  // ASCII only where Nomos chooses the text: Java reads the file in the system charset unless told otherwise.
  const lines = ["@startuml", `title ${diagram.title.replace(/↔/g, "<->")}`, "hide empty members", ""];
  for (const c of diagram.classes) {
    const keyword = c.isInterface ? "interface" : c.isEnum ? "enum" : c.isAbstract ? "abstract class" : "class";
    const stereotype = c.stereotype && !c.isInterface && !c.isEnum ? ` <<${c.stereotype}>>` : "";
    const members = [...c.attributes, ...c.operations];
    lines.push(`${keyword} ${quote(c.name)} as ${alias.get(c.id)}${stereotype}${members.length ? " {" : ""}`);
    for (const m of members) {
      const modifiers = `${m.isStatic ? "{static} " : ""}${m.isAbstract ? "{abstract} " : ""}`;
      const stereotypeText = m.stereotype ? `<<${m.stereotype}>> ` : "";
      const body = m.operation ? `${m.name}(${m.parameters ?? ""})${m.type ? ` : ${m.type}` : ""}` : `${m.name}${m.type ? ` : ${m.type}` : ""}`;
      lines.push(`  ${modifiers}${m.sign}${stereotypeText}${body}`);
    }
    if (members.length) lines.push("}");
  }
  if (diagram.relations.length) lines.push("");
  for (const r of diagram.relations) {
    const from = alias.get(r.from)!, to = alias.get(r.to)!;
    switch (r.kind) {
      case "generalization": lines.push(`${to} <|-- ${from}`); break;
      case "realization": lines.push(`${to} <|.. ${from}`); break;
      case "embed": lines.push(`${from} *-- ${to} : <<embed>>`); break;
      case "association": lines.push(`${from} -->${r.many ? ` "*"` : ""} ${to} : ${r.label}`); break;
      case "dependency": lines.push(`${from} ..> ${to}`); break;
    }
  }
  lines.push("@enduml", "");
  return lines.join("\n");
}

// ---- Mermaid -------------------------------------------------------------------------------------------------------

// Mermaid ends a method at its last closing parenthesis, so several results (Go) lose theirs: (int, error) → int, error.
const mermaidResult = (type: string) => (type.startsWith("(") && type.endsWith(")") ? type.slice(1, -1) : type);

// Mermaid writes generics with tildes and reads < and > as markup.
const tilde = (text: string) => text.replace(/[<>]/g, "~");

/** Text for a Mermaid classDiagram: identifiers made from names, labels where a name repeats or is not an identifier. */
export function toMermaid(diagram: ClassDiagram): string {
  const ids = new Map<string, string>();
  const taken = new Set<string>();
  for (const c of diagram.classes) {
    const base = c.name.replace(/<.*$/, "").replace(/[^A-Za-z0-9_]/g, "_") || "Type";
    let id = base;
    for (let n = 2; taken.has(id); n++) id = `${base}_${n}`;
    taken.add(id);
    ids.set(c.id, id);
  }
  const lines = ["---", `title: ${diagram.title}`, "---", "classDiagram"];
  for (const c of diagram.classes) {
    const id = ids.get(c.id)!;
    const plain = c.name.replace(/<.*$/, "");
    const generic = c.name.includes("<") ? tilde(c.name.slice(c.name.indexOf("<"))) : "";
    const label = plain !== id ? `["${plain.replace(/"/g, "'")}"]` : "";
    const annotation = c.isInterface ? "interface" : c.isEnum ? "enumeration" : c.isAbstract ? "abstract" : c.stereotype;
    const members = [...c.attributes, ...c.operations];
    const open = annotation !== undefined || members.length > 0;
    lines.push(`  class ${id}${generic}${label}${open ? " {" : ""}`);
    if (annotation) lines.push(`    <<${annotation}>>`);
    for (const m of members) {
      const stereotypeText = m.stereotype ? `«${m.stereotype}» ` : "";
      const text = m.operation
        ? `${m.sign}${m.name}(${tilde(m.parameters ?? "")})${m.isAbstract ? "*" : m.isStatic ? "$" : ""}${m.type ? ` ${tilde(mermaidResult(m.type))}` : ""}`
        : `${m.sign}${stereotypeText}${m.name}${m.type ? ` : ${tilde(m.type)}` : ""}${m.isStatic ? "$" : ""}`;
      lines.push(`    ${text}`);
    }
    if (open) lines.push("  }");
  }
  for (const r of diagram.relations) {
    const from = ids.get(r.from)!, to = ids.get(r.to)!;
    switch (r.kind) {
      case "generalization": lines.push(`  ${to} <|-- ${from}`); break;
      case "realization": lines.push(`  ${to} <|.. ${from}`); break;
      case "embed": lines.push(`  ${from} *-- ${to} : embed`); break;
      case "association": lines.push(`  ${from} -->${r.many ? ` "*"` : ""} ${to} : ${r.label}`); break;
      case "dependency": lines.push(`  ${from} ..> ${to}`); break;
    }
  }
  lines.push("");
  return lines.join("\n");
}

/** The diagram of what the types level shows for a module or a pair of modules; undefined when the module is gone. */
export function focusDiagram(runs: AnalysisRun[], module: string, peer?: string): { diagram: ClassDiagram; graph: Graph } | undefined {
  const graph = buildFocus(runs, module, peer);
  const run = runs.find((r) => r.facts.modules.some((m) => m.id === module));
  if (!graph || !run) return undefined;
  const types = new Set(run.facts.types.map((t) => t.id));
  const ids = graph.nodes.filter((n) => n.role === "type" && types.has(n.id)).map((n) => n.id);
  // A module's utility holds every free function of it, linked or not; a pair shows only what joins the two (D-066).
  const free = peer
    ? graph.nodes.filter((n) => n.role === "type" && !types.has(n.id)).map((n) => n.id)
    : run.facts.functions.filter((f) => f.module === module).map((f) => f.id);
  return { diagram: classDiagram(run.facts, ids, peer ? `${module} ↔ ${peer}` : module, free), graph };
}
