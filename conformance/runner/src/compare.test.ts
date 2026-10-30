import assert from "node:assert/strict";
import { test } from "node:test";
import { checkParity, compareFacts, toleranceFor, valuesMatch } from "./compare.ts";
import type { CaseSpec } from "./compare.ts";

const spec: CaseSpec = { id: "t", languages: ["csharp", "python"] };

function facts(overrides: Record<string, unknown> = {}): any {
  return {
    files: [], modules: [], types: [], functions: [], dependencies: [], cycles: [], skippedRules: [],
    ...overrides,
  };
}

const module_ = (id: string, metrics: Record<string, number | null>, evidence: any[] = []) =>
  ({ id, loc: 5, metrics, paradigmEvidence: evidence });

test("integers are exact, other numbers use the tolerance, null only equals null", () => {
  assert.equal(valuesMatch(3, 3, {}), true);
  assert.equal(valuesMatch(3, 4, { absolute: 5 }), false);
  assert.equal(valuesMatch(0.6667, 0.6666666, { absolute: 0.001 }), true);
  assert.equal(valuesMatch(0.5, 0.52, { absolute: 0.001 }), false);
  assert.equal(valuesMatch(100, 110.5, { relative: 0.15 }), true);
  assert.equal(valuesMatch(null, 0, { absolute: 1 }), false);
  assert.equal(valuesMatch(null, null, {}), true);
});

test("token-dependent metrics get the relative tolerance from the spec unless the case overrides it", () => {
  assert.deepEqual(toleranceFor(spec, "maintainabilityIndex"), { relative: 0.15 });
  assert.deepEqual(toleranceFor(spec, "instability"), { absolute: 0.001 });
  const wide: CaseSpec = { ...spec, tolerance: { metrics: { instability: { absolute: 0.1 } } } };
  assert.deepEqual(toleranceFor(wide, "instability"), { absolute: 0.1 });
});

test("a wrong, missing or extra entity is reported by id", () => {
  const expected = facts({ modules: [module_("A", { ca: 1 }), module_("B", {})] });
  const actual = facts({ modules: [module_("A", { ca: 2 }), module_("C", {})] });
  const errors = compareFacts(expected, actual, spec);
  assert.deepEqual(errors, [
    "module A: metric ca is 2, expected 1",
    "module B: expected but not reported",
    "module C: reported but not expected",
  ]);
});

test("a metric missing from the actual facts is reported, extra metrics are ignored", () => {
  const expected = facts({ modules: [module_("A", { ca: 1 })] });
  assert.deepEqual(compareFacts(expected, facts({ modules: [module_("A", {})] }), spec), ["module A: metric ca is missing (expected 1)"]);
  assert.deepEqual(compareFacts(expected, facts({ modules: [module_("A", { ca: 1, ce: 9 })] }), spec), []);
});

test("evidence is exact only when the case covers paradigmEvidence", () => {
  const kind = { paradigm: "oop", kind: "oop.classes", count: 1, description: "d" };
  const extra = { paradigm: "functional", kind: "fp.lambdas", count: 3, description: "d" };
  const expected = facts({ modules: [module_("A", {}, [kind])] });
  const actual = facts({ modules: [module_("A", {}, [kind, extra])] });
  assert.deepEqual(compareFacts(expected, actual, spec), []);
  assert.deepEqual(compareFacts(expected, actual, { ...spec, covers: ["paradigmEvidence"] }), ["module A evidence fp.lambdas=3: reported but not expected"]);
});

test("dependencies are compared by kind and phase, external targets are left out", () => {
  const edge = (from: string, to: string, kind: string, extra: object = {}) => ({ from, to, kind, phase: "runtime", ...extra });
  const expected = facts({ dependencies: [edge("A", "B", "type-ref")] });
  const external = edge("A", "System.String", "type-ref", { external: true, stdlib: true });
  assert.deepEqual(compareFacts(expected, facts({ dependencies: [edge("A", "B", "type-ref"), external] }), spec), []);
  assert.deepEqual(compareFacts(expected, facts({ dependencies: [edge("A", "B", "call")] }), spec), [
    "dependency A -> B [type-ref, runtime]: expected but not reported",
    "dependency A -> B [call, runtime]: reported but not expected",
  ]);
});

test("cycles are compared as sets regardless of member order", () => {
  const expected = facts({ cycles: [{ level: "type", members: ["A", "B"] }] });
  assert.deepEqual(compareFacts(expected, facts({ cycles: [{ level: "type", members: ["B", "A"] }] }), spec), []);
  assert.deepEqual(compareFacts(expected, facts(), spec), ["cycle type: A, B: expected but not reported"]);
});

test("parity fails when equivalent entities differ across languages and is skipped for a lone language", () => {
  const withParity: CaseSpec = { ...spec, parity: [{ metric: "cyclomatic", scope: "function", entities: { csharp: "N.F", python: "n.f" } }] };
  const fn = (id: string, cyclomatic: number) => facts({ functions: [{ id, metrics: { cyclomatic } }] });
  assert.deepEqual(checkParity(withParity, new Map([["csharp", fn("N.F", 3)], ["python", fn("n.f", 3)]])), []);
  assert.equal(checkParity(withParity, new Map([["csharp", fn("N.F", 3)], ["python", fn("n.f", 4)]])).length, 1);
  assert.deepEqual(checkParity(withParity, new Map([["csharp", fn("N.F", 3)]])), []);
});
