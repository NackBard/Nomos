// Reports from facts and SARIF only, so they work for any language. No grades and no pass or fail: the score is
// shown with its derivation, and the output is deterministic.
import type { Comparison, Finding } from "./baseline.ts";
import { findingsOf } from "./baseline.ts";
import type { Run, RunFailure } from "./run.ts";

const MaxFindings = 500;
const severityOrder = ["critical", "major", "minor", "info"];
const ordinal = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

const metric = (value: number | null | undefined) => (value === null || value === undefined ? "–" : String(Math.round(value * 100) / 100));

function sorted(findings: Finding[]): Finding[] {
  return [...findings].sort((a, b) =>
    severityOrder.indexOf(a.severity) - severityOrder.indexOf(b.severity) || ordinal(a.file, b.file) || a.line - b.line || ordinal(a.ruleId, b.ruleId) || ordinal(a.message, b.message));
}

interface Table { title: string; head: string[]; rows: string[][]; note?: string }
interface Section { title: string; lines: string[]; tables: Table[] }

function sections(runs: Run[], failures: RunFailure[], comparison?: Comparison): Section[] {
  const result: Section[] = runs.map((run) => {
    const facts = run.facts;
    const findings = sorted(findingsOf(run));
    const reasons = new Map<string, number>();
    for (const skip of facts.skippedRules) reasons.set(skip.reason, (reasons.get(skip.reason) ?? 0) + 1);
    const lines = [
      `Analyzer: ${facts.analyzer.name} ${facts.analyzer.version}. Files: ${facts.files.length}. Modules: ${facts.modules.length}. Findings: ${findings.length}.`,
      `Health: ${facts.health?.score ?? "–"}. This is a number with its derivation, not a verdict.`,
      ...(facts.health?.explanation ?? []),
      ...(run.partial ? ["Partial result: some files could not be parsed."] : []),
    ];
    const tables: Table[] = [
      { title: "Categories", head: ["Category", "Score", "Weight", "Findings", "Penalty"], rows: (facts.health?.categories ?? []).map((c: any) => [c.category, metric(c.score), metric(c.weight), String(c.findingCount), metric(c.penalty)]) },
      {
        title: "Modules", head: ["Module", "Loc", "Health", "Ca", "Ce", "I", "A", "D", "Paradigms"],
        rows: facts.modules.map((m: any) => [m.id, String(m.loc), metric(m.health?.score), metric(m.metrics.ca), metric(m.metrics.ce), metric(m.metrics.instability), metric(m.metrics.abstractness), metric(m.metrics.distance), (m.activeParadigms ?? []).join(", ")]),
      },
      {
        title: "Findings", head: ["Severity", "Confidence", "Rule", "Place", "Message"],
        rows: findings.slice(0, MaxFindings).map((f) => [f.severity, f.confidence, f.ruleId, `${f.file}:${f.line}`, f.message]),
        note: findings.length > MaxFindings ? `First ${MaxFindings} of ${findings.length}; all of them are in the SARIF file.` : undefined,
      },
      { title: "Skipped rules", head: ["Reason", "Records"], rows: [...reasons].sort(([a], [b]) => ordinal(a, b)).map(([reason, n]) => [reason, String(n)]) },
    ];
    return { title: run.language, lines, tables };
  });
  if (comparison) {
    result.push({
      title: "Compared with the baseline",
      lines: [`New: ${comparison.added.length}. Gone: ${comparison.removed.length}. Unchanged: ${comparison.unchanged}.`],
      tables: [
        { title: "New findings", head: ["Language", "Rule", "Place", "Message"], rows: sorted(comparison.added).map((f) => [f.language, f.ruleId, `${f.file}:${f.line}`, f.message]) },
        { title: "Gone findings", head: ["Language", "Rule", "File", "Message"], rows: comparison.removed.map((f) => [f.language, f.ruleId, f.file, f.message]).sort((a, b) => ordinal(a.join("\0"), b.join("\0"))) },
      ],
    });
  }
  if (failures.length) result.push({ title: "Analyzers that did not finish", lines: failures.map((f) => `${f.language}: ${f.message}`), tables: [] });
  return result;
}

export function renderMarkdown(runs: Run[], failures: RunFailure[], comparison?: Comparison): string {
  const cell = (text: string) => text.replaceAll("|", "\\|").replaceAll("\n", " ");
  const out = ["# Nomos report", ""];
  for (const section of sections(runs, failures, comparison)) {
    out.push(`## ${section.title}`, "", ...section.lines.flatMap((line) => [line, ""]));
    for (const table of section.tables) {
      if (!table.rows.length) continue;
      out.push(`### ${table.title}`, "", `| ${table.head.join(" | ")} |`, `|${table.head.map(() => "---|").join("")}`);
      for (const row of table.rows) out.push(`| ${row.map(cell).join(" | ")} |`);
      out.push("", ...(table.note ? [table.note, ""] : []));
    }
  }
  return out.join("\n");
}

const escape = (text: string) => text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");

export function renderHtml(runs: Run[], failures: RunFailure[], comparison?: Comparison): string {
  const body: string[] = [];
  for (const section of sections(runs, failures, comparison)) {
    body.push(`<h2>${escape(section.title)}</h2>`, ...section.lines.map((line) => `<p>${escape(line)}</p>`));
    for (const table of section.tables) {
      if (!table.rows.length) continue;
      body.push(`<h3>${escape(table.title)}</h3>`, "<table>", `<thead><tr>${table.head.map((h) => `<th>${escape(h)}</th>`).join("")}</tr></thead>`, "<tbody>");
      for (const row of table.rows) body.push(`<tr>${row.map((c) => `<td>${escape(c)}</td>`).join("")}</tr>`);
      body.push("</tbody>", "</table>", ...(table.note ? [`<p>${escape(table.note)}</p>`] : []));
    }
  }
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Nomos report</title>
<style>
body { font: 15px/1.5 system-ui, sans-serif; margin: 0 auto; max-width: 70rem; padding: 1rem; color: #1a1a1a; background: #fff; }
table { border-collapse: collapse; width: 100%; display: block; overflow-x: auto; }
th, td { border-bottom: 1px solid #ddd; padding: .25rem .5rem; text-align: left; vertical-align: top; }
@media (prefers-color-scheme: dark) { body { color: #e6e6e6; background: #181818; } th, td { border-color: #3a3a3a; } }
</style>
</head>
<body>
<h1>Nomos report</h1>
${body.join("\n")}
</body>
</html>
`;
}
