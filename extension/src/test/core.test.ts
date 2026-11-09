import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { PacksFileName, RegistryFileName, collectRegistry, findRuntime, missingPacks, readPacks, programIn, implicitWorkspace, launchConfig, readRegistry, runtimeArgument, selectBundled, writeWorkspaceFile } from "../core/bundle";
import type { RuntimeHost, RuntimeRequirement } from "../core/bundle";
import { ContractError, checkContract } from "../core/contracts";
import type { AnalysisRun, Facts, Finding } from "../core/model";
import { choiceToStore, describePractices, readPractices } from "../core/practices";
import type { Practice } from "../core/practices";
import { AnalyzerError, analyze, readManifest, readWorkspace, writePractices } from "../core/runner";
import { readFindings, readRuleTitles } from "../core/sarif";
import { buildFocus, buildGraph, describeFinding, formatMetrics, groupFindings, groupSkipped, lensesFor, moduleFolder, neighbourGroup, shapeOf, summarizeStyles } from "../core/views";

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
  // A line into a folded module names what it reaches there, a line out of one names who comes from there.
  assert.deepEqual(graph.edges.map((e) => e.via), [undefined, ["Y"], ["Y"], ["free"], ["W"]]);
});

test("a pair of modules shows only the links between their types, in two groups", () => {
  const graph = buildFocus([focusRun], "A", "B")!;
  assert.deepEqual(graph.groups, ["A", "B"]);
  assert.deepEqual(graph.nodes.map((n) => [n.id, n.layer, n.shape]), [["A.X", 0, "circle"], ["A.Z", 0, "diamond"], ["B.Y", 1, "square"], ["B.free", 1, "dot"]]);
  assert.deepEqual(graph.edges.map((e) => [e.from, e.to, e.kind]), [["A.X", "B.Y", "call"], ["A.X", "B.Y", "type-ref"], ["B.free", "A.Z", "call"]]);
  assert.ok(graph.edges.every((e) => !e.pair && !e.via));
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

test("the compact graph folds modules into folders within the limit, and opened folders show their modules", () => {
  const dependency = (from: string, to: string, kind = "call") => ({ from, to, kind, phase: "runtime" });
  const module = (id: string, files: string[]) => ({ id, name: id, files, loc: 10, metrics: {}, paradigmEvidence: [] });
  const tree = {
    ...facts,
    modules: [
      module("A", ["src/app/a.ts"]), module("B", ["src/app/b.ts"]), module("C", ["src/lib/deep/c.ts"]),
      module("D", ["src/lib/deep/d.ts"]), module("E", ["tools/e.ts"]),
    ],
    types: [], functions: [],
    dependencies: [dependency("A", "C"), dependency("A", "D", "import"), dependency("B", "C"), dependency("C", "D"), dependency("E", "A")],
    cycles: [],
  } as Facts;
  const runs = [{ language: "toy", root: ".", facts: tree, findings: [], partial: false }];
  assert.equal(moduleFolder(["src/lib/deep/c.ts", "src/lib/x.ts"]), "src/lib");
  assert.equal(moduleFolder(["main.go"]), "");

  // Five modules fit the default limit: nothing folds.
  assert.deepEqual(buildGraph(runs, { opened: [] }).nodes.map((n) => n.id).sort(), ["A", "B", "C", "D", "E"]);

  // With room for two nodes, src folds; a lone module in tools does not.
  const folded = buildGraph(runs, { opened: [], limit: 2 });
  assert.deepEqual(folded.nodes.map((n) => [n.id, n.role, n.label]).sort(), [["E", "module", "E"], ["src/", "folder", "src/ (4)"]]);
  assert.deepEqual(folded.edges.map((e) => [e.from, e.to, e.weight, e.pair]), [["E", "src/", 1, undefined]]);

  // Room for three: src opens, its folders stay folded; the chain src/lib/deep folds under its deepest name.
  const three = buildGraph(runs, { opened: [], limit: 3 });
  assert.deepEqual(three.nodes.map((n) => n.id).sort(), ["E", "src/app/", "src/lib/deep/"]);
  const links = three.edges.map((e) => `${e.from}>${e.to}:${e.kind}:${e.weight}`).sort();
  assert.deepEqual(links, ["E>src/app/:call:1", "src/app/>src/lib/deep/:call:2", "src/app/>src/lib/deep/:import:1"]);

  // The person opened src/lib/deep: its modules show though the limit is passed, and src/app stays folded.
  const opened = buildGraph(runs, { opened: ["src/lib/deep"], limit: 3 });
  assert.deepEqual(opened.nodes.map((n) => n.id).sort(), ["C", "D", "E", "src/app/"]);
  assert.deepEqual(opened.edges.find((e) => e.from === "C")?.pair, ["C", "D"]);
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
      fs.writeFileSync(${JSON.stringify(path.join(folder, "last-args.json"))}, JSON.stringify(args));
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

test("a failure names the error lines of stdout when stderr only summarizes", async () => {
  const { folder } = workspaceWith(0);
  const script = path.join(folder, "build-fails.js");
  fs.writeFileSync(script, `
    console.log("Restoring...\\r\\nx.cs(1,2): error CS1002: ; expected\\r\\nx.cs(1,2): error CS1002: ; expected");
    console.error("Build failed. Fix the build errors and run again.");
    process.exit(1);`);
  await assert.rejects(readManifest({ language: "toy", command: [process.execPath, script] }, folder), (e: Error) =>
    e.message === `toy: "manifest" exited with 1 (unexpected analyzer error): Build failed. Fix the build errors and run again. | x.cs(1,2): error CS1002: ; expected`);
});

test("a command that cannot start is a readable error", async () => {
  const { folder, workspace } = workspaceWith(0);
  await assert.rejects(readManifest({ language: "toy", command: ["no-such-program-nomos"] }, folder), /cannot start/);
  await assert.rejects(readManifest({ language: "toy", command: [process.execPath], cwd: "missing" }, folder), /working directory .*missing does not exist/);
  assert.equal(workspace.analyzers.length, 1);
});

function temporaryFolder(): string {
  return fs.mkdtempSync(path.join(fs.realpathSync(process.env.TEMP ?? process.env.TMPDIR ?? "/tmp"), "nomos-"));
}

/** An optional runtime as a registry would describe it; the names are placeholders, the extension knows no language. */
const optionalRuntime: RuntimeRequirement = {
  name: "Toy 3", extension: "toy.toy", command: "toy.interpreterPath", argument: { workspaceFolder: "${folder}" },
  path: ["toy3", "toy"], check: ["--version-at-least", "3"], installUrl: "https://example.org/toy",
};

function fakeHost(options: { extension?: boolean; answer?: unknown; usable: string[]; calls?: unknown[] }): RuntimeHost {
  return {
    hasExtension: () => options.extension ?? false,
    setting: () => undefined,
    environment: () => undefined,
    execute: async (command, argument) => {
      options.calls?.push({ command, argument });
      if (options.answer instanceof Error) throw options.answer;
      return options.answer;
    },
    usable: async (program, args) => {
      assert.deepEqual(args, ["--version-at-least", "3"]);
      return options.usable.includes(program);
    },
  };
}

test("an optional runtime is the extension's answer for the folder when it passes the check", async () => {
  const calls: unknown[] = [];
  const found = await findRuntime(optionalRuntime, "/work/app", fakeHost({ extension: true, answer: '"/opt/toy 3/bin/toy"', usable: ["/opt/toy 3/bin/toy"], calls }));
  assert.equal(found, "/opt/toy 3/bin/toy", "a quoted answer is a plain path");
  assert.deepEqual(calls, [{ command: "toy.interpreterPath", argument: { workspaceFolder: "/work/app" } }]);
});

test("an optional runtime falls back to PATH when the extension is missing, fails or gives an unusable program", async () => {
  assert.equal(await findRuntime(optionalRuntime, "/w", fakeHost({ usable: ["toy"] })), "toy");
  assert.equal(await findRuntime(optionalRuntime, "/w", fakeHost({ extension: true, answer: new Error("not ready"), usable: ["toy3", "toy"] })), "toy3");
  assert.equal(await findRuntime(optionalRuntime, "/w", fakeHost({ extension: true, answer: "toy-old", usable: ["toy"] })), "toy");
  assert.equal(await findRuntime({ ...optionalRuntime, resultField: "path" }, "/w", fakeHost({ extension: true, answer: { path: "/x/toy" }, usable: ["/x/toy"] })), "/x/toy");
});

test("an optional runtime without a usable program is not found", async () => {
  assert.equal(await findRuntime(optionalRuntime, "/w", fakeHost({ extension: true, answer: "toy", usable: [] })), undefined);
});

/** A runtime found through folders that settings and environment variables name (D-058); names are placeholders. */
const homeRuntime: RuntimeRequirement = {
  name: "Toy kit", settings: ["toy.home", "toy.legacyHome"], environment: ["TOY_HOME"], home: "bin/toy", path: ["toy"],
  check: ["-jar", "${bundle}/toy/probe.jar"], installUrl: "https://example.org/toy",
};

function homeHost(values: { settings?: Record<string, unknown>; environment?: Record<string, string>; usable: string[]; checks?: string[][] }): RuntimeHost {
  return {
    hasExtension: () => false,
    execute: async () => assert.fail("no extension is asked"),
    setting: (key, folder) => {
      assert.equal(folder, "/w");
      return values.settings?.[key];
    },
    environment: (name) => values.environment?.[name],
    usable: async (program, args) => {
      values.checks?.push(args);
      return values.usable.includes(program);
    },
  };
}

test("a runtime without an extension comes from the settings, then the environment, then PATH", async () => {
  const toy = (folder: string) => programIn(folder, "bin/toy");
  const checks: string[][] = [];
  assert.equal(await findRuntime(homeRuntime, "/w", homeHost({ settings: { "toy.legacyHome": "/opt/old" }, environment: { TOY_HOME: "/opt/env" }, usable: [toy("/opt/old"), toy("/opt/env")], checks }), "/ext/bundle"),
    toy("/opt/old"), "the first setting is empty, the second names a usable folder");
  assert.deepEqual(checks[0], ["-jar", "/ext/bundle/toy/probe.jar"], "the registry folder goes into the check");
  assert.equal(await findRuntime(homeRuntime, "/w", homeHost({ settings: { "toy.home": "/opt/broken" }, environment: { TOY_HOME: "/opt/env/" }, usable: [toy("/opt/env")] })), toy("/opt/env"));
  assert.equal(await findRuntime(homeRuntime, "/w", homeHost({ settings: { "toy.home": 3 }, usable: ["toy"] })), "toy", "a value that is not a folder is skipped");
  assert.equal(await findRuntime(homeRuntime, "/w", homeHost({ usable: [] })), undefined);
});

test("a program inside a folder has the executable suffix of the platform", () => {
  assert.equal(programIn("/opt/kit/", "bin/toy", "linux"), "/opt/kit/bin/toy");
  assert.equal(programIn("C:\\Kit\\", "bin/toy", "win32"), "C:\\Kit\\bin\\toy.exe");
});

test("the folder goes into every string of the runtime argument", () => {
  assert.deepEqual(runtimeArgument({ a: "${folder}/x", b: ["${folder}", 1], c: { d: "${folder}" }, e: true }, "/w"), { a: "/w/x", b: ["/w", 1], c: { d: "/w" }, e: true });
});

test("a build without bundled analyzers has no registry", () => {
  assert.equal(readRegistry(temporaryFolder()), undefined);
});

test("without nomos.json the bundled analyzers whose files exist run on their defaults", async () => {
  const bundle = temporaryFolder();
  const [, script] = fakeAnalyzer(bundle, 0);
  fs.renameSync(script, path.join(bundle, "toy.js"));
  // The runtime stands in for a program another extension provides; here it is Node itself.
  const runtime: RuntimeRequirement = { name: "Toy runtime", extension: "toy.runtime", command: "toy.acquire", argument: {}, resultField: "path" };
  fs.writeFileSync(path.join(bundle, RegistryFileName), JSON.stringify({
    analyzers: [
      { language: "toy", command: ["${runtime}", "${bundle}/toy.js"], files: ["**/*.toy"], runtime },
      { language: "other", command: ["${bundle}/other"], files: ["**/*.other"] },
    ],
  }));
  const registry = readRegistry(bundle)!;
  const asked: string[][] = [];
  const selected = await selectBundled(registry, async (globs) => (asked.push(globs), globs.includes("**/*.toy")));
  assert.deepEqual(asked, [["**/*.toy"], ["**/*.other"]]);
  assert.deepEqual(selected.map((a) => a.language), ["toy"]);

  // VS Code hands out the storage path without creating the folder.
  const storage = path.join(temporaryFolder(), "globalStorage", "nomos.nomos");
  assert.throws(() => launchConfig(selected[0], bundle, storage), /Toy runtime is required/);
  const config = launchConfig(selected[0], bundle, storage, process.execPath);
  assert.deepEqual(config.command, [process.execPath, `${bundle}/toy.js`]);

  const project = temporaryFolder();
  const run = await analyze(config, project, implicitWorkspace(config));
  assert.equal(run.root, project);
  const args = JSON.parse(fs.readFileSync(path.join(bundle, "last-args.json"), "utf8")) as string[];
  assert.equal(args.includes("--config"), false);
  assert.equal(fs.existsSync(path.join(storage, ".nomos", "toy.sarif")), true);
  assert.equal(fs.existsSync(path.join(project, ".nomos")), false);
});

test("${node} is the Node.js that runs the extension, switched to Node mode", async () => {
  const bundle = temporaryFolder();
  const [, script] = fakeAnalyzer(bundle, 0);
  fs.renameSync(script, path.join(bundle, "script.js"));
  const storage = temporaryFolder();
  const config = launchConfig({ language: "toy", command: ["${node}", "${bundle}/script.js"], files: ["**/*.toy"] }, bundle, storage);
  assert.deepEqual(config.command, [process.execPath, `${bundle}/script.js`]);
  assert.deepEqual(config.env, { ELECTRON_RUN_AS_NODE: "1" });
  const run = await analyze(config, temporaryFolder(), implicitWorkspace(config));
  assert.equal(run.language, "toy");
  // A command without ${node} gets no such variable.
  assert.equal(launchConfig({ language: "x", command: ["${bundle}/x"], files: [] }, bundle, storage).env, undefined);
});

const catalog: Practice[] = [
  { id: "solid", title: "SOLID", description: "d", rules: ["PRN001"] },
  { id: "security", title: "Security", description: "d", rules: ["SEC001"] },
];

test("the practice catalog of the package lists practices with their rules", () => {
  const practices = readPractices(path.join(__dirname, "..", "..", "practices.json"));
  assert.ok(practices.length > 0);
  for (const practice of practices) assert.ok(practice.id && practice.title && practice.rules.length, practice.id);
});

test("choosing every practice stores nothing, so practices of a later version are on too", () => {
  assert.equal(choiceToStore(catalog, ["security", "solid"]), undefined);
  assert.deepEqual(choiceToStore(catalog, ["security"]), ["security"]);
  assert.deepEqual(choiceToStore(catalog, []), []);
  assert.equal(describePractices(catalog, undefined), "all practices");
  assert.equal(describePractices(catalog, ["security"]), "Security");
  assert.match(describePractices(catalog, []), /no rule runs/);
});

test("without nomos.json the chosen practices reach the analyzer through a workspace file in the storage", async () => {
  const bundle = temporaryFolder();
  const [, script] = fakeAnalyzer(bundle, 0);
  const storage = path.join(temporaryFolder(), "globalStorage");
  const config = { language: "toy", command: [process.execPath, script], cwd: storage };
  fs.mkdirSync(storage, { recursive: true });
  assert.deepEqual(implicitWorkspace(config), { schemaVersion: "1.0.0", analyzers: [config] });
  const workspace = implicitWorkspace(config, ["security"]);
  const file = writeWorkspaceFile(workspace, storage, "folder-toy");
  assert.equal(path.dirname(path.dirname(file)), storage);
  checkContract("nomos", JSON.parse(fs.readFileSync(file, "utf8")), "generated workspace file");

  const project = temporaryFolder();
  await analyze(config, project, workspace, undefined, file);
  const args = JSON.parse(fs.readFileSync(path.join(bundle, "last-args.json"), "utf8")) as string[];
  assert.equal(args[args.indexOf("--config") + 1], file);
  assert.equal(fs.existsSync(path.join(project, "nomos.json")), false);
});

test("the choice is written into nomos.json, raising its version for the new field", () => {
  const { folder } = workspaceWith(0);
  writePractices(folder, ["solid"]);
  const written = readWorkspace(folder);
  assert.equal(written.schemaVersion, "1.1.0");
  assert.deepEqual(written.practices, ["solid"]);
  writePractices(folder, undefined);
  assert.equal(readWorkspace(folder).practices, undefined);
});

test("Russian templates pick word forms and finding texts come from rules.json (D-052)", async () => {
  const { describeSkip, format, localizeFinding, readBundle, readRules, translator } = await import("../core/l10n");
  assert.equal(format("{0} {0|строка|строки|строк}", ["1"]), "1 строка");
  assert.equal(format("{0} {0|строка|строки|строк}", ["24"]), "24 строки");
  assert.equal(format("{0} {0|строка|строки|строк}", ["11"]), "11 строк");

  const rules = readRules(path.join(__dirname, "..", "..", "rules.json"));
  const finding: Finding = {
    ruleId: "CC001", ruleTitle: "Long method", category: "CleanCode", level: "warning", severity: "minor", confidence: "high",
    message: "Run spans 52 lines", explanation: "The line count is exact; the limit of 40 is a readability convention.",
    file: "a.cs", startLine: 1, startColumn: 1, endLine: 2, endColumn: 1, module: "A",
    messageId: "lines", messageArguments: ["Run", "52"], explanationId: "limit", explanationArguments: ["40"],
  };
  assert.equal(localizeFinding(finding, rules, "en"), finding);
  const russian = localizeFinding(finding, rules, "ru");
  assert.equal(russian.message, "Run занимает 52 строки");
  assert.equal(russian.ruleTitle, "Длинный метод (Long method)");
  assert.match(russian.explanation, /^Число строк точное; предел 40/);
  // Without a template key the analyzer's English text stays.
  assert.equal(localizeFinding({ ...finding, messageId: undefined }, rules, "ru").message, "Run spans 52 lines");

  const bundle = readBundle(path.join(__dirname, "..", "..", "l10n", "bundle.l10n.ru.json"));
  const t = translator(bundle, "ru");
  assert.equal(t("{0} rules", 3), "3 правила");
  assert.equal(translator(bundle, "en")("{0} rules", 3), "3 rules");
  const skip = { ruleId: "CC001", module: "A", reason: "disabled-by-config", message: "Rule belongs to practice clean-code, which is not selected" };
  assert.equal(describeSkip(skip, rules, translator(bundle, "en"), ["Clean Code"]), skip.message);
  assert.equal(describeSkip(skip, rules, t, ["Чистый код (Clean Code)"]), "Правило входит в невыбранные практики: Чистый код (Clean Code)");
  assert.match(describeSkip({ ...skip, reason: "paradigm-not-detected" }, rules, t), /парадигмы «ООП»/);
});

test("SARIF template keys reach the finding", () => {
  const log = { version: "2.1.0", runs: [{ tool: { driver: { rules: [] } }, results: [{
    ruleId: "CC001", message: { text: "Run spans 52 lines", id: "lines", arguments: ["Run", "52"] },
    properties: { confidence: "high", explanation: "because", explanationMessage: { id: "limit", arguments: ["40"] } } }] }] };
  const [finding] = readFindings(log, "log");
  assert.equal(finding.messageId, "lines");
  assert.deepEqual(finding.messageArguments, ["Run", "52"]);
  assert.equal(finding.explanationId, "limit");
  assert.deepEqual(finding.explanationArguments, ["40"]);
});

test("language packs give registry entries from their package.json, ahead of the core's own bundle (D-062)", () => {
  const pack = (id: string, language: string) => ({ id, extensionPath: `/ext/${id}`, packageJSON: { nomos: { analyzers: [{ language, command: ["${bundle}/x"], files: [`**/*.${language}`] }] } } });
  const registry = collectRegistry(
    [pack("pub.zeta", "toy"), { id: "other.ext", extensionPath: "/ext/other", packageJSON: { name: "other" } }, pack("pub.alpha", "toy")],
    { analyzers: [{ language: "toy", command: [], files: [] }, { language: "own", command: [], files: [] }] }, "/core/bundle");
  assert.deepEqual(registry.analyzers.map((a) => [a.language, a.folder]), [["toy", path.join("/ext/pub.alpha", "bundle")], ["own", "/core/bundle"]]);
  const config = launchConfig(registry.analyzers[0], "/core/bundle", temporaryFolder());
  assert.deepEqual(config.command, [`${path.join("/ext/pub.alpha", "bundle")}/x`], "${bundle} is the folder of the pack");
});

test("a known pack is offered only when its files exist and nothing installed reads them", async () => {
  const known = [
    { name: "nomos-toy", analyzers: [{ language: "toy", files: ["**/*.toy"] }, { language: "toyscript", files: ["**/*.tys"] }] },
    { name: "nomos-own", analyzers: [{ language: "own", files: ["**/*.own"] }] },
    { name: "nomos-gone", analyzers: [{ language: "gone", files: ["**/*.gone"] }] },
    { name: "nomos-held", analyzers: [{ language: "held", files: ["**/*.held"] }] },
  ];
  const present = new Set(["**/*.toy", "**/*.own", "**/*.held"]);
  const missing = await missingPacks(known, "pub", ["Pub.Nomos-Held"], { analyzers: [{ language: "own", command: [], files: [] }] },
    async (globs) => globs.some((g) => present.has(g)));
  assert.deepEqual(missing, [{ id: "pub.nomos-toy", languages: ["toy"] }]);
});

test("the list of known packs is optional", () => {
  const folder = temporaryFolder();
  assert.deepEqual(readPacks(path.join(folder, PacksFileName)), []);
  fs.writeFileSync(path.join(folder, PacksFileName), JSON.stringify([{ name: "nomos-toy", analyzers: [] }]));
  assert.deepEqual(readPacks(path.join(folder, PacksFileName)), [{ name: "nomos-toy", analyzers: [] }]);
});
