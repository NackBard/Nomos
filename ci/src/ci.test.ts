import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import type { Finding } from "./baseline.ts";
import { compare, findingsOf, toBaseline } from "./baseline.ts";
import { renderHtml, renderMarkdown } from "./report.ts";
import type { Run } from "./run.ts";

const here = path.dirname(fileURLToPath(import.meta.url));

function result(fingerprint: string, message: string, severity = "minor") {
  return {
    ruleId: "CC001", ruleIndex: 0, level: "warning", message: { text: message },
    locations: [{ physicalLocation: { artifactLocation: { uri: "a.toy" }, region: { startLine: 3 } } }],
    partialFingerprints: { "nomos/v1": fingerprint },
    properties: { severity, confidence: "high", explanation: "because", module: "m" },
  };
}

function sarif(results: unknown[]) {
  return { version: "2.1.0", runs: [{ tool: { driver: { name: "toy", version: "1", rules: [{ id: "CC001", properties: { category: "CleanCode" } }] } }, results }] };
}

const facts = {
  schemaVersion: "1.2.0", analyzer: { name: "toy", version: "1", language: "toy" }, files: [{ path: "a.toy", lines: 1, loc: 1 }],
  modules: [{ id: "m", name: "m", files: ["a.toy"], loc: 1, metrics: { ca: 0, ce: 0, instability: null, abstractness: null, distance: null }, paradigmEvidence: [], activeParadigms: [] }],
  types: [], functions: [], dependencies: [], skippedRules: [{ ruleId: "PAT001", reason: "not-supported", message: "m" }], diagnostics: [],
  health: { score: 42, categories: [], explanation: ["why"] },
};

const run = (results: unknown[]): Run => ({ language: "toy", facts, sarif: sarif(results), partial: false });

test("the comparison finds new, gone and repeated findings by fingerprint", () => {
  const before = toBaseline(findingsOf(run([result("a", "kept"), result("b", "twice"), result("b", "twice"), result("c", "gone")])));
  const after = findingsOf(run([result("a", "kept, on another line"), result("b", "twice"), result("d", "new")]));
  const comparison = compare(after, before);
  assert.deepEqual(comparison.added.map((f: Finding) => f.fingerprint), ["d"]);
  assert.deepEqual(comparison.removed.map((f) => f.fingerprint).sort(), ["b", "c"]);
  assert.equal(comparison.unchanged, 2);
});

test("a fingerprint of another language is another finding", () => {
  const before = toBaseline(findingsOf(run([result("a", "x")])));
  before.findings[0].language = "other";
  assert.equal(compare(findingsOf(run([result("a", "x")])), before).added.length, 1);
});

test("reports show the numbers, carry no verdict and are deterministic", () => {
  const findings = run([result("a", "x | y"), result("b", "bad <b>", "critical")]);
  const markdown = renderMarkdown([findings], []);
  assert.match(markdown, /x \\\| y/);
  assert.ok(markdown.indexOf("bad <b>") < markdown.indexOf("x \\| y"), "more severe findings go first");
  assert.match(markdown, /not a verdict/);
  assert.doesNotMatch(markdown.toLowerCase(), /\bpassed\b|\bfailed\b|grade/);
  assert.equal(markdown, renderMarkdown([findings], []));
  const html = renderHtml([findings], [{ language: "broken", message: "exit code 1: <boom>" }]);
  assert.match(html, /bad &lt;b&gt;/);
  assert.match(html, /&lt;boom&gt;/);
  assert.doesNotMatch(html, /<b>/);
});

function workspace(script: string): { dir: string; run: (...args: string[]) => ReturnType<typeof spawnSync> } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nomos-ci-"));
  fs.writeFileSync(path.join(dir, "toy.mjs"), script);
  fs.writeFileSync(path.join(dir, "nomos.json"), JSON.stringify({ schemaVersion: "1.0.0", analyzers: [{ language: "toy", command: ["node", "toy.mjs"] }] }));
  const cli = path.join(here, "cli.ts");
  return { dir, run: (...args) => spawnSync("node", [cli, ...args], { cwd: dir, encoding: "utf8" }) };
}

const analyzer = (results: unknown[], code: number) => `
import fs from "node:fs";
const args = process.argv.slice(2);
fs.mkdirSync(".nomos", { recursive: true });
fs.writeFileSync(args[args.indexOf("--sarif") + 1], ${JSON.stringify(JSON.stringify(sarif(results)))});
console.log(${JSON.stringify(JSON.stringify(facts))});
process.exitCode = ${code};`;

test("many findings and a low score do not change the exit code, a partial result is not a failure", () => {
  const { dir, run: ci } = workspace(analyzer(Array.from({ length: 50 }, (_, i) => result(String(i), "x", "critical")), 4));
  const outcome = ci();
  assert.equal(outcome.status, 0, String(outcome.stderr));
  for (const file of ["toy.facts.json", "toy.sarif", "report.md", "report.html"]) assert.ok(fs.existsSync(path.join(dir, ".nomos", file)), file);
});

test("a baseline written by one run is read by the next", () => {
  const { dir, run: ci } = workspace(analyzer([result("a", "x")], 0));
  assert.equal(ci("--write-baseline", "base.json").status, 0);
  const outcome = ci("--baseline", "base.json");
  assert.equal(outcome.status, 0);
  assert.match(String(outcome.stdout), /0 new, 0 gone, 1 unchanged/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, ".nomos", "diff.json"), "utf8")).unchanged, 1);
});

test("an analyzer that did not finish is an error, and the report says so", () => {
  const { dir, run: ci } = workspace(`console.error("broken"); process.exitCode = 1;`);
  assert.equal(ci().status, 1);
  assert.match(fs.readFileSync(path.join(dir, ".nomos", "report.md"), "utf8"), /toy: exit code 1: broken/);
});

test("wrong usage and a missing workspace have their own codes", () => {
  const { run: ci } = workspace("");
  assert.equal(ci("--nonsense", "x").status, 2);
  assert.equal(ci("--workspace", "absent.json").status, 3);
});

test("--locale ru translates the report from the templates of spec, and only the report", async () => {
  const { translator } = await import("./l10n.ts");
  const templated = { ...result("a", "Run spans 52 lines"), message: { text: "Run spans 52 lines", id: "lines", arguments: ["Run", "52"] } };
  const russian = renderMarkdown([run([templated])], [], undefined, translator("ru"));
  assert.match(russian, /^# Отчёт Nomos/);
  assert.match(russian, /Run занимает 52 строки/);
  assert.match(russian, /незначительная | высокая/);
  assert.doesNotMatch(renderMarkdown([run([templated])], []), /занимает/);
  // The baseline keeps the English text whatever the locale.
  assert.equal(toBaseline(findingsOf(run([templated]))).findings[0].message, "Run spans 52 lines");
});
