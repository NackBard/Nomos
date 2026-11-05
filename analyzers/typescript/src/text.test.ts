import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { specRules } from "./config.ts";
import { fixed, render, tx } from "./text.ts";

const here = path.dirname(fileURLToPath(import.meta.url));

test("a text keeps its template and renders the arguments", () => {
  const text = tx("{0} has {1}% coverage, D = {2}, {{3}}", "a.ts", 42, fixed(0.5, 2));
  assert.deepEqual(text, { template: "{0} has {1}% coverage, D = {2}, {{3}}", args: ["a.ts", "42", "0.50"] });
  assert.equal(render(text), "a.ts has 42% coverage, D = 0.50, {3}");
});

test("a fractional number must be formatted by the caller", () => {
  assert.throws(() => tx("{0}", 0.5), /not an integer/);
});

/** Helpers outside the detectors object that report for one rule. */
const helpers: Record<string, string> = { checkSecret: "SEC001" };

/** Every tx call of the analyzer with the rule it reports for: the detector it is in, or a helper of one rule. */
function sourceTemplates(): { rule: string; template?: string; where: string }[] {
  const found: { rule: string; template?: string; where: string }[] = [];
  for (const name of fs.readdirSync(here).filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts") && f !== "text.ts")) {
    const file = path.join(here, name);
    const sf = ts.createSourceFile(file, fs.readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
    const visit = (node: ts.Node, rule: string) => {
      if (ts.isMethodDeclaration(node) && ts.isIdentifier(node.name) && /^[A-Z]{2,4}\d{3}$/.test(node.name.text)) rule = node.name.text;
      if (ts.isFunctionDeclaration(node) && node.name && helpers[node.name.text]) rule = helpers[node.name.text];
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "tx") {
        const where = `${name}:${sf.getLineAndCharacterOfPosition(node.getStart()).line + 1}`;
        const first = node.arguments[0];
        found.push({ rule, where, template: first && ts.isStringLiteral(first) ? first.text : undefined });
      }
      ts.forEachChild(node, (child) => visit(child, rule));
    };
    visit(sf, "");
  }
  return found;
}

test("every text of a finding is a template of its rule in spec/rules (spec/l10n.md)", () => {
  const spec = new Map(specRules().map((r) => [r.id, new Set(Object.values(r.messages ?? {}).map((m) => m.text))]));
  const found = sourceTemplates();
  assert.ok(found.length > 50, `only ${found.length} texts found: the scan is broken`);
  const problems = found.flatMap((item) => {
    if (item.template === undefined) return [`${item.where}: the template is not a literal`];
    if (!item.rule) return [`${item.where}: tx outside a detector`];
    return spec.get(item.rule)?.has(item.template) ? [] : [`${item.where} ${item.rule}: not in spec: ${item.template}`];
  });
  assert.deepEqual(problems, []);
});
