// Expected values are computed by hand from spec/score.md for the small system below, not from the code's output.
import assert from "node:assert/strict";
import test from "node:test";
import { moduleOfTarget, moduleView, systemView } from "../core/dashboard";
import { criticalShare, percolationCurve, reachCounts, removalOrder, robustnessOf, undirected, unitGraph, visibilityClasses } from "../core/graph";
import { format, translator } from "../core/l10n";
import type { AnalysisRun, Facts, Finding } from "../core/model";
import { analyse, soft } from "../core/score";

// a.B → a.A, b.C → a.A, b.C → a.B, b.f → b.C; a.A is abstract; a.B.m is a method of a.B.
const facts: Facts = {
  analyzer: { language: "demo" },
  files: [{ path: "a.src", loc: 300, module: "a" }, { path: "b.src", loc: 100, module: "b" }],
  modules: [
    { id: "b", name: "b", files: ["b.src"], loc: 100, metrics: { ca: 0, ce: 2, instability: 1, abstractness: 0, distance: 0 } },
    { id: "a", name: "a", files: ["a.src"], loc: 300, metrics: { ca: 1, ce: 0, instability: 0, abstractness: 0.5, distance: 0.5 } },
  ],
  types: [
    { id: "a.A", name: "A", module: "a", kind: "interface", isAbstract: true, metrics: { cbo: 0, wmc: 0, dit: 0, lcom4: null } },
    { id: "a.B", name: "B", module: "a", kind: "class", metrics: { cbo: 1, lcom4: 2, wmc: 10, dit: 1 } },
    { id: "b.C", name: "C", module: "b", kind: "class", metrics: { cbo: 2, lcom4: 1, wmc: 40, dit: 0 } },
  ],
  functions: [
    { id: "b.f", name: "f", module: "b", metrics: { cyclomatic: 15, lines: 10, maintainabilityIndex: 40 }, location: { file: "b.src", startLine: 3 } },
    { id: "a.B.m", name: "m", module: "a", type: "a.B", metrics: { cyclomatic: 1, lines: 5, maintainabilityIndex: 80 } },
  ],
  dependencies: [
    { from: "a.B", to: "a.A", kind: "inheritance" },
    { from: "b.C", to: "a.A", kind: "type-ref" },
    { from: "b.C", to: "a.B.m", kind: "call" },
    { from: "b.f", to: "b.C", kind: "call" },
    { from: "b.f", to: "x.External", kind: "call", external: true },
    { from: "a.B", to: "a.B", kind: "call" },
  ],
  cycles: [],
  health: { score: 0, categories: [{ category: "Design" }, { category: "Maintainability" }] },
};
const findings: Finding[] = [
  { ruleId: "R1", category: "Design", severity: "major", confidence: "high", message: "m", file: "b.src", startLine: 1, module: "b" },
];
const run: AnalysisRun = { language: "demo", root: "/r", facts, findings };
const close = (actual: number | null | undefined, expected: number, message?: string) =>
  assert.ok(typeof actual === "number" && Math.abs(actual - expected) < 1e-3, `${message ?? ""} ${actual} ≠ ${expected}`);

test("the unit graph folds members, drops external edges and loops", () => {
  const g = unitGraph(facts);
  assert.deepEqual(g.ids, ["a.A", "a.B", "b.C", "b.f"]);
  assert.deepEqual(g.out, [[], [0], [0, 1], [2]]);
  assert.equal(g.edgeCount, 4);
  assert.deepEqual(reachCounts(g.in), [3, 2, 1, 0]);
  assert.deepEqual(reachCounts(g.out), [0, 1, 2, 3]);
  assert.deepEqual(visibilityClasses([3, 2, 1, 0], [0, 1, 2, 3]), ["shared", "shared", "control", "control"]);
});

test("percolation removes by degree with Ordinal ties", () => {
  const g = unitGraph(facts);
  const neighbours = undirected(g);
  const order = removalOrder(4, neighbours.map((l) => l.length));
  assert.deepEqual(order, [2, 0, 1, 3]);
  const curve = percolationCurve(neighbours, order);
  assert.deepEqual(curve, [1, 0.5, 0.25, 0.25, 0]);
  close(robustnessOf(curve), 0.25);
  close(criticalShare(curve), 0.25);
});

test("module scores follow spec/score.md", () => {
  const a = analyse(run);
  const [ma, mb] = a.modules;
  assert.equal(ma.id, "a");
  assert.equal(ma.zone, "pain");
  assert.equal(mb.zone, null);
  const value = (m: typeof ma, score: string, component: string) => m.scores.find((s) => s.key === score)!.components.find((c) => c.key === component)!.value;
  close(value(ma, "stability", "mainSequence"), 50);
  close(value(ma, "stability", "containment"), 0);
  close(value(mb, "stability", "containment"), 100 * (1 - 1 / 3));
  close(value(ma, "extensibility", "coupling"), (100 + 100 / 1.01) / 2);
  close(value(ma, "extensibility", "cohesion"), 50);
  close(value(mb, "extensibility", "typeSize"), 50);
  close(value(ma, "maintainability", "maintainabilityIndex"), 80);
  close(value(mb, "maintainability", "complexity"), 50);
  close(value(mb, "conformance", "designFindings"), 100 * Math.exp(-0.75));
  close(value(ma, "conformance", "designFindings"), 100);
  close(ma.overall, (50 + (99.50495 + 50 + 97.05882 + 97.05882) / 4 + 100 + (80 + 100 / (1 + 1 / 225) + 100) / 3) / 4);
  close(mb.overall, ((100 + 100 + 66.66667) / 3 + (96.15385 + 100 + 50 + 100) / 4 + 100 * Math.exp(-0.75) + (40 + 50 + 100) / 3) / 4);
  close(a.system.overall, (300 * ma.overall! + 100 * mb.overall!) / 400);
});

test("the losses add up to 100 minus the overall score", () => {
  const a = analyse(run);
  close(a.losses.reduce((s, l) => s + l.lost, 0), 100 - a.system.overall!);
  assert.equal(a.losses[0].module, "a");
  assert.equal(a.losses[0].component, "containment");
  close(a.losses[0].lost, 0.75 * 100 / 3 / 4);
});

test("scalability: propagation cost, largest cycle, decomposability", () => {
  const s = analyse(run).scalability;
  close(s.propagationCost, 0.5);
  close(s.propagation, 50);
  close(s.core, 100);
  close(s.decomposability, 50);
  close(s.value, 200 / 3);
  close(s.criticalShare, 0.25);
});

test("dashboards: the system, a module and a double-clicked unit", () => {
  const a = analyse(run);
  const view = systemView(a);
  assert.equal(view.units, 4);
  assert.deepEqual(view.classes, { core: 0, shared: 2, control: 2, periphery: 0 });
  assert.deepEqual(view.histogram.map((b) => b.count), [1, 0, 0, 0, 0, 1, 2]);
  assert.deepEqual(view.hubs.map((h) => h.id), ["a.A", "a.B", "b.C"]);
  assert.deepEqual(moduleOfTarget(a, "a.B.m"), { module: "a", unit: "a.B" });
  assert.deepEqual(moduleOfTarget(a, "b"), { module: "b" });
  const m = moduleView(a, "b", "b.f")!;
  assert.deepEqual(m.incoming, []);
  assert.deepEqual(m.outgoing, [{ module: "a", name: "a", count: 2 }]);
  assert.deepEqual(m.categories, [{ category: "Design", count: 1, penalty: 3 }]);
  assert.equal(moduleView(a, "missing"), undefined);
  // Deterministic: the same input gives the same JSON.
  assert.equal(JSON.stringify(systemView(analyse(run))), JSON.stringify(view));
});

test("soft and the templates", () => {
  assert.equal(soft(0, 10), 100);
  assert.equal(soft(10, 10), 50);
  assert.equal(format("{0} {0|модуль|модуля|модулей}", ["5"]), "5 модулей");
  assert.equal(translator({ Units: "Единицы" }, "ru").template("Units"), "Единицы");
});
