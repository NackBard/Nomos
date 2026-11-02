import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { ContractError, checkContract } from "../core/contracts";
import type { AnalysisRun, Facts, Finding } from "../core/model";
import { AnalyzerError, analyze, readManifest, readWorkspace } from "../core/runner";
import { readFindings, readRuleTitles } from "../core/sarif";
import { buildFocus, buildGraph, describeFinding, formatMetrics, groupFindings, groupSkipped, lensesFor, neighbourGroup, shapeOf, summarizeStyles } from "../core/views";

const facts: Facts = {
  schemaVersion: "1.0.0",
  analyzer: { name: "x", version: "1", language: "toy" },
  files: [{ path: "a.toy", loc: 3, lines: 4 }],
  modules: [
    { id: "A", name: "A", files: ["a.toy"], loc: 3, metrics: {}, paradigmEvidence: [] },
    { id: "B", name: "B", files: ["b.toy"], loc: 1, metrics: {}, paradigmEvidence: [] },
  ],
  types: [
    { id: "A.X", name: "X", module: "A", location: { file: "a.toy", startLine: 2 }, metrics: { wmc: 2, lcom4: null, lines: 3 } },
    { id: "B.Y", name: "Y", module: "B", location: { file: "b.toy", startLine: 1 }, metrics: {} },
  ],
  functions: [{ id: "A.X.Go", name: "Go", module: "A", location: { file: "a.toy", startLine: 3 }, metrics: { cyclomatic: 2 } }],
  dependencies: [
    { from: "A.X", to: "B.Y", kind: "call", phase: "runtime", count: 2 },
    { from: "A.X.Go", to: "B.Y", kind: "call", phase: "runtime" },
    { from: "B.Y", to: "A.X", kind: "type-ref", phase: "runtime" },
    { from: "A.X", to: "Lib.Z", kind: "call", phase: "runtime", external: true },
  ],
  cycles: [{ level: "type", members: ["A.X", "B.Y"] }],
  skippedRules: [],
  diagnostics: [],
};

const finding = (over: Partial<Finding>): Finding => ({
  ruleId: "R1", ruleTitle: "Rule", category: "Cat", level: "warning", severity: "minor", confidence: "low", message: "m", explanation: "because",
  file: "a.toy", startLine: 1, startColumn: 1, endLine: 1, endColumn: 2, module: "A", ...over,
});

test("skipped rules are joined by reason, once each", () => {
  const groups = groupSkipped([
    { ruleId: "B2", module: "A", reason: "paradigm-not-detected", message: "no classes" },
    { ruleId: "A1", module: "B", reason: "paradigm-not-detected", message: "no classes" },
    { ruleId: "A1", module: "A", reason: "paradigm-not-detected", message: "no classes" },
    { ruleId: "C3", reason: "missing-input", message: "no report" },
  ]);
  assert.deepEqual(groups, [
    { reason: "missing-input", message: "no report", rules: ["C3"] },
    { reason: "paradigm-not-detected", message: "no classes", rules: ["A1", "B2"] },
  ]);
});

test("rule titles come from the SARIF catalog, fired or not", () => {
  assert.deepEqual(readRuleTitles({ runs: [{ tool: { driver: { rules: [{ id: "A1", name: "First" }, { id: "B2" }] } } }] }), { A1: "First" });
  assert.deepEqual(readRuleTitles(undefined), {});
});

test("code opens in the group next to the graph", () => {
  assert.equal(neighbourGroup([1, 2], 2), 1);
  assert.equal(neighbourGroup([1, 2], 1), 2);
  assert.equal(neighbourGroup([1, 2, 3], 3), 2);
  assert.equal(neighbourGroup([1, 2, 3], 2), 1);
  assert.equal(neighbourGroup([1], 1), undefined);
  assert.equal(neighbourGroup([1, 2], undefined), undefined);
});

test("modules are counted by style, and evidence alone does not make a style", () => {
  const module = (id: string, activeParadigms?: string[]) => ({ id, name: id, files: [], loc: 1, metrics: {}, paradigmEvidence: [{ paradigm: "functional", kind: "fp.lambdas", count: 9 }], activeParadigms });
  const summary = summarizeStyles({ ...facts, modules: [module("A", ["oop"]), module("B", ["functional", "oop"]), module("C", ["oop"]), module("D", []), module("E")] });

  assert.equal(summary.total, 5);
  assert.deepEqual(summary.paradigms, [{ paradigm: "functional", modules: 1 }, { paradigm: "oop", modules: 3 }]);
  assert.deepEqual(summary.styles, [
    { paradigms: [], modules: ["D"] },
    { paradigms: ["functional", "oop"], modules: ["B"] },
    { paradigms: ["oop"], modules: ["A", "C"] },
  ]);
  assert.deepEqual(summary.unreported, ["E"]);
});

test("an unknown major version is rejected with a readable message", () => {
  assert.throws(() => checkContract("facts", { schemaVersion: "2.0.0" }, "facts"), (e: Error) => e instanceof ContractError && e.message.includes("understands 1.x"));
  assert.throws(() => checkContract("facts", { schemaVersion: "1.0.0" }, "facts"), /does not match facts.schema.json/);
});

test("readFindings flattens a result and refuses one without an explanation", () => {
  const result = { ruleId: "R1", level: "note", message: { text: "m" }, properties: { confidence: "high", explanation: "e", module: "M", measured: { metric: "lines", value: 5 } },
    locations: [{ physicalLocation: { artifactLocation: { uri: "a.toy" }, region: { startLine: 3 } } }] };
  const log = { version: "2.1.0", runs: [{ tool: { driver: { rules: [{ id: "R1", name: "Rule", properties: { category: "Cat" } }] } }, results: [result] }] };

  const [read] = readFindings(log, "log");
  assert.equal(read.category, "Cat");
  assert.equal(read.startLine, 3);
  assert.equal(read.measured?.value, 5);
  result.properties.explanation = "";
  assert.throws(() => readFindings(log, "log"), ContractError);
});

test("findings group by module and category in a stable order", () => {
  const tree = groupFindings([finding({ module: "B" }), finding({ module: "A", category: "Z" }), finding({ module: "A", category: "C" })]);
  assert.deepEqual(tree.map((m) => [m.module, m.total, m.categories.map((c) => c.key)]), [["A", 2, ["C", "Z"]], ["B", 1, ["Cat"]]]);
});

test("a finding is described as a heuristic with its explanation", () => {
  const text = describeFinding(finding({ measured: { metric: "lines", value: 50, threshold: 40 } }));
  assert.match(text, /Heuristic, low confidence/);
  assert.match(text, /because/);
  assert.match(text, /lines = 50 \(reported from 40\)/);
});

test("metrics keep undefined values visible", () => {
  assert.equal(formatMetrics({ wmc: 2, lcom4: null }, ["wmc", "lcom4", "absent"]), "wmc 2 · lcom4 n/a");
});

test("lenses are per file and ordered by line", () => {
  assert.deepEqual(lensesFor(facts, "a.toy").map((l) => l.line), [2, 3]);
  assert.deepEqual(lensesFor(facts, "other.toy"), []);
});

test("the module graph folds types and functions, drops external and self edges", () => {
  const run: AnalysisRun = { language: "toy", root: ".", facts, findings: [], partial: false };
  const graph = buildGraph([run]);
  assert.deepEqual(graph.edges.map((e) => [e.from, e.to, e.weight]), [["A", "B", 3], ["B", "A", 1]]);
  assert.equal(graph.nodes.some((n) => n.cycle), false);
});

const focusFacts = {
  ...facts,
  modules: ["A", "B", "C"].map((id) => ({ id, name: id, files: [], loc: 1, metrics: {}, paradigmEvidence: [] })),
  types: [
    { id: "A.X", name: "X", module: "A", kind: "class", metrics: {} },
    { id: "A.Z", name: "Z", module: "A", kind: "interface", isAbstract: true, metrics: {} },
    { id: "B.Y", name: "Y", module: "B", kind: "struct", metrics: {} },
    { id: "C.W", name: "W", module: "C", kind: "enum", metrics: {} },
  ],
  functions: [
    { id: "A.X.run", name: "run", module: "A", type: "A.X", metrics: {} },
    { id: "B.free", name: "free", module: "B", metrics: {} },
  ],
  dependencies: [
    { from: "A.X", to: "A.Z", kind: "inheritance", phase: "runtime" },
    { from: "A.X.run", to: "B.Y", kind: "call", phase: "runtime", count: 2 },
    { from: "A.X", to: "B.Y", kind: "call", phase: "runtime" },
    { from: "A.X", to: "B.Y", kind: "type-ref", phase: "runtime" },
    { from: "B.free", to: "A.Z", kind: "call", phase: "runtime" },
    { from: "A.Z", to: "C.W", kind: "type-ref", phase: "runtime" },
    { from: "B.Y", to: "C.W", kind: "type-ref", phase: "runtime" },
    { from: "A.X", to: "System.String", kind: "type-ref", phase: "runtime", external: true },
  ],
  cycles: [],
} as unknown as Facts;
const focusRun: AnalysisRun = { language: "toy", root: ".", facts: focusFacts, findings: [], partial: false };

test("a module shows its types and one line per kind to each other module", () => {
  const graph = buildFocus([focusRun], "A")!;
  assert.deepEqual(graph.nodes.map((n) => [n.id, n.role]), [["A.X", "type"], ["A.Z", "type"], ["B", "module"], ["C", "module"]]);
  assert.deepEqual(graph.edges.map((e) => [e.from, e.to, e.kind, e.weight, e.pair]), [
    ["A.X", "A.Z", "inheritance", 1, undefined],
    ["A.X", "B", "call", 3, ["A", "B"]],
    ["A.X", "B", "type-ref", 1, ["A", "B"]],
    ["B", "A.Z", "call", 1, ["A", "B"]],
    ["A.Z", "C", "type-ref", 1, ["A", "C"]],
  ]);
});

test("a pair of modules shows only the links between their types, in two groups", () => {
  const graph = buildFocus([focusRun], "A", "B")!;
  assert.deepEqual(graph.groups, ["A", "B"]);
  assert.deepEqual(graph.nodes.map((n) => [n.id, n.layer, n.shape]), [["A.X", 0, "circle"], ["A.Z", 0, "diamond"], ["B.Y", 1, "square"], ["B.free", 1, "dot"]]);
  assert.deepEqual(graph.edges.map((e) => [e.from, e.to, e.kind]), [["A.X", "B.Y", "call"], ["A.X", "B.Y", "type-ref"], ["B.free", "A.Z", "call"]]);
  assert.ok(graph.edges.every((e) => !e.pair));
});

test("a module missing from facts has no focus", () => {
  assert.equal(buildFocus([focusRun], "Gone"), undefined);
  assert.equal(buildFocus([focusRun], "A", "Gone"), undefined);
});

test("the type graph marks cycles", () => {
  const run: AnalysisRun = { language: "toy", root: ".", facts, findings: [], partial: false };
  const graph = buildFocus([run], "A", "B")!;
  assert.ok(graph.nodes.filter((n) => n.shape !== "dot").every((n) => n.cycle));
  assert.ok(graph.edges.filter((e) => e.from === "A.X").every((e) => e.cycle));
});

test("the shape follows the kind of a type, and abstract classes stand apart", () => {
  assert.equal(shapeOf("class", false), "circle");
  assert.equal(shapeOf("class", true), "triangle");
  assert.equal(shapeOf("interface", true), "diamond");
  assert.equal(shapeOf("enum", false), "hexagon");
  assert.equal(shapeOf("defined", false), "pentagon");
  assert.equal(shapeOf(undefined, undefined), "pentagon");
});

test("graph layers grow with dependency depth, and a cycle shares one layer", () => {
  const dependency = (from: string, to: string) => ({ from, to, kind: "call", phase: "runtime" });
  const module = (id: string) => ({ id, name: id, files: [], loc: 1, metrics: {}, paradigmEvidence: [] });
  const chain = {
    ...facts,
    modules: ["Top", "Mid", "Loop1", "Loop2", "Base"].map(module),
    types: ["Top", "Mid", "Loop1", "Loop2", "Base"].map((id) => ({ id: `${id}.T`, name: "T", module: id, metrics: {} })),
    functions: [],
    dependencies: [
      dependency("Top.T", "Mid.T"), dependency("Top.T", "Base.T"), dependency("Mid.T", "Loop1.T"),
      dependency("Loop1.T", "Loop2.T"), dependency("Loop2.T", "Loop1.T"), dependency("Loop2.T", "Base.T"),
    ],
    cycles: [],
  } as Facts;
  const graph = buildGraph([{ language: "toy", root: ".", facts: chain, findings: [], partial: false }]);
  assert.deepEqual(Object.fromEntries(graph.nodes.map((n) => [n.id, n.layer])), { Top: 3, Mid: 2, Loop1: 1, Loop2: 1, Base: 0 });
});

// A stand-in analyzer: the extension must work through the protocol alone, whatever the language.
function fakeAnalyzer(folder: string, exitCode: number): string[] {
  const script = path.join(folder, "fake.js");
  const sarif = { version: "2.1.0", runs: [{ tool: { driver: { rules: [] } }, results: [] }] };
  fs.writeFileSync(script, `
    const fs = require("fs");
    const [command, ...args] = process.argv.slice(2);
    if (command === "manifest") console.log(JSON.stringify({ name: "fake", language: "toy", version: "1.0.0", schemaVersion: "1.0.0", paradigms: [], capabilities: { semantic: false, supportedRules: [] }, rules: [] }));
    else {
      fs.writeFileSync(args[args.indexOf("--sarif") + 1], ${JSON.stringify(JSON.stringify(sarif))});
      if (${exitCode} !== 0 && ${exitCode} !== 4) { console.error("boom"); process.exit(${exitCode}); }
      console.log(JSON.stringify({ schemaVersion: "1.0.0", analyzer: { name: "fake", version: "1.0.0", language: "toy" }, files: [], modules: [], types: [], functions: [], dependencies: [], skippedRules: [], diagnostics: [] }));
      process.exit(${exitCode});
    }`);
  return [process.execPath, script];
}

function workspaceWith(exitCode: number) {
  const folder = fs.mkdtempSync(path.join(fs.realpathSync(process.env.TEMP ?? process.env.TMPDIR ?? "/tmp"), "nomos-"));
  const config = { language: "toy", command: fakeAnalyzer(folder, exitCode) };
  fs.writeFileSync(path.join(folder, "nomos.json"), JSON.stringify({ schemaVersion: "1.0.0", analyzers: [config] }));
  return { folder, config, workspace: readWorkspace(folder) };
}

test("the runner speaks the protocol with any analyzer", async () => {
  const { folder, config, workspace } = workspaceWith(0);
  assert.equal((await readManifest(config, folder)).name, "fake");
  const run = await analyze(config, folder, workspace);
  assert.equal(run.partial, false);
  assert.deepEqual(run.findings, []);
});

test("exit code 4 is a partial result, other codes are reported with their meaning", async () => {
  const partial = workspaceWith(4);
  assert.equal((await analyze(partial.config, partial.folder, partial.workspace)).partial, true);
  const failed = workspaceWith(3);
  await assert.rejects(analyze(failed.config, failed.folder, failed.workspace), (e: Error) => e instanceof AnalyzerError && /exited with 3 \(the input is not usable\): boom/.test(e.message));
});

test("a command that cannot start is a readable error", async () => {
  const { folder, workspace } = workspaceWith(0);
  await assert.rejects(readManifest({ language: "toy", command: ["no-such-program-nomos"] }, folder), /cannot start/);
  assert.equal(workspace.analyzers.length, 1);
});
