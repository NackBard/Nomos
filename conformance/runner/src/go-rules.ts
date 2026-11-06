import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { practicesFile, repoRoot, rulesDir } from "./paths.ts";

export const goRulesPath = path.join(repoRoot, "analyzers", "go", "internal", "analyzer", "rules.json");
export const goPracticesPath = path.join(repoRoot, "analyzers", "go", "internal", "analyzer", "practices.json");
/** The TypeScript analyzer reads the same JSON: it has no YAML dependency either (D-055). */
export const typescriptRulesPath = path.join(repoRoot, "analyzers", "typescript", "src", "rules.json");
export const typescriptPracticesPath = path.join(repoRoot, "analyzers", "typescript", "src", "practices.json");
/** The Python analyzer reads them with json from the standard library (D-057). */
export const pythonRulesPath = path.join(repoRoot, "analyzers", "python", "nomos_python", "rules.json");
export const pythonPracticesPath = path.join(repoRoot, "analyzers", "python", "nomos_python", "practices.json");
/** The Java analyzer reads them as resources of its jar with its own JSON reader (D-058). */
export const javaRulesPath = path.join(repoRoot, "analyzers", "java", "src", "nomos", "java", "rules.json");
export const javaPracticesPath = path.join(repoRoot, "analyzers", "java", "src", "nomos", "java", "practices.json");
/** The Kotlin analyzer reads them as resources of its jar with its own JSON reader (D-059). */
export const kotlinRulesPath = path.join(repoRoot, "analyzers", "kotlin", "src", "nomos", "kotlin", "rules.json");
export const kotlinPracticesPath = path.join(repoRoot, "analyzers", "kotlin", "src", "nomos", "kotlin", "practices.json");
/** The extension lists the practices to choose from; it reads them as data (D-051). */
export const extensionPracticesPath = path.join(repoRoot, "extension", "practices.json");
/** The extension and ci show rule texts and finding templates in the interface language (spec/l10n.md, D-052). */
export const extensionRulesPath = path.join(repoRoot, "extension", "rules.json");
export const ciRulesPath = path.join(repoRoot, "ci", "rules.json");

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
  const rules = renderGoRules();
  return [
    { file: goRulesPath, content: rules },
    { file: extensionRulesPath, content: rules },
    { file: ciRulesPath, content: rules },
    { file: typescriptRulesPath, content: rules },
    { file: pythonRulesPath, content: rules },
    { file: javaRulesPath, content: rules },
    { file: kotlinRulesPath, content: rules },
    { file: goPracticesPath, content: practices },
    { file: extensionPracticesPath, content: practices },
    { file: typescriptPracticesPath, content: practices },
    { file: pythonPracticesPath, content: practices },
    { file: javaPracticesPath, content: practices },
    { file: kotlinPracticesPath, content: practices },
  ];
}
