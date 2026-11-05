import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { Config, ConfigError, loadConfig, specPractices, specRules } from "./config.ts";
import { analyze, manifest } from "./facts.ts";
import { Graph, components } from "./graph.ts";
import { Project } from "./project.ts";
import { supported } from "./rules.ts";

/** Writes the files into a fresh folder and analyzes it. */
function run(files: Record<string, string>, language = "typescript", config?: Config): { facts: any; sarif: any } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nomos-ts-"));
  try {
    for (const [name, text] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(root, name)), { recursive: true });
      fs.writeFileSync(path.join(root, name), text);
    }
    const project = new Project(root, language);
    project.load([], []);
    const sarifFile = path.join(root, "out.sarif");
    const result = analyze(project, { root, sarif: sarifFile, config: config ?? new Config({}, language) });
    return { facts: JSON.parse(result.facts), sarif: JSON.parse(fs.readFileSync(sarifFile, "utf8")) };
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

const edge = (d: any) => `${d.from} -> ${d.to} ${d.kind} ${d.phase}`;

test("components separate overlapping and bridged cycles", () => {
  const g = new Graph();
  for (const [a, b] of [["a", "b"], ["b", "a"], ["b", "c"], ["c", "d"], ["d", "c"]]) g.edge(a, b);
  assert.deepEqual(components(g), [["a", "b"], ["c", "d"]]);
});

test("the manifest declares the files of its language", () => {
  assert.deepEqual((manifest("typescript") as any).files, ["**/*.ts", "**/*.tsx", "**/*.mts", "**/*.cts"]);
  assert.deepEqual((manifest("javascript") as any).files, ["**/*.js", "**/*.jsx", "**/*.mjs", "**/*.cjs"]);
  assert.equal((manifest("javascript") as any).language, "javascript");
});

test("dependency and build folders, declaration files and the other language are not analyzed", () => {
  const { facts } = run({
    "src/a.ts": "export const a = 1;\n",
    "src/b.d.ts": "export declare const b: number;\n",
    "src/c.js": "export const c = 1;\n",
    "node_modules/x/index.ts": "export const x = 1;\n",
    "out/a.ts": "export const a = 1;\n",
  });
  assert.deepEqual(facts.files.map((f: any) => f.path), ["src/a.ts"]);
});

test("a folder without files of the language is an empty analysis, not an error", () => {
  const { facts } = run({ "a.cs": "class A {}\n" });
  assert.deepEqual(facts.modules, []);
  assert.ok(facts.diagnostics.some((d: any) => d.code === "no-files"));
});

test("an import used only as a type is erased; a cycle closed only by types is no cycle", () => {
  const { facts } = run({
    "a.ts": "import { B } from \"./b\";\nexport class A {\n  b?: B;\n  make() { return new B(); }\n}\n",
    "b.ts": "import { A } from \"./a\";\nexport class B {\n  a?: A;\n}\n",
  });
  const edges = facts.dependencies.filter((d: any) => !d.external).map(edge);
  assert.ok(edges.includes("a -> b import runtime"));
  assert.ok(edges.includes("b -> a import type-only"));
  assert.ok(edges.includes("b.B -> a.A type-ref type-only"));
  assert.ok(edges.includes("a.A -> b.B call runtime"));
  assert.deepEqual(facts.cycles, []);
});

test("every reference to an interface or a type alias is type-only", () => {
  const { facts } = run({
    "a.ts": "export interface Port { send(): void }\nexport function use(p: Port) { p.send(); }\n",
  });
  assert.deepEqual(facts.dependencies.filter((d: any) => !d.external).map(edge).sort(), [
    "a.use -> a.Port call type-only",
    "a.use -> a.Port type-ref type-only",
  ]);
});

test("CommonJS require binds a function of another module", () => {
  const { facts } = run({
    "a.js": "const { b } = require(\"./b.js\");\nfunction a() { return b(); }\nmodule.exports = { a };\n",
    "b.js": "function b() { return 1; }\nmodule.exports = { b };\n",
  }, "javascript");
  const edges = facts.dependencies.filter((d: any) => !d.external).map(edge);
  assert.ok(edges.includes("a.a -> b.b call runtime"), edges.join("\n"));
  assert.ok(edges.includes("a -> b import runtime"));
});

test("JSDoc types make a JavaScript callback a higher-order parameter", () => {
  const { facts } = run({ "h.js": "/** @param {(x: number) => number} f */\nexport function apply(f) { return f(1); }\n" }, "javascript");
  assert.equal(facts.functions.find((f: any) => f.id === "h.apply").metrics.hofOrder, 2);
});

test("a function stored in a module constant is a free function; let and var are global state", () => {
  const { facts } = run({ "m.ts": "export const f = (x: number) => x + 1;\nlet count = 0;\nexport const limit = 3;\n" });
  assert.deepEqual(facts.functions.map((f: any) => f.id), ["m.f"]);
  const evidence = facts.modules[0].paradigmEvidence.find((e: any) => e.kind === "str.global-state");
  assert.deepEqual(evidence.examples, ["m.count"]);
});

test("declarations inside a top-level immediately invoked function belong to the module", () => {
  const { facts } = run({ "page.js": "(function () {\n  let state = 0;\n  function draw() { return state; }\n  class View {}\n})();\n" }, "javascript");
  assert.deepEqual(facts.functions.map((f: any) => f.id), ["page.draw"]);
  assert.deepEqual(facts.types.map((t: any) => t.id), ["page.View"]);
});

test("every finding carries a template id and an explanation", () => {
  const { sarif } = run({
    "m.ts": "export function f(a: number[]) { let s = \"\"; for (const x of a) { for (const y of a) { s += String(x + y); if (a.includes(y)) { a.unshift(y); } } } return s; }\n",
  });
  const results = sarif.runs[0].results;
  assert.ok(results.length >= 3);
  for (const r of results) {
    assert.ok(r.message.id, `${r.ruleId}: ${r.message.text}`);
    assert.ok(r.properties.explanationMessage?.id, `${r.ruleId}: ${r.properties.explanation}`);
  }
});

test("practices turn off the rules outside them; an explicit rule setting wins", () => {
  const config = new Config({ schemaVersion: "1.1.0", practices: ["security"], rules: { CC003: { enabled: true } } }, "typescript");
  const { facts } = run({ "m.ts": "export function f(a: number) { return a; }\n" }, "typescript", config);
  const skipped = (id: string) => facts.skippedRules.find((s: any) => s.ruleId === id && !s.module);
  assert.equal(skipped("DSN001")?.reason, "disabled-by-config");
  assert.equal(skipped("CC003"), undefined);
  assert.equal(skipped("SEC003"), undefined);
});

test("an unknown practice is a configuration error", () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "nomos-ts-")), "nomos.json");
  fs.writeFileSync(file, JSON.stringify({ schemaVersion: "1.1.0", analyzers: [], practices: ["nope"] }));
  assert.throws(() => loadConfig(file, "typescript"), ConfigError);
});

test("every supported rule exists in spec and belongs to a practice", () => {
  const ids = new Set(specRules().map((r) => r.id));
  const inPractice = new Set(specPractices().flatMap((p) => p.rules));
  for (const id of supported) {
    assert.ok(ids.has(id), `${id} is not in spec/rules`);
    assert.ok(inPractice.has(id), `${id} is in no practice`);
  }
});

test("two runs give the same output", () => {
  const files = { "a.ts": "import { b } from \"./b\";\nexport function a() { return b(); }\n", "b.ts": "export function b() { return 1; }\n" };
  const strip = ({ facts, sarif }: { facts: any; sarif: any }) => ({ facts: { ...facts, checks: undefined }, sarif });
  assert.deepEqual(strip(run(files)), strip(run(files)));
});
