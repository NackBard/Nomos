// Reports from facts and SARIF only, so they work for any language. No grades and no pass or fail: the score is
// shown with its derivation, and the output is deterministic.
import type { Comparison, Finding } from "./baseline.ts";
import { findingsOf } from "./baseline.ts";
import { findingText } from "./l10n.ts";
import type { Translate } from "./l10n.ts";
import { translator } from "./l10n.ts";
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

/** Words of the facts and SARIF contracts in the language of the report; other values stay as they are. */
function word(value: string, t: Translate): string {
  const words: Record<string, string> = {
    critical: t("critical"), major: t("major"), minor: t("minor"), info: t("info"), low: t("low"), medium: t("medium"), high: t("high"),
    "paradigm-not-detected": t("paradigm not detected"), "not-supported": t("not supported"), "disabled-by-config": t("disabled by the configuration"),
    "needs-semantic-model": t("needs a semantic model"), "missing-input": t("missing input"), error: t("error"),
    Algorithms: t("Algorithms"), CleanCode: t("CleanCode"), Design: t("Design"), Maintainability: t("Maintainability"),
    Paradigm: t("Paradigm"), Patterns: t("Patterns"), Principles: t("Principles"), Security: t("Security"),
  };
  return words[value] ?? value;
}

function sections(runs: Run[], failures: RunFailure[], comparison: Comparison | undefined, t: Translate): Section[] {
  const text = (f: Finding) => findingText(f.ruleId, f.template, f.message, t.locale);
  const result: Section[] = runs.map((run) => {
    const facts = run.facts;
    const findings = sorted(findingsOf(run));
    const reasons = new Map<string, number>();
    for (const skip of facts.skippedRules) reasons.set(skip.reason, (reasons.get(skip.reason) ?? 0) + 1);
    const lines = [
      t("Analyzer: {0} {1}. Files: {2}. Modules: {3}. Findings: {4}.", facts.analyzer.name, facts.analyzer.version, facts.files.length, facts.modules.length, findings.length),
      t("Health: {0}. This is a number with its derivation, not a verdict.", facts.health?.score ?? "–"),
      ...(facts.health?.explanation ?? []),
      ...(run.partial ? [t("Partial result: some files could not be parsed.")] : []),
    ];
    const tables: Table[] = [
      {
        title: t("Categories"), head: [t("Category"), t("Score"), t("Weight"), t("Findings"), t("Penalty")],
        rows: (facts.health?.categories ?? []).map((c: any) => [word(c.category, t), metric(c.score), metric(c.weight), String(c.findingCount), metric(c.penalty)]),
      },
      {
        title: t("Modules"), head: [t("Module"), "Loc", t("Health"), "Ca", "Ce", "I", "A", "D", t("Paradigms")],
        rows: facts.modules.map((m: any) => [m.id, String(m.loc), metric(m.health?.score), metric(m.metrics.ca), metric(m.metrics.ce), metric(m.metrics.instability), metric(m.metrics.abstractness), metric(m.metrics.distance), (m.activeParadigms ?? []).join(", ")]),
      },
      {
        title: t("Findings"), head: [t("Severity"), t("Confidence"), t("Rule"), t("Place"), t("Message")],
        rows: findings.slice(0, MaxFindings).map((f) => [word(f.severity, t), word(f.confidence, t), f.ruleId, `${f.file}:${f.line}`, text(f)]),
        note: findings.length > MaxFindings ? t("First {0} of {1}; all of them are in the SARIF file.", MaxFindings, findings.length) : undefined,
      },
      { title: t("Skipped rules"), head: [t("Reason"), t("Records")], rows: [...reasons].sort(([a], [b]) => ordinal(a, b)).map(([reason, n]) => [word(reason, t), String(n)]) },
    ];
    return { title: run.language, lines, tables };
  });
  if (comparison) {
    result.push({
      title: t("Compared with the baseline"),
      lines: [t("New: {0}. Gone: {1}. Unchanged: {2}.", comparison.added.length, comparison.removed.length, comparison.unchanged)],
      tables: [
        { title: t("New findings"), head: [t("Language"), t("Rule"), t("Place"), t("Message")], rows: sorted(comparison.added).map((f) => [f.language, f.ruleId, `${f.file}:${f.line}`, text(f)]) },
        // A gone finding is known only from the baseline, which keeps the English text.
        { title: t("Gone findings"), head: [t("Language"), t("Rule"), t("File"), t("Message")], rows: comparison.removed.map((f) => [f.language, f.ruleId, f.file, f.message]).sort((a, b) => ordinal(a.join("\0"), b.join("\0"))) },
      ],
    });
  }
  if (failures.length) result.push({ title: t("Analyzers that did not finish"), lines: failures.map((f) => `${f.language}: ${f.message}`), tables: [] });
  return result;
}

export function renderMarkdown(runs: Run[], failures: RunFailure[], comparison?: Comparison, t: Translate = translator("en")): string {
  const cell = (text: string) => text.replaceAll("|", "\\|").replaceAll("\n", " ");
  const out = [`# ${t("Nomos report")}`, ""];
  for (const section of sections(runs, failures, comparison, t)) {
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

export function renderHtml(runs: Run[], failures: RunFailure[], comparison?: Comparison, t: Translate = translator("en")): string {
  const body: string[] = [];
  for (const section of sections(runs, failures, comparison, t)) {
    body.push(`<h2>${escape(section.title)}</h2>`, ...section.lines.map((line) => `<p>${escape(line)}</p>`));
    for (const table of section.tables) {
      if (!table.rows.length) continue;
      body.push(`<h3>${escape(table.title)}</h3>`, "<table>", `<thead><tr>${table.head.map((h) => `<th>${escape(h)}</th>`).join("")}</tr></thead>`, "<tbody>");
      for (const row of table.rows) body.push(`<tr>${row.map((c) => `<td>${escape(c)}</td>`).join("")}</tr>`);
      body.push("</tbody>", "</table>", ...(table.note ? [`<p>${escape(table.note)}</p>`] : []));
    }
  }
  return `<!doctype html>
<html lang="${t.locale}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escape(t("Nomos report"))}</title>
<style>
body { font: 15px/1.5 system-ui, sans-serif; margin: 0 auto; max-width: 70rem; padding: 1rem; color: #1a1a1a; background: #fff; }
table { border-collapse: collapse; width: 100%; display: block; overflow-x: auto; }
th, td { border-bottom: 1px solid #ddd; padding: .25rem .5rem; text-align: left; vertical-align: top; }
@media (prefers-color-scheme: dark) { body { color: #e6e6e6; background: #181818; } th, td { border-color: #3a3a3a; } }
</style>
</head>
<body>
<h1>${escape(t("Nomos report"))}</h1>
${body.join("\n")}
</body>
</html>
`;
}
