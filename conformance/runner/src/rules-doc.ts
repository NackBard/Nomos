import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { practicesFile, repoRoot, rulesDir } from "./paths.ts";

type Text = { title: string; description: string };
type Rule = Text & { id: string; category: string; severity: string; paradigms: string[]; threshold: Record<string, unknown>; l10n?: { ru?: Text } };
type Practice = Text & { id: string; rules: string[]; l10n?: { ru?: Text } };

function cell(text: string): string {
  return text.replaceAll("|", "\\|").replaceAll("\n", " ").trim();
}

function readRules(): Map<string, Rule[]> {
  const groups = new Map<string, Rule[]>();
  for (const file of fs.readdirSync(rulesDir).filter((f) => f.endsWith(".yaml")).sort()) {
    const document = YAML.parse(fs.readFileSync(path.join(rulesDir, file), "utf8"));
    for (const rule of document.rules as Rule[]) {
      const group = groups.get(rule.category) ?? [];
      group.push(rule);
      groups.set(rule.category, group);
    }
  }
  return groups;
}

const thresholdOf = (rule: Rule) => Object.entries(rule.threshold).map(([k, v]) => `\`${k}\`=${JSON.stringify(v)}`).join(", ") || "—";

/** The catalog in English, from the English texts of spec/rules/*.yaml (D-068). */
function renderEnglish(groups: Map<string, Rule[]>, practices: Practice[]): string[] {
  const lines = [
    "# Rule catalog",
    "",
    "**English** · [Русский](ANALYZERS.ru.md)",
    "",
    "Generated from `spec/rules/*.yaml` and `spec/practices.yaml` by `npm run rules-doc` (`conformance/runner`). Change the spec, not this file; `npm run validate` checks that the file is up to date.",
    "",
    "Every result is a heuristic with a confidence level and an explanation. A threshold is the sensitivity of a detector, not an acceptance limit. Which rules an analyzer implements is stated in its `manifest`.",
    "",
    "Empty paradigms mean the rule applies to any module. The templates of finding messages (`messages`) are in the spec next to each rule (spec/l10n.md).",
    "",
  ];
  for (const category of [...groups.keys()].sort()) {
    lines.push(`## ${category}`, "", "| Id | Title | Severity | Paradigms | What it looks at | Default threshold |", "|---|---|---|---|---|---|");
    for (const rule of groups.get(category)!) {
      lines.push(`| ${rule.id} | ${cell(rule.title)} | ${rule.severity} | ${rule.paradigms.join(", ") || "—"} | ${cell(rule.description)} | ${cell(thresholdOf(rule))} |`);
    }
    lines.push("");
  }
  lines.push(
    "## Practices",
    "",
    "A practice is a set of rules you can choose: `practices` in `nomos.json` or the **Nomos: Choose Practices** command in VS Code (D-051). Rules outside the chosen practices do not run and are recorded in `skippedRules` as `disabled-by-config`; metrics are always reported. A rule can belong to several practices.",
    "",
    "| Id | Title | What it looks at | Rules |",
    "|---|---|---|---|",
    ...practices.map((p) => `| ${p.id} | ${cell(p.title)} | ${cell(p.description)} | ${p.rules.join(", ")} |`),
    "",
  );
  return lines;
}

/** The catalog in Russian, from `l10n.ru` of the rules, with the English title next to it. */
function renderRussian(groups: Map<string, Rule[]>, practices: Practice[]): string[] {
  const lines = [
    "# Каталог правил",
    "",
    "[English](ANALYZERS.md) · **Русский**",
    "",
    "Файл сформирован из `spec/rules/*.yaml` и `spec/practices.yaml` командой `npm run rules-doc` (`conformance/runner`). Правки вносятся в spec; `npm run validate` проверяет, что файл не устарел.",
    "",
    "Любой результат — эвристика с уровнем уверенности и объяснением. Порог — чувствительность детектора, а не граница приёмки. Какие правила реализует анализатор, сообщает его `manifest`.",
    "",
    "Пустые парадигмы означают, что правило применимо к любому модулю. Названия и описания — из `l10n.ru` правил; шаблоны сообщений находок (`messages`) лежат в spec рядом с правилом (spec/l10n.md).",
    "",
  ];
  for (const category of [...groups.keys()].sort()) {
    lines.push(`## ${category}`, "", "| Id | Название | English | Серьёзность | Парадигмы | Что смотрит | Порог по умолчанию |", "|---|---|---|---|---|---|---|");
    for (const rule of groups.get(category)!) {
      const ru = rule.l10n?.ru ?? rule;
      lines.push(`| ${rule.id} | ${cell(ru.title)} | ${cell(rule.title)} | ${rule.severity} | ${rule.paradigms.join(", ") || "—"} | ${cell(ru.description)} | ${cell(thresholdOf(rule))} |`);
    }
    lines.push("");
  }
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
  return lines;
}

/** Renders docs/ANALYZERS.md and docs/ANALYZERS.ru.md from spec/rules/*.yaml, the single source of truth for rules. */
export function renderRulesDocs(): { file: string; content: string }[] {
  const groups = readRules();
  for (const group of groups.values()) group.sort((a, b) => (a.id < b.id ? -1 : 1));
  const practices = YAML.parse(fs.readFileSync(practicesFile, "utf8")).practices as Practice[];
  return [
    { file: path.join(repoRoot, "docs", "ANALYZERS.md"), content: renderEnglish(groups, practices).join("\n") },
    { file: path.join(repoRoot, "docs", "ANALYZERS.ru.md"), content: renderRussian(groups, practices).join("\n") },
  ];
}
