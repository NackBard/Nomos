import assert from "node:assert/strict";
import { test } from "node:test";
import { keysWithChangedArguments } from "./go-rules.ts";

const rule = (text: string) => [{ id: "X001", messages: { main: { text } } }];

test("a key keeps its arguments when only the wording changes", () => {
  assert.deepEqual(keysWithChangedArguments(rule("{0} has {1} lines"), rule("{0} is {1} lines long")), []);
});

test("a key whose arguments change is reported", () => {
  assert.deepEqual(keysWithChangedArguments(rule("{0} has {1} lines"), rule("{0} has {1} lines in {2}")), ["X001.main: arguments {0,1} became {0,1,2}"]);
});

test("new rules and new keys are not compared", () => {
  assert.deepEqual(keysWithChangedArguments([], rule("{0}")), []);
  assert.deepEqual(keysWithChangedArguments([{ id: "X001", messages: { other: { text: "{0}" } } }], rule("{0} {1}")), []);
});
