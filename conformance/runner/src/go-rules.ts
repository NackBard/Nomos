import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { repoRoot, rulesDir } from "./paths.ts";

export const goRulesPath = path.join(repoRoot, "analyzers", "go", "internal", "analyzer", "rules.json");

/** spec/rules as JSON: go:embed cannot reach outside the module, and the analyzer has no YAML dependency (D-038). */
export function renderGoRules(): string {
  const rules = fs.readdirSync(rulesDir).filter((f) => f.endsWith(".yaml")).sort()
    .flatMap((file) => YAML.parse(fs.readFileSync(path.join(rulesDir, file), "utf8")).rules)
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return JSON.stringify(rules, null, 2) + "\n";
}
