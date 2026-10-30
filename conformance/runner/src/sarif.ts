// Checks a SARIF file against contracts/sarif-profile.md. The official SARIF 2.1.0 schema is not bundled
// (the repository has no copy and the harness must work offline), so only the profile rules are verified.

const LEVELS: Record<string, string> = { info: "note", minor: "warning", major: "warning", critical: "error" };
const CONFIDENCES = new Set(["low", "medium", "high"]);

const ordinal = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

export interface SarifContext {
  manifest: { name: string; version: string; capabilities: { supportedRules: string[] } };
  /** Entity ids present in the facts of the same run (types and functions). */
  entities: Set<string>;
  /** The value passed after --sarif and reported in facts.checks.sarifFile. */
  sarifPath: string;
  facts: any;
  expected?: { results: { ruleId: string; file: string; startLine: number }[] };
}

export function checkSarif(text: string, context: SarifContext): string[] {
  const errors: string[] = [];
  let log: any;
  try {
    log = JSON.parse(text);
  } catch (e) {
    return [`SARIF is not JSON: ${(e as Error).message}`];
  }
  if (log.version !== "2.1.0") errors.push(`version is ${JSON.stringify(log.version)}, expected "2.1.0"`);
  if (!Array.isArray(log.runs) || log.runs.length !== 1) return [...errors, "runs must contain exactly one run"];
  const run = log.runs[0];
  const driver = run.tool?.driver ?? {};
  if (driver.name !== context.manifest.name) errors.push(`driver.name is ${JSON.stringify(driver.name)}, manifest name is ${JSON.stringify(context.manifest.name)}`);
  if (driver.version !== context.manifest.version) errors.push(`driver.version is ${JSON.stringify(driver.version)}, manifest version is ${JSON.stringify(context.manifest.version)}`);

  const rules: any[] = driver.rules ?? [];
  const ruleIds = new Set<string>(rules.map((r) => r.id));
  for (const id of context.manifest.capabilities.supportedRules) if (!ruleIds.has(id)) errors.push(`rules: ${id} is in supportedRules but missing from driver.rules`);
  for (const rule of rules) {
    const where = `rule ${rule.id}`;
    if (!rule.name) errors.push(`${where}: name is missing`);
    if (!rule.shortDescription?.text) errors.push(`${where}: shortDescription.text is missing`);
    if (!rule.fullDescription?.text) errors.push(`${where}: fullDescription.text is missing`);
    if (!["note", "warning", "error"].includes(rule.defaultConfiguration?.level)) errors.push(`${where}: defaultConfiguration.level is invalid`);
    if (!rule.properties?.category) errors.push(`${where}: properties.category is missing`);
    if (!Array.isArray(rule.properties?.paradigms)) errors.push(`${where}: properties.paradigms must be an array`);
  }

  const results: any[] = run.results ?? [];
  let previous: string | undefined;
  for (const [index, result] of results.entries()) {
    const where = `result #${index} (${result.ruleId})`;
    if (!ruleIds.has(result.ruleId)) errors.push(`${where}: ruleId is not in driver.rules`);
    else if (rules[result.ruleIndex]?.id !== result.ruleId) errors.push(`${where}: ruleIndex ${result.ruleIndex} does not point at the rule`);
    const properties = result.properties ?? {};
    if (!(properties.severity in LEVELS)) errors.push(`${where}: properties.severity ${JSON.stringify(properties.severity)} is invalid`);
    else if (result.level !== LEVELS[properties.severity]) errors.push(`${where}: level is ${result.level}, severity ${properties.severity} requires ${LEVELS[properties.severity]}`);
    if (!result.message?.text) errors.push(`${where}: message.text is missing`);
    if (!CONFIDENCES.has(properties.confidence)) errors.push(`${where}: properties.confidence ${JSON.stringify(properties.confidence)} must be low, medium or high`);
    if (typeof properties.explanation !== "string" || properties.explanation.trim() === "") errors.push(`${where}: properties.explanation is empty (every result is a heuristic and must explain itself)`);
    if (!result.partialFingerprints?.["nomos/v1"]) errors.push(`${where}: partialFingerprints["nomos/v1"] is missing`);
    if (properties.entity !== undefined && !context.entities.has(properties.entity)) errors.push(`${where}: properties.entity ${JSON.stringify(properties.entity)} is not an entity of the facts`);

    const physical = result.locations?.[0]?.physicalLocation;
    const uri: string = physical?.artifactLocation?.uri ?? "";
    const line: number = physical?.region?.startLine;
    if (!uri || uri.includes("\\") || uri.startsWith("/") || /^[A-Za-z]:/.test(uri)) errors.push(`${where}: uri ${JSON.stringify(uri)} must be relative with forward slashes`);
    if (!Number.isInteger(line) || line < 1) errors.push(`${where}: region.startLine is missing`);

    const key = [uri, String(line ?? 0).padStart(9, "0"), String(physical?.region?.startColumn ?? 0).padStart(9, "0"), result.ruleId, result.message?.text ?? ""].join("\0");
    if (previous !== undefined && ordinal(previous, key) > 0) errors.push(`${where}: results are not sorted by (uri, startLine, startColumn, ruleId, message)`);
    previous = key;
  }

  // A drive letter must not follow another letter, otherwise the "s:/" of "https://" would match.
  if (/(^|[^A-Za-z])[A-Za-z]:[\\/]|\\\\/.test(text.replace(/"snippet":\s*\{[^}]*\}/g, ""))) errors.push("the file contains an absolute path");
  if (context.facts.checks?.sarifFile !== context.sarifPath) errors.push(`facts.checks.sarifFile is ${JSON.stringify(context.facts.checks?.sarifFile)}, expected ${JSON.stringify(context.sarifPath)}`);
  if (context.facts.checks?.resultCount !== results.length) errors.push(`facts.checks.resultCount is ${context.facts.checks?.resultCount}, the file has ${results.length} results`);

  if (context.expected) {
    const actual = new Set(results.map((r) => `${r.ruleId} ${r.locations?.[0]?.physicalLocation?.artifactLocation?.uri}:${r.locations?.[0]?.physicalLocation?.region?.startLine}`));
    const expected = new Set(context.expected.results.map((r) => `${r.ruleId} ${r.file}:${r.startLine}`));
    for (const x of [...expected].sort()) if (!actual.has(x)) errors.push(`result ${x}: expected but not reported`);
    for (const x of [...actual].sort()) if (!expected.has(x)) errors.push(`result ${x}: reported but not expected`);
  }
  return errors;
}
