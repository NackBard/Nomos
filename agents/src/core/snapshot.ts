// A snapshot folder holds the result of one analysis: <language>.facts.json with <language>.findings.json
// (written by the agents extension from the core) or <language>.sarif (written by nomos-ci). The MCP server reads it
// on every call, so it always sees the last analysis.
import fs from "node:fs";
import path from "node:path";
import type { Facts, Finding, LanguageRun, PracticeText, RuleText, Snapshot } from "./model";

export const SnapshotFileName = "snapshot.json";
const FactsSuffix = ".facts.json";
const FindingsSuffix = ".findings.json";
const SarifSuffix = ".sarif";
const RulesFileName = "rules.json";
const PracticesFileName = "practices.json";

export class SnapshotError extends Error {}

function readJson(file: string): any {
  // A file written by PowerShell redirection starts with a byte order mark.
  return JSON.parse(fs.readFileSync(file, "utf8").replace(/^﻿/, ""));
}

/** Flattens a SARIF log of contracts/sarif-profile.md into findings. */
export function flattenSarif(log: any): Finding[] {
  const findings: Finding[] = [];
  for (const run of log?.runs ?? []) {
    const rules = new Map<string, any>((run.tool?.driver?.rules ?? []).map((r: any) => [r.id, r]));
    for (const result of run.results ?? []) {
      const rule = rules.get(result.ruleId);
      const physical = result.locations?.[0]?.physicalLocation;
      const region = physical?.region ?? {};
      const properties = result.properties ?? {};
      const startLine = region.startLine ?? 1;
      findings.push({
        ruleId: result.ruleId,
        ruleTitle: rule?.name ?? result.ruleId,
        category: rule?.properties?.category ?? "Other",
        level: result.level ?? "warning",
        confidence: properties.confidence ?? "low",
        message: result.message?.text ?? "",
        explanation: properties.explanation ?? "",
        file: physical?.artifactLocation?.uri ?? "",
        startLine,
        endLine: region.endLine ?? startLine,
        module: properties.module ?? "",
        entity: properties.entity,
        measured: properties.measured,
      });
    }
  }
  return findings;
}

/** Reads a snapshot folder; `root` overrides the root written in snapshot.json. */
export function readSnapshot(folder: string, root?: string): Snapshot {
  if (!fs.existsSync(folder)) throw new SnapshotError(`no analysis result in ${folder}: run the Nomos analysis first (VS Code, or nomos-ci --out ${folder})`);
  const names = fs.readdirSync(folder).sort();
  const factsFiles = names.filter((n) => n.endsWith(FactsSuffix));
  if (!factsFiles.length) throw new SnapshotError(`no *${FactsSuffix} in ${folder}: run the Nomos analysis first`);
  const info = names.includes(SnapshotFileName) ? readJson(path.join(folder, SnapshotFileName)) : {};
  const runs: LanguageRun[] = factsFiles.map((name) => {
    const language = name.slice(0, -FactsSuffix.length);
    const facts = readJson(path.join(folder, name)) as Facts;
    const findingsFile = path.join(folder, language + FindingsSuffix);
    const sarifFile = path.join(folder, language + SarifSuffix);
    const findings = fs.existsSync(findingsFile) ? (readJson(findingsFile) as Finding[])
      : fs.existsSync(sarifFile) ? flattenSarif(readJson(sarifFile)) : [];
    return { language, facts, findings };
  });
  const optional = <T>(file: string): T[] => (names.includes(file) ? readJson(path.join(folder, file)) : []);
  return {
    root: path.resolve(root ?? info.root ?? path.dirname(path.resolve(folder))),
    runs,
    rules: optional<RuleText>(RulesFileName),
    practices: optional<PracticeText>(PracticesFileName),
  };
}

/** Writes a snapshot folder, replacing the languages of an earlier one. */
export function writeSnapshot(folder: string, snapshot: Snapshot): void {
  fs.mkdirSync(folder, { recursive: true });
  for (const name of fs.readdirSync(folder)) {
    if (name.endsWith(FactsSuffix) || name.endsWith(FindingsSuffix)) fs.rmSync(path.join(folder, name), { force: true });
  }
  const write = (name: string, value: unknown) => fs.writeFileSync(path.join(folder, name), JSON.stringify(value) + "\n");
  write(SnapshotFileName, { root: snapshot.root });
  for (const run of snapshot.runs) {
    write(run.language + FactsSuffix, run.facts);
    write(run.language + FindingsSuffix, run.findings);
  }
  if (snapshot.rules.length) write(RulesFileName, snapshot.rules);
  if (snapshot.practices.length) write(PracticesFileName, snapshot.practices);
}
