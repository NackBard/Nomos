import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { practicesFile, repoRoot, rulesDir } from "./paths.ts";

export const goRulesPath = path.join(repoRoot, "analyzers", "go", "internal", "analyzer", "rules.json");
export const goPracticesPath = path.join(repoRoot, "analyzers", "go", "internal", "analyzer", "practices.json");
/** The extension lists the practices to choose from; it reads them as data (D-051). */
export const extensionPracticesPath = path.join(repoRoot, "extension", "practices.json");

/** spec/rules as JSON: go:embed cannot reach outside the module, and the analyzer has no YAML dependency (D-038). */
export function renderGoRules(): string {
  const rules = fs.readdirSync(rulesDir).filter((f) => f.endsWith(".yaml")).sort()
    .flatMap((file) => YAML.parse(fs.readFileSync(path.join(rulesDir, file), "utf8")).rules)
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return JSON.stringify(rules, null, 2) + "\n";
}

/** spec/practices.yaml as JSON, in catalog order: the order is how the extension lists them. */
export function renderPractices(): string {
  return JSON.stringify(YAML.parse(fs.readFileSync(practicesFile, "utf8")).practices, null, 2) + "\n";
}

/** Every file generated from spec, with its content; `npm run spec-json` writes them, `validate` compares. */
export function generatedFiles(): { file: string; content: string }[] {
  const practices = renderPractices();
  return [
    { file: goRulesPath, content: renderGoRules() },
    { file: goPracticesPath, content: practices },
    { file: extensionPracticesPath, content: practices },
  ];
}
