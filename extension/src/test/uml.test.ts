import assert from "node:assert/strict";
import test from "node:test";
import type { AnalysisRun, Facts } from "../core/model";
import { classDiagram, focusDiagram, projectDiagram, toMermaid, toPlantUml, withClasses } from "../core/uml";
import { buildFocus } from "../core/views";

const at = (line: number) => ({ file: "s.toy", startLine: line });

// A toy language: S embeds B and holds a list of C, B is general for N, I is an interface, F a free function.
const facts: Facts = {
  schemaVersion: "1.3.0",
  analyzer: { name: "x", version: "1", language: "toy" },
  files: [{ path: "s.toy", loc: 30, lines: 30 }],
  modules: [
    { id: "M", name: "M", files: ["s.toy"], loc: 30, metrics: {}, paradigmEvidence: [] },
    { id: "P", name: "P", files: ["p.toy"], loc: 1, metrics: {}, paradigmEvidence: [] },
  ],
  types: [
    { id: "M.I", name: "I", module: "M", kind: "interface", isAbstract: true, location: at(1), metrics: {} },
    { id: "M.B", name: "B", module: "M", kind: "class", isAbstract: true, location: at(3), metrics: {}, members: [{ name: "id", kind: "field", visibility: "protected", typeName: "int" }] },
    {
      id: "M.S", name: "S", module: "M", kind: "struct", isAbstract: false, location: at(5), metrics: {}, typeParameters: ["T"], satisfies: ["M.I"],
      members: [
        { name: "B", kind: "field", visibility: "public", typeName: "B", type: "M.B", isEmbedded: true },
        { name: "items", kind: "field", visibility: "private", typeName: "List<C>", type: "M.C", isCollection: true },
        { name: "Count", kind: "field", visibility: "public", typeName: "int", isStatic: true },
      ],
    },
    { id: "M.C", name: "C", module: "M", kind: "class", isAbstract: false, location: at(10), metrics: {}, members: [{ name: "parent", kind: "field", visibility: "private", typeName: "N", type: "M.N" }] },
    { id: "M.N", name: "N", module: "M", kind: "class", isAbstract: false, location: at(12), metrics: {} },
    { id: "M.E", name: "E", module: "M", kind: "enum", isAbstract: false, location: at(14), metrics: {}, members: [{ name: "One", kind: "literal", visibility: "public" }] },
    { id: "P.Q", name: "Q", module: "P", kind: "class", isAbstract: false, location: { file: "p.toy", startLine: 1 }, metrics: {} },
  ],
  functions: [
    { id: "M.S.Run", name: "Run", module: "M", type: "M.S", kind: "method", visibility: "public", location: at(8), metrics: {}, parameters: [{ name: "n", typeName: "int" }, { name: "", typeName: "string" }], returnTypeName: "(int, error)" },
    { id: "M.S.New", name: "S", module: "M", type: "M.S", kind: "constructor", visibility: "public", location: at(6), metrics: {}, parameters: [] },
    { id: "M.I.Do", name: "Do", module: "M", type: "M.I", kind: "method", visibility: "public", location: at(2), metrics: {}, parameters: [], isAbstract: true },
    { id: "M.S.get_X", name: "get_X", module: "M", type: "M.S", kind: "accessor", location: at(7), metrics: {} },
    { id: "M.F", name: "F", module: "M", kind: "function", location: at(20), metrics: {}, parameters: [] },
  ],
  dependencies: [
    { from: "M.S", to: "M.B", kind: "inheritance", phase: "runtime" },
    { from: "M.S", to: "M.C", kind: "type-ref", phase: "runtime" },
    { from: "M.S.Run", to: "M.N", kind: "call", phase: "runtime" },
    { from: "M.N", to: "M.C", kind: "inheritance", phase: "runtime" },
    { from: "M.C", to: "M.N", kind: "type-ref", phase: "runtime" },
    { from: "M.B", to: "M.I", kind: "inheritance", phase: "runtime" },
    { from: "M.F", to: "M.S", kind: "call", phase: "runtime" },
    { from: "M.C", to: "P.Q", kind: "call", phase: "runtime" },
  ],
  skippedRules: [],
  diagnostics: [],
};

const ids = ["M.I", "M.B", "M.S", "M.C", "M.N", "M.E"];

test("relations follow spec/structure.md: embedding instead of generalization, realization to interfaces, dependency only alone", () => {
  const diagram = classDiagram(facts, ids, "M");
  const relations = diagram.relations.map((r) => `${r.from} ${r.kind} ${r.to}${r.label ? ` ${r.label}` : ""}${r.many ? " *" : ""}`);
  assert.deepEqual(relations, [
    "M.B realization M.I",
    // Composite: C both holds an N and is general for it; the type use of N by C is not repeated as a dependency.
    "M.C association M.N parent",
    "M.N generalization M.C",
    "M.S embed M.B",
    "M.S association M.C items *",
    "M.S realization M.I",
    // The call from a method of S folds into S.
    "M.S dependency M.N",
  ]);
});

test("compartments: members in order, operations by line without accessors, signs, static and abstract", () => {
  const s = classDiagram(facts, ids, "M").classes.find((c) => c.id === "M.S")!;
  assert.equal(s.name, "S<T>");
  assert.equal(s.stereotype, "struct");
  assert.deepEqual(s.attributes.map((m) => m.text), ["+«embed» B", "-items: List<C>", "+Count: int"]);
  assert.equal(s.attributes[2].isStatic, true);
  assert.deepEqual(s.operations.map((m) => m.text), ["+S()", "+Run(n: int, string): (int, error)"]);
  // A click on an operation opens it: each one keeps its own place, attributes have none.
  assert.deepEqual(s.operations.map((m) => [m.file, m.line]), s.operations.map((m) => { const f = facts.functions.find((x) => x.type === "M.S" && x.name === m.name)!; return [f.location!.file, f.location!.startLine]; }));
  assert.ok(s.operations.every((m) => m.line !== undefined));
  assert.ok(s.attributes.every((m) => m.file === undefined));
  const i = classDiagram(facts, ids, "M").classes.find((c) => c.id === "M.I")!;
  assert.equal(i.isInterface, true);
  assert.equal(i.operations[0].isAbstract, true);
  const b = classDiagram(facts, ids, "M").classes.find((c) => c.id === "M.B")!;
  assert.equal(b.isAbstract, true);
  assert.equal(b.stereotype, undefined);
});

test("PlantUML text is deterministic and uses aliases for ids that are not identifiers", () => {
  const text = toPlantUml(classDiagram(facts, ids, "M"));
  assert.equal(text, toPlantUml(classDiagram(facts, [...ids].reverse(), "M")));
  assert.match(text, /^@startuml\ntitle M\n/);
  assert.match(text, /\nabstract class "B" as C1 \{\n  #id : int\n\}\n/);
  assert.match(text, /\nclass "S<T>" as C6 <<struct>> \{\n  \+<<embed>> B\n  -items : List<C>\n  \{static\} \+Count : int\n  \+S\(\)\n  \+Run\(n: int, string\) : \(int, error\)\n\}\n/);
  assert.match(text, /\ninterface "I" as C4 \{\n  \{abstract\} \+Do\(\)\n\}\n/);
  assert.match(text, /\nenum "E" as C3 \{\n  One\n\}\n/);
  assert.match(text, /\nC4 <\|\.\. C1\n/);
  assert.match(text, /\nC6 \*-- C1 : <<embed>>\n/);
  assert.ok(/^[\x00-\x7f]*$/.test(text), "PlantUML text of ASCII names is ASCII");
  assert.match(toPlantUml(classDiagram(facts, ids, "M ↔ P")), /\ntitle M <-> P\n/);
  assert.match(text, /\nC6 --> "\*" C2 : items\n/);
  assert.match(text, /\nC2 <\|-- C5\n/);
  assert.match(text, /\nC6 \.\.> C5\n/);
  assert.match(text, /@enduml\n$/);
});

test("Mermaid text writes generics with tildes and marks static and abstract members", () => {
  const text = toMermaid(classDiagram(facts, ids, "M"));
  assert.match(text, /^---\ntitle: M\n---\nclassDiagram\n/);
  assert.match(text, /\n  class S~T~ \{\n    <<struct>>\n    \+«embed» B\n    -items : List~C~\n    \+Count : int\$\n    \+S\(\)\n    \+Run\(n: int, string\) int, error\n  \}\n/);
  assert.match(text, /\n  class I \{\n    <<interface>>\n    \+Do\(\)\*\n  \}\n/);
  assert.match(text, /\n  class E \{\n    <<enumeration>>\n    One\n  \}\n/);
  assert.match(text, /\n  S --> "\*" C : items\n/);
  assert.match(text, /\n  I <\|\.\. B\n/);
  assert.match(text, /\n  S \*-- B : embed\n/);
});

test("names that repeat get their own identifiers and a label in Mermaid", () => {
  const twin: Facts = { ...facts, types: [...facts.types, { id: "P.C", name: "C", module: "P", kind: "class", isAbstract: false, location: at(1), metrics: {} }] };
  const text = toMermaid(classDiagram(twin, ["M.C", "P.C"], "M ↔ P"));
  assert.match(text, /\n  class C \{/);
  assert.match(text, /\n  class C_2\["C"\]\n/);
});

const run: AnalysisRun = { language: "toy", root: ".", facts, findings: [], partial: false };

test("the types level as classes: type nodes carry their class, links between classes become relations, other links stay", () => {
  const focus = buildFocus([run], "M")!;
  const classes = withClasses(focus, focusDiagram([run], "M")!.diagram);
  assert.equal(classes.nodes.find((n) => n.id === "M.S")?.uml?.name, "S<T>");
  // The free function F folds into the utility of M, in its place, and its link is the utility's (D-066).
  assert.equal(classes.nodes.find((n) => n.id === "M.F"), undefined);
  assert.equal(classes.nodes.find((n) => n.id === "M «utility»")?.uml?.stereotype, "utility");
  assert.deepEqual(classes.nodes.map((n) => n.id), focus.nodes.map((n) => (n.id === "M.F" ? "M «utility»" : n.id)));
  const kinds = classes.edges.map((e) => `${e.from} ${e.kind} ${e.to}`).sort();
  assert.ok(kinds.includes("M «utility» uml-dependency M.S"), "the utility depends on what its function calls");
  assert.ok(!kinds.some((k) => k.startsWith("M.F ")), "no link of the folded function is left");
  assert.ok(kinds.includes("M.C call P"), "a link to a folded module stays");
  assert.ok(kinds.includes("M.S uml-association M.C"));
  assert.ok(!kinds.includes("M.S type-ref M.C"));
  assert.deepEqual(classes.edges.find((e) => e.kind === "uml-association" && e.from === "M.S"), { from: "M.S", to: "M.C", kind: "uml-association", weight: 1, cycle: false, label: "items", many: true });
});

test("a pair of modules exports only the types the pair view shows", () => {
  const found = focusDiagram([run], "M", "P")!;
  assert.equal(found.diagram.title, "M ↔ P");
  assert.deepEqual(found.diagram.classes.map((c) => c.id), ["M.C", "P.Q"]);
  assert.deepEqual(found.diagram.relations, [{ from: "M.C", to: "P.Q", kind: "dependency" }]);
  assert.equal(focusDiagram([run], "Gone"), undefined);
});

test("the free functions of a module are one «utility» class with static operations, linked like a type (D-066)", () => {
  // Hand-made: G is a second free function of M with no links, L a lambda, which stays out. A module of functions only
  // (P2) still gets its class, so its diagram is not empty.
  const more: Facts = {
    ...facts,
    modules: [...facts.modules, { id: "P2", name: "Util", files: ["u.toy"], loc: 5, metrics: {}, paradigmEvidence: [] }],
    functions: [
      ...facts.functions,
      { id: "M.G", name: "G", module: "M", kind: "function", visibility: "internal", location: at(25), metrics: {}, parameters: [{ name: "x", typeName: "int" }], returnTypeName: "bool" },
      { id: "M.L", name: "L", module: "M", kind: "lambda", location: at(26), metrics: {} },
      { id: "P2.h", name: "h", module: "P2", kind: "function", location: { file: "u.toy", startLine: 1 }, metrics: {} },
    ],
    dependencies: [...facts.dependencies, { from: "P2.h", to: "M.G", kind: "call", phase: "runtime" }],
  };
  const moreRun: AnalysisRun = { ...run, facts: more };
  const m = focusDiagram([moreRun], "M")!.diagram;
  const utility = m.classes.find((c) => c.id === "M «utility»")!;
  assert.equal(utility.name, "M");
  assert.deepEqual(utility.operations.map((o) => `${o.text} static=${o.isStatic}`), ["F() static=true", "~G(x: int): bool static=true"]);
  assert.deepEqual(utility.functions, ["M.F", "M.G"]);
  assert.deepEqual(m.relations.filter((r) => r.from === "M «utility»"), [{ from: "M «utility»", to: "M.S", kind: "dependency" }]);
  assert.match(toPlantUml(m), /\nclass "M" as C1 <<utility>> \{\n  \{static\} F\(\)\n  \{static\} ~G\(x: int\) : bool\n\}\n/);
  assert.match(toMermaid(m), /\n  class M \{\n    <<utility>>\n    F\(\)\$\n    ~G\(x: int\)\$ bool\n  \}\n/);

  const util = focusDiagram([moreRun], "P2")!.diagram;
  assert.deepEqual(util.classes.map((c) => c.id), ["P2 «utility»"]);

  const whole = projectDiagram(more, "all");
  assert.deepEqual(whole.classes.filter((c) => c.stereotype === "utility").map((c) => c.id), ["M «utility»", "P2 «utility»"]);
  assert.ok(whole.relations.some((r) => r.from === "P2 «utility»" && r.to === "M «utility»" && r.kind === "dependency"), "utilities depend on each other through calls");
});
