// Language of the reports (--locale, D-052): English by default. Strings are looked up in l10n/bundle.l10n.<locale>.json
// by their English text; finding texts come from the templates of spec/rules in rules.json (npm run spec-json).
// The same template syntax as the extension: {n}, and {n|one|few|many} for Russian word forms (spec/l10n.md).
import fs from "node:fs";
import path from "node:path";

export type Locale = "en" | "ru";
export type Arg = string | number;
export interface Translate { (message: string, ...args: Arg[]): string; readonly locale: Locale }

const packageRoot = path.resolve(import.meta.dirname, "..");
const HOLE = /\{\{|\}\}|\{(\d+)(?:\|([^{}]*))?\}/g;

function russianForm(value: number): number {
  if (!Number.isInteger(value)) return 1;
  const n = Math.abs(value) % 100;
  if (n % 10 === 1 && n !== 11) return 0;
  if (n % 10 >= 2 && n % 10 <= 4 && (n < 12 || n > 14)) return 1;
  return 2;
}

export function format(template: string, args: readonly string[]): string {
  return template.replace(HOLE, (whole: string, index: string | undefined, forms: string | undefined) => {
    if (whole === "{{") return "{";
    if (whole === "}}") return "}";
    const value = args[Number(index)];
    if (value === undefined) return whole;
    return forms === undefined ? value : forms.split("|")[russianForm(Number(value))] ?? "";
  });
}

export function isLocale(value: string): value is Locale {
  return value === "en" || value === "ru";
}

export function translator(locale: Locale): Translate {
  const file = path.join(packageRoot, "l10n", `bundle.l10n.${locale}.json`);
  const bundle: Record<string, string> = locale !== "en" && fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : {};
  const t = (message: string, ...args: Arg[]) => format(bundle[message] ?? message, args.map(String));
  return Object.assign(t, { locale });
}

interface CatalogRule { id: string; l10n?: Record<string, { title: string }>; messages?: Record<string, Record<string, string>> }

let rules: Map<string, CatalogRule> | undefined;

function catalog(): Map<string, CatalogRule> {
  if (!rules) {
    const file = path.join(packageRoot, "rules.json");
    const list: CatalogRule[] = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : [];
    rules = new Map(list.map((r) => [r.id, r]));
  }
  return rules;
}

/** A text of a finding in the locale: the template of its key with its arguments, or the analyzer's English text. */
export function findingText(ruleId: string, message: { id?: string; arguments?: string[] } | undefined, fallback: string, locale: Locale): string {
  if (locale === "en" || !message?.id || !Array.isArray(message.arguments)) return fallback;
  const template = catalog().get(ruleId)?.messages?.[message.id]?.[locale];
  return template ? format(template, message.arguments.map(String)) : fallback;
}
