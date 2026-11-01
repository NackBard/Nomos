import assert from "node:assert/strict";
import { test } from "node:test";
import { checkSarif } from "./sarif.ts";
import type { SarifContext } from "./sarif.ts";

const rule = { id: "CC001", name: "Long method", shortDescription: { text: "d" }, fullDescription: { text: "r" }, defaultConfiguration: { level: "warning" }, properties: { category: "CleanCode", paradigms: [] } };

function log(measured: unknown): string {
  return JSON.stringify({
    version: "2.1.0",
    runs: [{
      tool: { driver: { name: "t", version: "1", rules: [rule] } },
      results: [{
        ruleId: "CC001", ruleIndex: 0, level: "warning", message: { text: "long" },
        locations: [{ physicalLocation: { artifactLocation: { uri: "a.cs" }, region: { startLine: 3 } } }],
        partialFingerprints: { "nomos/v1": "abc" },
        properties: { severity: "minor", confidence: "high", explanation: "because", entity: "A.F", measured },
      }],
    }],
  });
}

function context(lines: number): SarifContext {
  return {
    manifest: { name: "t", version: "1", capabilities: { supportedRules: ["CC001"] } },
    entities: new Map([["A.F", { lines }]]),
    sarifPath: "x.sarif",
    facts: { checks: { sarifFile: "x.sarif", resultCount: 1 }, modules: [] },
  };
}

test("a measurement that agrees with the facts is accepted", () => {
  assert.deepEqual(checkSarif(log({ metric: "lines", value: 52, threshold: 40 }), context(52)), []);
});

test("a measurement that disagrees with the facts is reported", () => {
  assert.deepEqual(checkSarif(log({ metric: "lines", value: 52, threshold: 40 }), context(50)), ["result #0 (CC001): measured lines is 52, the facts say 50"]);
});

test("a measurement of the wrong shape is reported", () => {
  const errors = checkSarif(log({ metric: "lines", value: "52" }), context(52));
  assert.equal(errors.length, 1);
  assert.match(errors[0], /measured must be \{ metric, value, threshold \}/);
});

test("a result without an explanation is rejected", () => {
  const broken = JSON.parse(log(undefined));
  broken.runs[0].results[0].properties.explanation = " ";
  assert.match(checkSarif(JSON.stringify(broken), context(52)).join("\n"), /explanation is empty/);
});

test("the expected file is compared only for the rules in covers, and a stated measurement must match", () => {
  const measured = { metric: "lines", value: 52, threshold: 40 };
  const expected = (m: unknown) => ({ results: [{ ruleId: "CC001", file: "a.cs", startLine: 3, measured: m as any }] });
  assert.deepEqual(checkSarif(log(measured), { ...context(52), expected: { results: [] }, covers: new Set(["DSN002"]) }), []);
  assert.deepEqual(checkSarif(log(measured), { ...context(52), expected: expected(measured), covers: new Set(["CC001"]) }), []);
  assert.deepEqual(checkSarif(log(measured), { ...context(52), expected: { results: [] }, covers: new Set(["CC001"]) }), ["result CC001 a.cs:3: reported but not expected"]);
  assert.match(checkSarif(log(measured), { ...context(52), expected: expected({ ...measured, threshold: 41 }), covers: new Set(["CC001"]) })[0], /measured is/);
});
