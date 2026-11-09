// Which functions an agent looks at. Ordering is Ordinal by id wherever the ranking ties, so the same snapshot
// gives the same context.
import type { ChangedFile, LineRange } from "./git";
import type { Finding, FunctionEntity, LanguageRun, Place, Snapshot } from "./model";

export interface Selected { language: string; fn: FunctionEntity; findings: Finding[] }

export function ordinal(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Last line of an entity: endLine when the analyzer gave it, else from the `lines` metric, else the first line. */
export function lastLine(place: Place, lines?: number | null): number {
  return place.endLine ?? (lines ? place.startLine + lines - 1 : place.startLine);
}

function overlaps(start: number, end: number, ranges: LineRange[] | undefined): boolean {
  return ranges === undefined || ranges.some((r) => r.start <= end && r.end >= start);
}

function findingsOf(run: LanguageRun, fn: FunctionEntity): Finding[] {
  const end = lastLine(fn.location, fn.metrics.lines);
  return run.findings.filter((f) => f.entity === fn.id || (f.file === fn.location.file && f.startLine >= fn.location.startLine && f.startLine <= end));
}

/** Every function with its findings, in a stable order. */
export function allFunctions(snapshot: Snapshot): Selected[] {
  return snapshot.runs.flatMap((run) => run.facts.functions.map((fn) => ({ language: run.language, fn, findings: findingsOf(run, fn) })))
    .sort((a, b) => ordinal(a.language, b.language) || ordinal(a.fn.id, b.fn.id));
}

/** Functions whose lines overlap a change. Lambdas inside a changed function are left to that function. */
export function changedFunctions(snapshot: Snapshot, files: ChangedFile[]): Selected[] {
  const byFile = new Map(files.map((f) => [f.file, f]));
  return allFunctions(snapshot).filter(({ fn }) => {
    const changed = byFile.get(fn.location.file);
    return changed !== undefined && fn.kind !== "lambda" && overlaps(fn.location.startLine, lastLine(fn.location, fn.metrics.lines), changed.ranges);
  });
}

/** Findings that lie on changed lines, including those outside any function (types, modules). */
export function changedFindings(snapshot: Snapshot, files: ChangedFile[]): Finding[] {
  const byFile = new Map(files.map((f) => [f.file, f]));
  return snapshot.runs.flatMap((run) => run.findings).filter((f) => {
    const changed = byFile.get(f.file);
    return changed !== undefined && overlaps(f.startLine, f.endLine, changed.ranges);
  });
}

const metric = (fn: FunctionEntity, name: string): number => fn.metrics[name] ?? 0;

/**
 * Functions whose static estimates point at a cost worth a look: superlinear or exponential time, memory that
 * grows with the input, allocation inside loops, or an algorithm finding. Most expensive first.
 */
export function performanceCandidates(selected: Selected[]): Selected[] {
  const interesting = (s: Selected) => metric(s.fn, "timeExponential") > 0 || metric(s.fn, "timeDegree") >= 2
    || (metric(s.fn, "timeDegree") >= 1 && metric(s.fn, "timeLogFactor") >= 1) || metric(s.fn, "spaceDegree") >= 1
    || metric(s.fn, "allocationDepth") >= 1 || s.findings.some((f) => f.category === "Algorithms");
  return selected.filter(interesting).sort(byCost);
}

/** Exponential first, then by the degree of time, its logarithm, memory, allocation depth and complexity. */
export function byCost(a: Selected, b: Selected): number {
  for (const name of ["timeExponential", "timeDegree", "timeLogFactor", "spaceDegree", "allocationDepth", "cyclomatic"]) {
    const difference = metric(b.fn, name) - metric(a.fn, name);
    if (difference) return difference;
  }
  return ordinal(a.fn.id, b.fn.id);
}

/** Functions with findings first, the most findings first, then by complexity: what a reviewer of all code reads first. */
export function byReviewInterest(a: Selected, b: Selected): number {
  return b.findings.length - a.findings.length || metric(b.fn, "cyclomatic") - metric(a.fn, "cyclomatic") || ordinal(a.fn.id, b.fn.id);
}

/** The static time estimate of a function as text, e.g. O(n^2 log n); spec/metrics.md, "Оценки сложности функции". */
export function timeEstimate(fn: FunctionEntity): string | undefined {
  if (fn.metrics.timeExponential === 1) return "exponential";
  const degree = fn.metrics.timeDegree;
  const log = fn.metrics.timeLogFactor;
  if (degree === null || degree === undefined) return undefined;
  const parts = [degree === 0 ? "" : degree === 1 ? "n" : `n^${degree}`, !log ? "" : log === 1 ? "log n" : `log^${log} n`].filter(Boolean);
  return `O(${parts.join(" ") || "1"})`;
}
