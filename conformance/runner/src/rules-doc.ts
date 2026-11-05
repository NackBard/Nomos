import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { practicesFile, repoRoot, rulesDir } from "./paths.ts";

export const rulesDocPath = path.join(repoRoot, "docs", "ANALYZERS.md");

function cell(text: string): string {
  return text.replaceAll("|", "\\|").replaceAll("\n", " ").trim();
}

/** Renders docs/ANALYZERS.md from spec/rules/*.yaml, the single source of truth for rules. */
export function renderRulesDoc(): string {
  const lines = [
    "# Каталог правил",
    "",
    "Файл сформирован из `spec/rules/*.yaml` и `spec/practices.yaml` командой `npm run rules-doc` (`conformance/runner`). Правки вносятся в spec; `npm run validate` проверяет, что файл не устарел.",
    "",
    "Любой результат — эвристика с уровнем уверенности и объяснением. Порог — чувствительность детектора, а не граница приёмки. Какие правила реализует анализатор, сообщает его `manifest`.",
    "",
    "Пустые парадигмы означают, что правило применимо к любому модулю. Названия и описания — из `l10n.ru` правил; шаблоны сообщений находок (`messages`) лежат в spec рядом с правилом (spec/l10n.md).",
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
    lines.push(`## ${category}`, "", "| Id | Название | English | Серьёзность | Парадигмы | Что смотрит | Порог по умолчанию |", "|---|---|---|---|---|---|---|");
    for (const rule of groups.get(category)!.sort((a, b) => (a.id < b.id ? -1 : 1))) {
      const threshold = Object.entries(rule.threshold).map(([k, v]) => `\`${k}\`=${JSON.stringify(v)}`).join(", ") || "—";
      const ru = rule.l10n?.ru ?? rule;
      lines.push(`| ${rule.id} | ${cell(ru.title)} | ${cell(rule.title)} | ${rule.severity} | ${rule.paradigms.join(", ") || "—"} | ${cell(ru.description)} | ${cell(threshold)} |`);
    }
    lines.push("");
  }
  const practices = YAML.parse(fs.readFileSync(practicesFile, "utf8")).practices as { id: string; title: string; description: string; rules: string[]; l10n?: { ru?: { title: string; description: string } } }[];
  lines.push(
    "## Практики",
    "",
    "Практика — набор правил, который можно выбрать: `practices` в `nomos.json` или команда «Nomos: Выбрать практики» (Choose Practices) в VS Code (D-051). Правила вне выбранных практик не запускаются и записываются в `skippedRules` как `disabled-by-config`; метрики выводятся всегда. Правило может входить в несколько практик.",
    "",
    "| Id | Название | English | Что смотрит | Правила |",
    "|---|---|---|---|---|",
    ...practices.map((p) => `| ${p.id} | ${cell(p.l10n?.ru?.title ?? p.title)} | ${cell(p.title)} | ${cell(p.l10n?.ru?.description ?? p.description)} | ${p.rules.join(", ")} |`),
    "",
  );
  return lines.join("\n");
}
