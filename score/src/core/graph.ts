// The graph of units (spec/metrics.md) and what spec/score.md reads from it: blast radius and its reverse,
// percolation under removal of units, and the core-periphery classes of units.
import type { Facts } from "./model";
import { ordinal } from "./model";

export interface UnitGraph {
  /** Unit ids in Ordinal order; every other array is indexed like this one. */
  ids: string[];
  names: string[];
  modules: string[];
  files: (string | undefined)[];
  lines: (number | undefined)[];
  /** Whether the unit is a type (otherwise a free function). */
  isType: boolean[];
  out: number[][];
  in: number[][];
  edgeCount: number;
}

export function unitGraph(facts: Facts): UnitGraph {
  const units = [
    ...facts.types.map((t) => ({ entity: t, isType: true })),
    ...facts.functions.filter((f) => !f.type).map((f) => ({ entity: f, isType: false })),
  ].sort((a, b) => ordinal(a.entity.id, b.entity.id));
  const index = new Map<string, number>();
  for (const [i, u] of units.entries()) if (!index.has(u.entity.id)) index.set(u.entity.id, i);
  // Members fold into their type; a function whose type is unknown folds nowhere and its edges drop.
  const memberType = new Map(facts.functions.filter((f) => f.type).map((f) => [f.id, f.type!]));
  const unitOf = (id: string): number | undefined => {
    const own = index.get(id);
    if (own !== undefined) return own;
    const type = memberType.get(id);
    return type === undefined ? undefined : index.get(type);
  };
  const out = units.map(() => new Set<number>());
  for (const d of facts.dependencies) {
    if (d.external) continue;
    const from = unitOf(d.from);
    const to = unitOf(d.to);
    if (from === undefined || to === undefined || from === to) continue;
    out[from].add(to);
  }
  const outLists = out.map((s) => [...s].sort((a, b) => a - b));
  const inLists: number[][] = units.map(() => []);
  for (const [from, targets] of outLists.entries()) for (const to of targets) inLists[to].push(from);
  return {
    ids: units.map((u) => u.entity.id),
    names: units.map((u) => u.entity.name),
    modules: units.map((u) => u.entity.module),
    files: units.map((u) => u.entity.location?.file),
    lines: units.map((u) => u.entity.location?.startLine),
    isType: units.map((u) => u.isType),
    out: outLists,
    in: inLists,
    edgeCount: outLists.reduce((sum, l) => sum + l.length, 0),
  };
}

/** For every unit, how many others it reaches along the given adjacency, without itself. */
export function reachCounts(adjacency: number[][]): number[] {
  const n = adjacency.length;
  const seen = new Int32Array(n).fill(-1);
  const stack = new Int32Array(n);
  const counts = new Array<number>(n).fill(0);
  for (let start = 0; start < n; start++) {
    let top = 0;
    let count = 0;
    seen[start] = start;
    stack[top++] = start;
    while (top > 0) {
      const u = stack[--top];
      for (const v of adjacency[u]) {
        if (seen[v] === start) continue;
        seen[v] = start;
        count++;
        stack[top++] = v;
      }
    }
    counts[start] = count;
  }
  return counts;
}

/** Neighbours ignoring direction. */
export function undirected(graph: UnitGraph): number[][] {
  return graph.out.map((targets, u) => [...new Set([...targets, ...graph.in[u]])].sort((a, b) => a - b));
}

/**
 * S(q) for q = 0…N: the share of N held by the largest connected component once the first q units of `order` are gone.
 * Computed backwards, adding units in reverse order to a union-find.
 */
export function percolationCurve(neighbours: number[][], order: number[]): number[] {
  const n = neighbours.length;
  const parent = new Int32Array(n).fill(-1);
  const size = new Int32Array(n);
  const find = (x: number): number => {
    while (parent[x] !== x) {
      parent[x] = parent[parent[x]];
      x = parent[x];
    }
    return x;
  };
  const curve = new Array<number>(n + 1).fill(0);
  let largest = 0;
  for (let k = n - 1; k >= 0; k--) {
    const u = order[k];
    parent[u] = u;
    size[u] = 1;
    for (const v of neighbours[u]) {
      if (parent[v] === -1) continue;
      const a = find(u);
      const b = find(v);
      if (a === b) continue;
      const [big, small] = size[a] >= size[b] ? [a, b] : [b, a];
      parent[small] = big;
      size[big] += size[small];
    }
    largest = Math.max(largest, size[find(u)]);
    curve[k] = n ? largest / n : 0;
  }
  return curve;
}

/** Removal order: by a key, larger first; ties by the next keys, then by index, which is Ordinal by id. */
export function removalOrder(n: number, ...keys: number[][]): number[] {
  return Array.from({ length: n }, (_, i) => i).sort((a, b) => {
    for (const key of keys) if (key[a] !== key[b]) return key[b] - key[a];
    return a - b;
  });
}

/** R of spec/score.md: the mean of S(q) for q = 1…N. */
export function robustnessOf(curve: number[]): number {
  const n = curve.length - 1;
  if (n <= 0) return 0;
  let sum = 0;
  for (let q = 1; q <= n; q++) sum += curve[q];
  return sum / n;
}

/** The smallest q/N with S(q) ≤ S(0)/2. */
export function criticalShare(curve: number[]): number {
  const n = curve.length - 1;
  for (let q = 0; q <= n; q++) if (curve[q] <= curve[0] / 2) return n ? q / n : 0;
  return 1;
}

export function median(values: number[]): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

export type VisibilityClass = "core" | "shared" | "control" | "periphery";

/** Core-periphery classes by visibility in (blast radius) and out (spec/score.md). */
export function visibilityClasses(fanIn: number[], fanOut: number[]): VisibilityClass[] {
  const inMedian = median(fanIn);
  const outMedian = median(fanOut);
  return fanIn.map((vin, i) => {
    const highIn = vin > inMedian && vin > 0;
    const highOut = fanOut[i] > outMedian && fanOut[i] > 0;
    return highIn && highOut ? "core" : highIn ? "shared" : highOut ? "control" : "periphery";
  });
}
