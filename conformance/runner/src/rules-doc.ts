import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { repoRoot, rulesDir } from "./paths.ts";

export const rulesDocPath = path.join(repoRoot, "docs", "ANALYZERS.md");

function cell(text: string): string {
  return text.replaceAll("|", "\\|").replaceAll("\n", " ").trim();
}

/** Renders docs/ANALYZERS.md from spec/rules/*.yaml, the single source of truth for rules. */
export function renderRulesDoc(): string {
  const lines = [
    "# Каталог правил",
    "",
    "Файл сформирован из `spec/rules/*.yaml` командой `npm run rules-doc` (`conformance/runner`). Правки вносятся в spec; `npm run validate` проверяет, что файл не устарел.",
    "",
    "Любой результат — эвристика с уровнем уверенности и объяснением. Порог — чувствительность детектора, а не граница приёмки. Какие правила реализует анализатор, сообщает его `manifest`.",
    "",
    "Пустые парадигмы означают, что правило применимо к любому модулю.",
    "",
  ];
  const groups = new Map<string, any[]>();
  for (const file of fs.readdirSync(rulesDir).filter((f) => f.endsWith(".yaml")).sort()) {
    const document = YAML.parse(fs.readFileSync(path.join(rulesDir, file), "utf8"));
    for (const rule of document.rules) {
      const group = groups.get(rule.category) ?? [];
      group.push(rule);
      groups.set(rule.category, group);
    }
  }
  for (const category of [...groups.keys()].sort()) {
    lines.push(`## ${category}`, "", "| Id | Название | Серьёзность | Парадигмы | Что смотрит | Порог по умолчанию |", "|---|---|---|---|---|---|");
    for (const rule of groups.get(category)!.sort((a, b) => (a.id < b.id ? -1 : 1))) {
      const threshold = Object.entries(rule.threshold).map(([k, v]) => `\`${k}\`=${JSON.stringify(v)}`).join(", ") || "—";
      lines.push(`| ${rule.id} | ${cell(rule.title)} | ${rule.severity} | ${rule.paradigms.join(", ") || "—"} | ${cell(rule.description)} | ${cell(threshold)} |`);
    }
    lines.push("");
  }
  return lines.join("\n");
}
