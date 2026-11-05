// nomos-ci: runs the analyzers of a workspace without an IDE and writes facts, SARIF and reports.
// The exit code never depends on findings or on the score (D-021): 0 means the reports are complete.
import fs from "node:fs";
import path from "node:path";
import type { Baseline } from "./baseline.ts";
import { compare, findingsOf, toBaseline } from "./baseline.ts";
import { isLocale, translator } from "./l10n.ts";
import { renderHtml, renderMarkdown } from "./report.ts";
import { runWorkspace } from "./run.ts";

const usage = "Usage: nomos-ci [--workspace nomos.json] [--out .nomos] [--baseline <file>] [--write-baseline <file>] [--locale en|ru]";

function parse(args: string[]): Record<string, string> | undefined {
  const options: Record<string, string> = { workspace: "nomos.json", out: ".nomos", locale: "en" };
  for (let i = 0; i < args.length; i += 2) {
    const name = args[i].replace(/^--/, "");
    if (!args[i].startsWith("--") || !["workspace", "out", "baseline", "write-baseline", "locale"].includes(name) || args[i + 1] === undefined) return undefined;
    options[name] = args[i + 1];
  }
  return options;
}

export function main(args: string[]): number {
  const options = parse(args);
  if (!options || !isLocale(options.locale)) {
    console.error(usage);
    return 2;
  }
  // Only the reports change with the locale; facts, SARIF, the baseline and the exit code do not (D-052).
  const t = translator(options.locale);
  if (!fs.existsSync(options.workspace)) {
    console.error(`error: workspace file not found: ${options.workspace}`);
    return 3;
  }
  const { runs, failures } = runWorkspace(options.workspace, options.out);
  const findings = runs.flatMap(findingsOf);
  const comparison = options.baseline && fs.existsSync(options.baseline)
    ? compare(findings, JSON.parse(fs.readFileSync(options.baseline, "utf8")) as Baseline)
    : undefined;
  if (options.baseline && !comparison) console.error(`note: no baseline at ${options.baseline}, nothing to compare with`);

  fs.writeFileSync(path.join(options.out, "report.md"), renderMarkdown(runs, failures, comparison, t));
  fs.writeFileSync(path.join(options.out, "report.html"), renderHtml(runs, failures, comparison, t));
  if (comparison) fs.writeFileSync(path.join(options.out, "diff.json"), JSON.stringify(comparison, null, 2) + "\n");
  if (options["write-baseline"]) fs.writeFileSync(options["write-baseline"], JSON.stringify(toBaseline(findings), null, 2) + "\n");

  for (const run of runs) console.log(`${run.language}: health ${run.facts.health?.score ?? "-"}, ${findingsOf(run).length} findings${run.partial ? " (partial)" : ""}`);
  if (comparison) console.log(`baseline: ${comparison.added.length} new, ${comparison.removed.length} gone, ${comparison.unchanged} unchanged`);
  for (const failure of failures) console.error(`error: ${failure.language}: ${failure.message}`);
  return failures.length ? 1 : 0;
}

process.exitCode = main(process.argv.slice(2));
