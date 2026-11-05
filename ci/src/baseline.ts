// Comparison with a previous run by the nomos/v1 fingerprint (contracts/sarif-profile.md). It says what changed;
// it does not judge whether the change is acceptable.
import type { Run } from "./run.ts";

export interface Finding {
  language: string;
  fingerprint: string;
  ruleId: string;
  category: string;
  severity: string;
  confidence: string;
  message: string;
  explanation: string;
  file: string;
  line: number;
  module?: string;
  /** message.id and message.arguments of SARIF, for a report in another language (D-052); not part of the baseline. */
  template?: { id?: string; arguments?: string[] };
}

export interface Baseline {
  baselineVersion: 1;
  findings: { language: string; fingerprint: string; ruleId: string; message: string; file: string }[];
}

export interface Comparison {
  added: Finding[];
  removed: Baseline["findings"];
  unchanged: number;
}

const ordinal = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

export function findingsOf(run: Run): Finding[] {
  const log = run.sarif.runs[0];
  const rules: any[] = log.tool.driver.rules ?? [];
  return (log.results ?? []).map((result: any): Finding => {
    const place = result.locations?.[0]?.physicalLocation;
    return {
      language: run.language,
      fingerprint: result.partialFingerprints["nomos/v1"],
      ruleId: result.ruleId,
      category: rules[result.ruleIndex]?.properties?.category ?? "",
      severity: result.properties.severity,
      confidence: result.properties.confidence,
      message: result.message.text,
      explanation: result.properties.explanation,
      file: place?.artifactLocation?.uri ?? "",
      line: place?.region?.startLine ?? 0,
      module: result.properties.module,
      template: { id: result.message.id, arguments: result.message.arguments },
    };
  });
}

export function toBaseline(findings: Finding[]): Baseline {
  const entries = findings.map(({ language, fingerprint, ruleId, message, file }) => ({ language, fingerprint, ruleId, message, file }));
  entries.sort((a, b) => ordinal(a.language, b.language) || ordinal(a.file, b.file) || ordinal(a.fingerprint, b.fingerprint));
  return { baselineVersion: 1, findings: entries };
}

/** Compares as multisets: two equal findings in a file have one fingerprint, and removing one of them is a change. */
export function compare(findings: Finding[], baseline: Baseline): Comparison {
  const key = (x: { language: string; fingerprint: string }) => `${x.language}\0${x.fingerprint}`;
  const before = new Map<string, Baseline["findings"]>();
  for (const entry of baseline.findings) before.set(key(entry), [...(before.get(key(entry)) ?? []), entry]);
  const added: Finding[] = [];
  let unchanged = 0;
  for (const finding of findings) {
    const left = before.get(key(finding));
    if (left?.length) {
      left.pop();
      unchanged++;
    } else {
      added.push(finding);
    }
  }
  return { added, removed: [...before.values()].flat(), unchanged };
}
