// Templates of finding texts (spec/l10n.md): {n} inserts argument n, {n|one|few|many} picks a word form by the
// number in argument n (Russian plural rules), {{ and }} are literal braces. English templates use {n} only.

const HOLE = /\{\{|\}\}|\{(\d+)(?:\|([^{}]*))?\}/g;

/** Indexes of the arguments a template refers to. */
export function placeholders(template: string): Set<number> {
  const found = new Set<number>();
  for (const m of template.matchAll(HOLE)) if (m[1] !== undefined) found.add(Number(m[1]));
  return found;
}

/** Problems of a template: unbalanced braces, plural forms in English, a wrong number of forms. */
export function templateProblems(template: string, english: boolean): string[] {
  const problems: string[] = [];
  const rest = template.replace(HOLE, (whole, index, forms) => {
    if (forms !== undefined) {
      if (english) problems.push(`word forms are for translations only: ${whole}`);
      else if (forms.split("|").length !== 3) problems.push(`${whole} needs three forms: one, few, many`);
    }
    return "";
  });
  if (/[{}]/.test(rest)) problems.push("unbalanced brace");
  return problems;
}

/** Russian plural category of a number: 1, 21 → one; 2–4, 22 → few; others → many; fractions → few. */
export function russianForm(value: number): 0 | 1 | 2 {
  if (!Number.isInteger(value)) return 1;
  const n = Math.abs(value) % 100;
  if (n % 10 === 1 && n !== 11) return 0;
  if (n % 10 >= 2 && n % 10 <= 4 && (n < 12 || n > 14)) return 1;
  return 2;
}

/** Puts the arguments into a template. */
export function format(template: string, args: readonly string[]): string {
  return template.replace(HOLE, (whole, index, forms) => {
    if (whole === "{{") return "{";
    if (whole === "}}") return "}";
    const value = args[Number(index)] ?? "";
    if (forms === undefined) return value;
    return forms.split("|")[russianForm(Number(value))] ?? "";
  });
}
