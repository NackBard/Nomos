// Strings of the interface in the language of VS Code (D-052), as the core does it (extension/src/core/l10n.ts):
// the bundle is keyed by the English text; the page fills {n} and {n|one|few|many} itself.

export type Locale = "en" | "ru";

export function localeOf(language: string | undefined): Locale {
  return language?.toLowerCase().startsWith("ru") ? "ru" : "en";
}

export type Arg = string | number;

export interface Translate {
  (message: string, ...args: Arg[]): string;
  template(message: string): string;
  readonly locale: Locale;
}

type Bundle = Record<string, string | { message: string }>;

export function translator(bundle: Bundle | undefined, locale: Locale): Translate {
  const template = (message: string) => {
    const entry = locale === "en" ? undefined : bundle?.[message];
    return typeof entry === "string" ? entry : entry?.message ?? message;
  };
  const t = ((message: string, ...args: Arg[]) => format(template(message), args.map(String))) as Translate;
  return Object.assign(t, { template, locale });
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

export function format(template: string, args: readonly string[]): string {
  return template.replace(HOLE, (whole: string, index: string | undefined, forms: string | undefined) => {
    if (whole === "{{") return "{";
    if (whole === "}}") return "}";
    const value = args[Number(index)];
    if (value === undefined) return whole;
    return forms === undefined ? value : forms.split("|")[russianForm(Number(value))] ?? "";
  });
}
