import { ContractError } from "./contracts";
import type { Finding } from "./model";

const NoModule = "(no module)";

/** Flattens a SARIF log written by contracts/sarif-profile.md. A result without an explanation breaks the profile. */
export function readFindings(log: any, source: string): Finding[] {
  if (log?.version !== "2.1.0" || !Array.isArray(log.runs)) throw new ContractError(`${source}: not a SARIF 2.1.0 log`);
  const findings: Finding[] = [];
  for (const run of log.runs) {
    const rules = new Map<string, any>((run.tool?.driver?.rules ?? []).map((r: any) => [r.id, r]));
    for (const result of run.results ?? []) {
      const rule = rules.get(result.ruleId);
      const physical = result.locations?.[0]?.physicalLocation;
      const region = physical?.region ?? {};
      const properties = result.properties ?? {};
      if (!properties.confidence || !properties.explanation) throw new ContractError(`${source}: result of ${result.ruleId} has no confidence or explanation`);
      const startLine = region.startLine ?? 1;
      findings.push({
        ruleId: result.ruleId,
        ruleTitle: rule?.name ?? result.ruleId,
        category: rule?.properties?.category ?? "Other",
        level: result.level ?? "warning",
        severity: properties.severity ?? "minor",
        confidence: properties.confidence,
        message: result.message?.text ?? "",
        explanation: properties.explanation,
        file: physical?.artifactLocation?.uri ?? "",
        startLine,
        startColumn: region.startColumn ?? 1,
        endLine: region.endLine ?? startLine,
        endColumn: region.endColumn ?? (region.startColumn ?? 1) + 1,
        module: properties.module ?? NoModule,
        entity: properties.entity,
        measured: properties.measured,
      });
    }
  }
  return findings;
}
