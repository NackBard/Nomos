/**
 * A finding text kept as a template of spec/rules with numbered placeholders and its arguments, so that a client can
 * show it in another language (spec/l10n.md). The template is the English text: {0}, {1}…
 */
export interface Text { template: string; args: string[] }

/**
 * Builds a text from a template of spec/rules. Numbers become their invariant text: integers as they are, other values
 * must be formatted by the caller (`fixed`). The template must be a literal: the tests read the calls from the source
 * and look the templates up in spec.
 */
export function tx(template: string, ...args: (string | number)[]): Text {
  return { template, args: args.map((a) => (typeof a === "number" ? integer(a) : a)) };
}

function integer(value: number): string {
  if (!Number.isInteger(value)) throw new Error(`argument ${value} is not an integer; format it with fixed()`);
  return String(value);
}

/** A number with a fixed count of decimals, culture-free: 0.52, not 0,52. */
export function fixed(value: number, digits: number): string {
  return value.toFixed(digits);
}

/** Puts the arguments into the template; `{{` and `}}` are braces. */
export function render(text: Text): string {
  let out = "";
  const t = text.template;
  for (let i = 0; i < t.length; i++) {
    const c = t[i];
    if ((c === "{" || c === "}") && t[i + 1] === c) {
      out += c;
      i++;
    } else if (c === "{") {
      const end = t.indexOf("}", i);
      out += text.args[Number(t.slice(i + 1, end))];
      i = end;
    } else {
      out += c;
    }
  }
  return out;
}
