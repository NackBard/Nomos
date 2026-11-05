import assert from "node:assert/strict";
import { test } from "node:test";
import { format, placeholders, russianForm, templateProblems } from "./l10n.ts";

test("Russian word forms follow the number", () => {
  assert.deepEqual([1, 2, 5, 11, 12, 21, 22, 25, 111, 1.5].map(russianForm), [0, 1, 2, 2, 2, 0, 1, 2, 2, 1]);
  const template = "{0} занимает {1} {1|строку|строки|строк}";
  assert.equal(format(template, ["Run", "21"]), "Run занимает 21 строку");
  assert.equal(format(template, ["Run", "3"]), "Run занимает 3 строки");
  assert.equal(format(template, ["Run", "11"]), "Run занимает 11 строк");
});

test("placeholders and problems of templates", () => {
  assert.deepEqual([...placeholders("{0} и {1|a|b|c} {{x}}")], [0, 1]);
  assert.equal(format("{{{0}}}", ["a"]), "{a}");
  assert.deepEqual(templateProblems("{0} has {1|a|b|c}", true), ["word forms are for translations only: {1|a|b|c}"]);
  assert.deepEqual(templateProblems("{1|a|b}", false), ["{1|a|b} needs three forms: one, few, many"]);
  assert.deepEqual(templateProblems("a {b", false), ["unbalanced brace"]);
});
