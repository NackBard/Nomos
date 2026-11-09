import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { buildRequest } from "../core/agents";
import { changes, parseUnifiedDiff } from "../core/git";
import type { Facts, Finding, Snapshot } from "../core/model";
import { changedFunctions, performanceCandidates, allFunctions, timeEstimate } from "../core/select";
import { flattenSarif, readSnapshot, writeSnapshot } from "../core/snapshot";
import { handle } from "../mcp/server";

function temp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "nomos-agents-"));
}

const metrics = (m: Record<string, number>) => ({ cyclomatic: 1, lines: 3, timeDegree: 0, timeLogFactor: 0, timeExponential: 0, spaceDegree: 0, allocationDepth: 0, ...m });

function facts(): Facts {
  return {
    schemaVersion: "1.3.0",
    analyzer: { name: "fake", version: "0", language: "fake" },
    files: [{ path: "src/a.x", loc: 12, lines: 12, module: "src/a" }],
    modules: [{ id: "src/a", name: "a", files: ["src/a.x"], loc: 12, metrics: {}, paradigmEvidence: [{ paradigm: "functional", kind: "fp.pure-functions", count: 1 }], activeParadigms: ["functional"] }],
    types: [],
    functions: [
      { id: "src/a.first", name: "first", module: "src/a", kind: "function", location: { file: "src/a.x", startLine: 1, endLine: 3 }, metrics: metrics({}) },
      { id: "src/a.second", name: "second", module: "src/a", kind: "function", location: { file: "src/a.x", startLine: 5 }, metrics: metrics({ lines: 4, timeDegree: 2, cyclomatic: 3 }) },
      { id: "src/a.third", name: "third", module: "src/a", kind: "function", location: { file: "src/a.x", startLine: 10, endLine: 12 }, metrics: metrics({ timeExponential: 1 }) },
    ],
    skippedRules: [{ ruleId: "OOP001", module: "src/a", reason: "paradigm-not-detected", message: "no classes" }],
    health: { score: 90 },
  };
}

const finding: Finding = { ruleId: "ALG001", ruleTitle: "Time complexity estimate", category: "Algorithms", level: "note", confidence: "low", message: "second is likely O(n^2)", explanation: "nested loops", file: "src/a.x", startLine: 5, endLine: 5, module: "src/a", entity: "src/a.second" };

const source = ["fun first() {", "  return 1", "}", "", "fun second(xs) {", "  for x in xs", "    for y in xs", "}", "", "fun third(n) {", "  third(n-1) + third(n-2)", "}"].join("\n") + "\n";

function snapshot(root: string): Snapshot {
  return { root, runs: [{ language: "fake", facts: facts(), findings: [finding] }], rules: [{ id: "ALG001", title: "Time complexity estimate", description: "Estimates growth." }], practices: [] };
}

test("a unified diff gives new-side ranges, and a removal marks the line it happened at", () => {
  const diff = [
    "diff --git a/src/a.x b/src/a.x", "--- a/src/a.x", "+++ b/src/a.x",
    "@@ -5,0 +6,2 @@", "+a", "+b", "@@ -9 +11 @@", "-x", "+y", "@@ -20,3 +22,0 @@",
    "diff --git a/gone b/gone", "--- a/gone", "+++ /dev/null", "@@ -1 +0,0 @@",
  ].join("\n");
  assert.deepEqual([...parseUnifiedDiff(diff)], [["src/a.x", [{ start: 6, end: 7 }, { start: 11, end: 11 }, { start: 22, end: 22 }]]]);
});

test("changed functions are those that overlap a changed range; the end comes from lines when endLine is absent", () => {
  const s = snapshot("/r");
  assert.deepEqual(changedFunctions(s, [{ file: "src/a.x", ranges: [{ start: 8, end: 8 }] }]).map((x) => x.fn.name), ["second"]);
  assert.deepEqual(changedFunctions(s, [{ file: "src/a.x" }]).map((x) => x.fn.name), ["first", "second", "third"]);
  assert.deepEqual(changedFunctions(s, [{ file: "other" }]), []);
});

test("performance candidates go exponential first and skip constant functions", () => {
  assert.deepEqual(performanceCandidates(allFunctions(snapshot("/r"))).map((x) => x.fn.name), ["third", "second"]);
  assert.equal(timeEstimate(facts().functions[1]), "O(n^2)");
  assert.equal(timeEstimate(facts().functions[0]), "O(1)");
  assert.equal(timeEstimate(facts().functions[2]), "exponential");
});

test("SARIF is flattened with confidence and explanation", () => {
  const log = { version: "2.1.0", runs: [{ tool: { driver: { rules: [{ id: "R1", name: "Rule", properties: { category: "Design" } }] } }, results: [{ ruleId: "R1", level: "note", message: { text: "m" }, locations: [{ physicalLocation: { artifactLocation: { uri: "f" }, region: { startLine: 4 } } }], properties: { confidence: "high", explanation: "e", module: "mod" } }] }] };
  assert.deepEqual(flattenSarif(log), [{ ruleId: "R1", ruleTitle: "Rule", category: "Design", level: "note", confidence: "high", message: "m", explanation: "e", file: "f", startLine: 4, endLine: 4, module: "mod", entity: undefined, measured: undefined }]);
});

test("a snapshot written by the extension reads back, and nomos-ci output reads too", () => {
  const dir = temp();
  writeSnapshot(dir, snapshot("/some/root"));
  const back = readSnapshot(dir);
  assert.equal(back.root, path.resolve("/some/root"));
  assert.equal(back.runs[0].findings[0].ruleId, "ALG001");
  assert.equal(back.rules[0].id, "ALG001");

  const ci = path.join(temp(), ".nomos");
  fs.mkdirSync(ci);
  fs.writeFileSync(path.join(ci, "fake.facts.json"), "﻿" + JSON.stringify(facts()));
  fs.writeFileSync(path.join(ci, "fake.sarif"), JSON.stringify({ version: "2.1.0", runs: [] }));
  const read = readSnapshot(ci);
  assert.equal(read.root, path.dirname(ci));
  assert.deepEqual(read.runs[0].findings, []);
});

test("the review context shows paradigms, findings, rules and numbered code, and names what did not fit", () => {
  const root = temp();
  fs.mkdirSync(path.join(root, "src"));
  fs.writeFileSync(path.join(root, "src/a.x"), source);
  const full = buildRequest("review", snapshot(root), { scope: "all", maxCharacters: 100_000, locale: "ru" });
  assert.match(full.system, /Answer in Russian/);
  assert.match(full.system, /never verdicts/);
  assert.match(full.user, /src\/a \(fake\): active functional; evidence fp\.pure-functions×1/);
  assert.match(full.user, /OOP001 skipped \(paradigm-not-detected\)/);
  assert.match(full.user, /ALG001 — Time complexity estimate/);
  assert.match(full.user, /^6 \|   for x in xs$/m);
  assert.deepEqual(full.summary.omitted, []);
  assert.equal(full.summary.included, 3);

  const small = buildRequest("review", snapshot(root), { scope: "all", maxCharacters: full.user.length - 100, locale: "en" });
  assert.ok(small.summary.omitted.length > 0);
  assert.match(small.user, /did not fit into the context/);
});

test("the changes scope compares with git, marks changed lines and counts untracked files whole", () => {
  const root = temp();
  const run = (...args: string[]) => execFileSync("git", args, { cwd: root, stdio: "pipe" });
  run("init", "-q", "-b", "main");
  run("config", "user.email", "test@example.com");
  run("config", "user.name", "test");
  fs.mkdirSync(path.join(root, "src"));
  fs.writeFileSync(path.join(root, "src/a.x"), source);
  run("add", ".");
  run("commit", "-q", "-m", "one");
  fs.writeFileSync(path.join(root, "src/a.x"), source.replace("  for y in xs", "  for y in ys"));
  fs.writeFileSync(path.join(root, "src/new.x"), "new\n");

  const found = changes(root);
  assert.equal(found.baseDescription, "HEAD (uncommitted changes)");
  assert.deepEqual(found.files, [{ file: "src/a.x", ranges: [{ start: 7, end: 7 }] }, { file: "src/new.x" }]);

  const request = buildRequest("performance", snapshot(root), { scope: "changes", maxCharacters: 100_000, locale: "en" });
  assert.equal(request.summary.functions, 1);
  assert.match(request.user, /^7\*\|     for y in ys$/m);
  assert.match(request.user, /^6 \|   for x in xs$/m);
  assert.match(request.system, /Only the changed code/);
});

test("the MCP server answers initialize, lists tools and prompts, and reports a missing analysis as a tool error", () => {
  const options = { snapshot: path.join(temp(), "none"), locale: "en" as const };
  const init = handle({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } }, options) as any;
  assert.equal(init.result.protocolVersion, "2025-06-18");
  assert.equal(handle({ jsonrpc: "2.0", method: "notifications/initialized" }, options), undefined);
  const list = handle({ jsonrpc: "2.0", id: 2, method: "tools/list" }, options) as any;
  assert.ok(list.result.tools.some((tool: any) => tool.name === "nomos_hotspots"));
  const prompts = handle({ jsonrpc: "2.0", id: 3, method: "prompts/list" }, options) as any;
  assert.deepEqual(prompts.result.prompts.map((p: any) => p.name), ["review", "performance"]);
  const call = handle({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "nomos_overview", arguments: {} } }, options) as any;
  assert.equal(call.result.isError, true);
  assert.match(call.result.content[0].text, /run the Nomos analysis first/);
  const unknown = handle({ jsonrpc: "2.0", id: 5, method: "nope" }, options) as any;
  assert.equal(unknown.error.code, -32601);
});

test("the MCP server over stdio serves tools and the performance prompt from a snapshot", async () => {
  const root = temp();
  fs.mkdirSync(path.join(root, "src"));
  fs.writeFileSync(path.join(root, "src/a.x"), source);
  const dir = path.join(root, ".nomos");
  writeSnapshot(dir, snapshot(root));
  const server = spawn(process.execPath, [path.join(__dirname, "..", "mcp", "server.js"), "--snapshot", dir], { stdio: ["pipe", "pipe", "inherit"] });
  const answers: any[] = [];
  let buffer = "";
  const done = new Promise<void>((resolve) => server.stdout.on("data", (chunk: Buffer) => {
    buffer += chunk.toString("utf8");
    const lines = buffer.split("\n");
    buffer = lines.pop()!;
    answers.push(...lines.filter(Boolean).map((l) => JSON.parse(l)));
    if (answers.length === 4) resolve();
  }));
  const send = (message: object) => server.stdin.write(JSON.stringify(message) + "\n");
  send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "test", version: "0" } } });
  send({ jsonrpc: "2.0", method: "notifications/initialized" });
  send({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "nomos_hotspots", arguments: { limit: 1 } } });
  send({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "nomos_source", arguments: { file: "../outside" } } });
  send({ jsonrpc: "2.0", id: 4, method: "prompts/get", params: { name: "performance", arguments: {} } });
  await done;
  server.kill();
  assert.equal(answers[0].result.protocolVersion, "2024-11-05");
  const hotspots = JSON.parse(answers[1].result.content[0].text);
  assert.equal(hotspots.total, 2);
  assert.equal(hotspots.functions[0].name, "third");
  assert.equal(answers[2].result.isError, true);
  assert.match(answers[3].result.messages[0].content.text, /Nomos Performance/);
  assert.match(answers[3].result.messages[0].content.text, /src\/a\.third/);
});
