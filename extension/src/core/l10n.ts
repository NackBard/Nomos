import fs from "node:fs";
import { parseJson } from "./contracts";
import type { Finding, SkippedRule } from "./model";

/** Languages Nomos shows (D-052): Russian when VS Code is Russian, English otherwise. */
export type Locale = "en" | "ru";

export function localeOf(language: string | undefined): Locale {
  return language?.toLowerCase().startsWith("ru") ? "ru" : "en";
}

export type Arg = string | number;

/**
 * Looks up a string of the interface (l10n/bundle.l10n.<locale>.json, keyed by the English text) and fills it in.
 * `template` returns the translation without filling it, for the graph page that fills it itself.
 */
export interface Translate {
  (message: string, ...args: Arg[]): string;
  template(message: string): string;
  readonly locale: Locale;
}

/** Bundle entries are a string or { message, comment }, as vscode.l10n reads them. */
type Bundle = Record<string, string | { message: string }>;

export function translator(bundle: Bundle | undefined, locale: Locale): Translate {
  const template = (message: string) => {
    const entry = locale === "en" ? undefined : bundle?.[message];
    return typeof entry === "string" ? entry : entry?.message ?? message;
  };
  const t = ((message: string, ...args: Arg[]) => format(template(message), args.map(String))) as Translate;
  return Object.assign(t, { template, locale });
}

/** English, the language the strings are written in. */
export const english: Translate = translator(undefined, "en");

export function readBundle(file: string): Bundle | undefined {
  return fs.existsSync(file) ? (parseJson(fs.readFileSync(file, "utf8"), file) as Bundle) : undefined;
}

const HOLE = /\{\{|\}\}|\{(\d+)(?:\|([^{}]*))?\}/g;

/** Russian plural category of a number: 1, 21 → one; 2–4, 22 → few; others → many; fractions → few. */
export function russianForm(value: number): 0 | 1 | 2 {
  if (!Number.isInteger(value)) return 1;
  const n = Math.abs(value) % 100;
  if (n % 10 === 1 && n !== 11) return 0;
  if (n % 10 >= 2 && n % 10 <= 4 && (n < 12 || n > 14)) return 1;
  return 2;
}

/** Fills a template of spec/l10n.md: {n} is argument n, {n|one|few|many} a word form for the number in argument n. */
export function format(template: string, args: readonly string[]): string {
  return template.replace(HOLE, (whole: string, index: string | undefined, forms: string | undefined) => {
    if (whole === "{{") return "{";
    if (whole === "}}") return "}";
    const value = args[Number(index)];
    if (value === undefined) return whole;
    return forms === undefined ? value : forms.split("|")[russianForm(Number(value))] ?? "";
  });
}

/** A rule of spec/rules as rules.json carries it (npm run spec-json, D-052). */
export interface CatalogRule {
  id: string;
  title: string;
  paradigms?: string[];
  requires?: string[];
  l10n?: Partial<Record<Locale, { title: string; description: string; rationale: string }>>;
  messages?: Record<string, { text: string } & Partial<Record<Locale, string>>>;
}

export const RulesFileName = "rules.json";

export function readRules(file: string): Map<string, CatalogRule> {
  if (!fs.existsSync(file)) return new Map();
  const rules = parseJson(fs.readFileSync(file, "utf8"), file);
  if (!Array.isArray(rules)) throw new Error(`${file}: expected an array of rules`);
  return new Map((rules as CatalogRule[]).map((r) => [r.id, r]));
}

/** A text of a finding in the locale: the template of its id with its arguments, or the analyzer's English text. */
function localText(rule: CatalogRule | undefined, id: string | undefined, args: string[] | undefined, locale: Locale, fallback: string): string {
  if (locale === "en" || !id || !args) return fallback;
  const template = rule?.messages?.[id]?.[locale];
  return template ? format(template, args) : fallback;
}

/** The finding as the interface shows it: rule title, message and explanation in the locale when spec has them. */
export function localizeFinding(finding: Finding, rules: Map<string, CatalogRule>, locale: Locale): Finding {
  if (locale === "en") return finding;
  const rule = rules.get(finding.ruleId);
  return {
    ...finding,
    ruleTitle: rule?.l10n?.[locale]?.title ?? finding.ruleTitle,
    message: localText(rule, finding.messageId, finding.messageArguments, locale, finding.message),
    explanation: localText(rule, finding.explanationId, finding.explanationArguments, locale, finding.explanation),
  };
}

/** Title of a rule in the locale; undefined when neither the catalog nor the fallback knows it. */
export function ruleTitle(id: string, rules: Map<string, CatalogRule>, locale: Locale, fallback?: string): string | undefined {
  const rule = rules.get(id);
  return (locale === "en" ? undefined : rule?.l10n?.[locale]?.title) ?? fallback ?? rule?.title;
}

/** Names of the paradigms of spec/paradigms.md; another id shows as it is. */
export function paradigmName(id: string, t: Translate): string {
  // English keeps the ids, as the interface showed them before translation.
  if (t.locale === "en") return id;
  const names: Record<string, string> = { oop: t("object-oriented"), functional: t("functional"), structural: t("structural") };
  return names[id] ?? id;
}

/** Names of external inputs of spec/rules (`requires`). */
function inputName(id: string, t: Translate): string {
  const names: Record<string, string> = { "coverage-report": t("coverage report"), "layer-config": t("layer configuration") };
  return names[id] ?? id;
}

/**
 * Why rules were skipped, said by the reason code of the facts contract (D-052). In English the analyzer's own message
 * stays; in another locale the code is translated, with the practices or inputs the extension knows, and the
 * analyzer's message remains the detail.
 */
export function describeSkip(skip: SkippedRule, rules: Map<string, CatalogRule>, t: Translate, unchosenPractices?: string[]): string {
  if (t.locale === "en") return skip.message;
  const rule = rules.get(skip.ruleId);
  switch (skip.reason) {
    case "paradigm-not-detected":
      return t("Rule not applied: the module shows no sign of the {0} paradigm", paradigmName(rule?.paradigms?.[0] ?? "", t));
    case "not-supported":
      return t("Rule is not implemented for this language");
    case "disabled-by-config":
      return unchosenPractices?.length ? t("Rule belongs to practices that are not chosen: {0}", unchosenPractices.join(", "))
        : t("Rule is off by the configuration: paradigms, rules or --rules");
    case "needs-semantic-model":
      return t("Rule needs resolved symbols, which this analysis does not have");
    case "missing-input":
      return t("Rule not applied: no {0} in the configuration", (rule?.requires ?? []).map((i) => inputName(i, t)).join(", "));
    case "error":
      return t("Rule failed: {0}", skip.message);
    default:
      return skip.message;
  }
}
