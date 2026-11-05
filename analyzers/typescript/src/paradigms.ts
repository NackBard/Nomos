import ts from "typescript";
import { ordinal } from "./config.ts";
import { entryOf, resolveSymbol } from "./graph.ts";
import { baseOf, hofOrder, walkBody } from "./metrics.ts";
import type { Fn, Module, Project } from "./project.ts";
import { isFunctionValue } from "./project.ts";

/** A sign of a paradigm in a module (spec/paradigms.md). */
export interface Evidence { paradigm: string; kind: string; count: number; description: string; examples: string[] }

const activating = new Set(["oop.classes", "str.free-functions", "str.control-flow", "fp.higher-order", "fp.pure-functions"]);

/** The activation column of spec/paradigms.md. */
export function activeParadigms(evidence: Evidence[]): string[] {
  return [...new Set(evidence.filter((e) => activating.has(e.kind)).map((e) => e.paradigm))].sort(ordinal);
}

function add(list: Evidence[], paradigm: string, kind: string, description: string, ids: string[], count = ids.length): void {
  if (count === 0) return;
  list.push({ paradigm, kind, count, description, examples: [...new Set(ids)].sort(ordinal).slice(0, 5) });
}

export function moduleFunctions(m: Module): Fn[] {
  return [...m.functions, ...m.types.flatMap((t) => t.methods)];
}

function hasControlFlow(f: Fn): boolean {
  let found = false;
  walkBody(f, (n) => {
    if (ts.isIfStatement(n) || ts.isSwitchStatement(n) || ts.isForStatement(n) || ts.isForInStatement(n) || ts.isForOfStatement(n) || ts.isWhileStatement(n) || ts.isDoStatement(n)) found = true;
    return !found;
  });
  return found;
}

/** The signs of one module. A class with fields or methods is a class; an alias of an object shape is an abstraction. */
export function collectEvidence(p: Project, m: Module, pure: Set<Fn>): Evidence[] {
  const result: Evidence[] = [];
  const classes: string[] = [];
  const mutable: string[] = [];
  const inheriting: string[] = [];
  const abstract: string[] = [];
  const immutable: string[] = [];
  for (const t of m.types) {
    if (t.kind === "class") {
      const state = t.members.filter((x) => !x.isStatic);
      if (t.members.length + t.methods.length > 0) classes.push(t.id);
      if (state.some((x) => x.mutable)) mutable.push(t.id);
      else if (state.length > 0) immutable.push(t.id);
      if (baseOf(p, t)?.project) inheriting.push(t.id);
    }
    if (t.isAbstract) abstract.push(t.id);
  }
  add(result, "oop", "oop.classes", "classes with methods or fields", classes);
  add(result, "oop", "oop.mutable-state-classes", "classes with mutable instance state", mutable);
  add(result, "oop", "oop.inheritance", "project types inheriting project types", inheriting);
  add(result, "oop", "oop.abstractions", "interfaces and abstract classes", abstract);
  add(result, "functional", "fp.immutable-types", "types whose instance state cannot change", immutable);

  const free = m.functions.map((f) => f.id);
  const flow: string[] = [];
  const higher: string[] = [];
  const pureIds: string[] = [];
  const lambdaOwners: string[] = [];
  for (const f of moduleFunctions(m)) {
    if (hasControlFlow(f)) flow.push(f.id);
    if (f.body && hofOrder(f) > 1) higher.push(f.id);
    if (pure.has(f)) pureIds.push(f.id);
    walkBody(f, (n) => {
      if (ts.isCallExpression(n) || ts.isNewExpression(n)) {
        for (const argument of n.arguments ?? []) if (isFunctionValue(argument)) lambdaOwners.push(f.id);
      }
    });
  }
  const globals = [...m.globals.map((g) => g.id), ...m.types.flatMap((t) => t.members.filter((x) => x.isStatic && x.mutable).map((x) => `${t.id}.${x.name}`))];
  add(result, "structural", "str.free-functions", "functions outside types", free);
  add(result, "structural", "str.control-flow", "functions with branches or loops", flow);
  add(result, "structural", "str.global-state", "module-level variables and static mutable state", globals);
  add(result, "functional", "fp.lambdas", "lambdas passed as arguments", lambdaOwners, lambdaOwners.length);
  add(result, "functional", "fp.higher-order", "functions taking or returning functions", higher);
  add(result, "functional", "fp.pure-functions", "functions that provably have no effects (conservative)", pureIds);
  return result.sort((a, b) => ordinal(a.kind, b.kind));
}

/** The conservative definition of spec/paradigms.md as a greatest fixed point. */
export function pureFunctions(p: Project): Set<Fn> {
  const pure = new Set<Fn>();
  for (const f of p.functions.values()) {
    if (f.body && (f.kind === "function" || f.kind === "method") && locallyPure(p, f)) pure.add(f);
  }
  for (let changed = true; changed;) {
    changed = false;
    for (const f of [...pure]) {
      if (!callsOnlyPure(p, f, pure)) {
        pure.delete(f);
        changed = true;
      }
    }
  }
  return pure;
}

/** A name declared inside the function: a parameter or a local. */
function isOwn(f: Fn, symbol: ts.Symbol | undefined): boolean {
  const declaration = symbol?.valueDeclaration ?? symbol?.declarations?.[0];
  return !!declaration && declaration.getSourceFile() === f.fn.getSourceFile() && declaration.pos >= f.fn.pos && declaration.end <= f.fn.end;
}

function isStringType(checker: ts.TypeChecker, node: ts.Expression): boolean {
  return !!(checker.getTypeAtLocation(node).flags & ts.TypeFlags.StringLike);
}

const writes = new Set([
  ts.SyntaxKind.EqualsToken, ts.SyntaxKind.PlusEqualsToken, ts.SyntaxKind.MinusEqualsToken, ts.SyntaxKind.AsteriskEqualsToken, ts.SyntaxKind.SlashEqualsToken,
  ts.SyntaxKind.PercentEqualsToken, ts.SyntaxKind.AsteriskAsteriskEqualsToken, ts.SyntaxKind.LessThanLessThanEqualsToken, ts.SyntaxKind.GreaterThanGreaterThanEqualsToken,
  ts.SyntaxKind.GreaterThanGreaterThanGreaterThanEqualsToken, ts.SyntaxKind.AmpersandEqualsToken, ts.SyntaxKind.BarEqualsToken, ts.SyntaxKind.CaretEqualsToken,
  ts.SyntaxKind.AmpersandAmpersandEqualsToken, ts.SyntaxKind.BarBarEqualsToken, ts.SyntaxKind.QuestionQuestionEqualsToken,
]);

/**
 * Writes go only to own names, reads of module state and `this` only of readonly members, no lambdas, await, yield,
 * throw or delete, and creation only of strings, literals and project classes without an explicit constructor.
 * Object and array literals are values, not effects (D-055).
 */
function locallyPure(p: Project, f: Fn): boolean {
  const checker = f.file.checker;
  let ok = true;
  const ownTarget = (x: ts.Expression): boolean => {
    if (ts.isIdentifier(x)) return isOwn(f, checker.getSymbolAtLocation(x));
    if (ts.isArrayLiteralExpression(x)) return x.elements.every((e) => ts.isOmittedExpression(e) || ownTarget(e as ts.Expression));
    if (ts.isObjectLiteralExpression(x)) return x.properties.every((prop) => ts.isShorthandPropertyAssignment(prop) ? isOwn(f, checker.getSymbolAtLocation(prop.name)) : ts.isPropertyAssignment(prop) && ownTarget(prop.initializer));
    return false;
  };
  walkBody(f, (n) => {
    if (!ok) return false;
    if (isFunctionValue(n) || ts.isAwaitExpression(n) || ts.isYieldExpression(n) || ts.isThrowStatement(n) || ts.isDeleteExpression(n) || ts.isClassExpression(n) || ts.isFunctionDeclaration(n) || ts.isTaggedTemplateExpression(n)) {
      ok = false;
    } else if (ts.isBinaryExpression(n) && writes.has(n.operatorToken.kind)) {
      ok = ownTarget(n.left);
    } else if ((ts.isPrefixUnaryExpression(n) || ts.isPostfixUnaryExpression(n)) && (n.operator === ts.SyntaxKind.PlusPlusToken || n.operator === ts.SyntaxKind.MinusMinusToken)) {
      ok = ownTarget(n.operand);
    } else if (ts.isNewExpression(n)) {
      const entry = entryOf(p, resolveSymbol(checker, n.expression));
      ok = !!entry && "type" in entry && entry.type.kind === "class" && !entry.type.methods.some((x) => x.kind === "constructor");
    } else if (ts.isIdentifier(n)) {
      const entry = entryOf(p, resolveSymbol(checker, n));
      if (entry && "global" in entry) ok = false;
      const symbol = resolveSymbol(checker, n);
      // A module-level variable outside the analyzed files, a global of the environment (window, process, console).
      const name = ts.isPropertyAccessExpression(n.parent) && n.parent.name === n;
      if (symbol && symbol.flags & ts.SymbolFlags.Variable && !name && !isOwn(f, symbol) && !isConstDeclaration(symbol) && !readable.has(n.text)) ok = false;
    } else if (ts.isPropertyAccessExpression(n) && n.expression.kind === ts.SyntaxKind.ThisKeyword) {
      const entry = entryOf(p, resolveSymbol(checker, n.name));
      if (entry && "member" in entry && entry.member.mutable) ok = false;
    }
    return ok;
  });
  return ok;
}

/** Globals of the environment that hold no state: Math stands for System.Math and the math package (spec/paradigms.md). */
const readable = new Set(["Math", "undefined", "NaN", "Infinity"]);

function isConstDeclaration(symbol: ts.Symbol): boolean {
  const declaration = symbol.valueDeclaration;
  return !!declaration && ts.isVariableDeclaration(declaration) && !!(declaration.parent.flags & ts.NodeFlags.Const);
}

/** Calls go only to Math, to methods of strings and to pure project functions. */
function callsOnlyPure(p: Project, f: Fn, pure: Set<Fn>): boolean {
  const checker = f.file.checker;
  let ok = true;
  walkBody(f, (n) => {
    if (!ok || !ts.isCallExpression(n)) return ok;
    const callee = n.expression;
    if (ts.isPropertyAccessExpression(callee)) {
      if (ts.isIdentifier(callee.expression) && callee.expression.text === "Math" && !entryOf(p, resolveSymbol(checker, callee.expression))) return true;
      if (isStringType(checker, callee.expression) && !entryOf(p, resolveSymbol(checker, callee.name))) return true;
    }
    const name = ts.isPropertyAccessExpression(callee) ? callee.name : callee;
    const entry = entryOf(p, resolveSymbol(checker, name));
    ok = !!entry && "fn" in entry && pure.has(entry.fn);
    return ok;
  });
  return ok;
}
