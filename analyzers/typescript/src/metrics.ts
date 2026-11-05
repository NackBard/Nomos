import ts from "typescript";
import { ordinal } from "./config.ts";
import { entryOf, resolveSymbol } from "./graph.ts";
import type { Fn, Member, Project, TypeUnit } from "./project.ts";
import { isFunctionValue } from "./project.ts";

/** Visits every node of a body, nested functions included (spec/metrics.md: lambdas belong to their owner). */
export function walk(node: ts.Node | undefined, visit: (n: ts.Node) => boolean | void): void {
  if (!node) return;
  const go = (n: ts.Node) => {
    if (visit(n) === false) return;
    ts.forEachChild(n, go);
  };
  go(node);
}

export function walkBody(f: Fn, visit: (n: ts.Node) => boolean | void): void {
  if (f.body) walk(f.body, visit);
}

function isLoop(n: ts.Node): boolean {
  return ts.isForStatement(n) || ts.isForInStatement(n) || ts.isForOfStatement(n) || ts.isWhileStatement(n) || ts.isDoStatement(n);
}

/** 1 + decision points: if, case labels, loops, catch, ?:, && and || (as in C# and Go, ?? is not counted). */
export function cyclomatic(f: Fn): number {
  let count = 1;
  walkBody(f, (n) => {
    if (ts.isIfStatement(n) || ts.isCaseClause(n) || isLoop(n) || ts.isCatchClause(n) || ts.isConditionalExpression(n)) count++;
    else if (ts.isBinaryExpression(n) && (n.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken || n.operatorToken.kind === ts.SyntaxKind.BarBarToken)) count++;
  });
  return count;
}

/** Deepest number of enclosing if, switch, loop and try statements; else-if stays on the level of its if. */
export function maxNesting(f: Fn): number {
  if (!f.body) return 0;
  let deepest = 0;
  const visit = (n: ts.Node, d: number) => {
    deepest = Math.max(deepest, d);
    if (ts.isIfStatement(n)) {
      visitIf(n, d);
      return;
    }
    if (ts.isSwitchStatement(n) || isLoop(n) || ts.isTryStatement(n)) {
      deepest = Math.max(deepest, d + 1);
      ts.forEachChild(n, (c) => visit(c, d + 1));
      return;
    }
    ts.forEachChild(n, (c) => visit(c, d));
  };
  const visitIf = (s: ts.IfStatement, d: number) => {
    visit(s.expression, d);
    visit(s.thenStatement, d + 1);
    if (s.elseStatement && ts.isIfStatement(s.elseStatement)) visitIf(s.elseStatement, d);
    else if (s.elseStatement) visit(s.elseStatement, d + 1);
  };
  ts.forEachChild(f.body, (c) => visit(c, 0));
  return deepest;
}

/** Declared parameters; a `this` parameter is implicit. */
export function parameterCount(f: Fn): number {
  return f.fn.parameters.filter((p) => !(ts.isIdentifier(p.name) && p.name.text === "this")).length;
}

/** Depth of function types in a type: 1 for a function of data, more for functions of functions. */
function functionDepth(checker: ts.TypeChecker, type: ts.Type, seen: Set<ts.Type>): number {
  if (seen.has(type) || seen.size > 50) return 0;
  seen.add(type);
  try {
    if (type.isUnionOrIntersection()) return Math.max(0, ...type.types.map((t) => functionDepth(checker, t, seen)));
    const signatures = type.getCallSignatures();
    if (signatures.length > 0) return 1 + Math.max(...signatures.map((s) => signatureDepth(checker, s, seen)));
    const reference = type as ts.TypeReference;
    if (reference.target && (type.symbol?.name === "Array" || type.symbol?.name === "ReadonlyArray")) {
      return Math.max(0, ...checker.getTypeArguments(reference).map((t) => functionDepth(checker, t, seen)));
    }
    return 0;
  } finally {
    seen.delete(type);
  }
}

function signatureDepth(checker: ts.TypeChecker, signature: ts.Signature, seen: Set<ts.Type>): number {
  const declaration = signature.getDeclaration();
  let depth = functionDepth(checker, signature.getReturnType(), seen);
  for (const parameter of signature.getParameters()) {
    const type = declaration ? checker.getTypeOfSymbolAtLocation(parameter, declaration) : checker.getTypeOfSymbol(parameter);
    depth = Math.max(depth, functionDepth(checker, type, seen));
  }
  return depth;
}

/** 1 + the deepest nesting of function types in the parameters and the result, as the checker sees them. */
export function hofOrder(f: Fn): number {
  const checker = f.file.checker;
  const signature = checker.getSignatureFromDeclaration(f.fn);
  return 1 + (signature ? signatureDepth(checker, signature, new Set()) : 0);
}

/** Deepest nesting of lambdas (arrow functions and function expressions) in the body. */
export function lambdaNesting(f: Fn): number {
  const depth = (n: ts.Node): number => {
    let deepest = 0;
    ts.forEachChild(n, (c) => {
      deepest = Math.max(deepest, isFunctionValue(c) ? 1 + depth(c) : depth(c));
    });
    return deepest;
  };
  return f.body ? depth(f.body) : 0;
}

/** The project type a type expression names. */
export function projectTypeOf(p: Project, checker: ts.TypeChecker, node: ts.Node): TypeUnit | undefined {
  const entry = entryOf(p, resolveSymbol(checker, ts.isPropertyAccessExpression(node) ? node.name : node));
  return entry && "type" in entry ? entry.type : undefined;
}

/** Distinct project types a function tests at run time with instanceof. */
export function testedTypes(p: Project, f: Fn): string[] {
  const seen = new Set<string>();
  walkBody(f, (n) => {
    if (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.InstanceOfKeyword) {
      const t = projectTypeOf(p, f.file.checker, n.right);
      if (t) seen.add(t.id);
    }
  });
  return [...seen].sort(ordinal);
}

/** Visits every node with the number of loops whose body holds it; loop headers that run once are outside. */
export function walkLoops(f: Fn, visit: (n: ts.Node, depth: number) => void): void {
  const go = (n: ts.Node, depth: number) => {
    visit(n, depth);
    if (ts.isForStatement(n)) {
      if (n.initializer) go(n.initializer, depth);
      for (const part of [n.condition, n.incrementor, n.statement]) if (part) go(part, depth + 1);
      return;
    }
    if (ts.isForOfStatement(n) || ts.isForInStatement(n)) {
      go(n.initializer, depth);
      go(n.expression, depth);
      go(n.statement, depth + 1);
      return;
    }
    if (ts.isWhileStatement(n) || ts.isDoStatement(n)) {
      go(n.expression, depth + 1);
      go(n.statement, depth + 1);
      return;
    }
    ts.forEachChild(n, (c) => go(c, depth));
  };
  if (f.body) ts.forEachChild(f.body, (c) => go(c, 0));
}

/** Creates an object on the heap: `new`, an array or object literal, a lambda. */
export function allocates(n: ts.Node): boolean {
  return ts.isNewExpression(n) || ts.isArrayLiteralExpression(n) || ts.isObjectLiteralExpression(n) || isFunctionValue(n) || ts.isClassExpression(n);
}

export function allocationDepth(f: Fn): number {
  let deepest = 0;
  walkLoops(f, (n, depth) => {
    if (allocates(n)) deepest = Math.max(deepest, depth);
  });
  return deepest;
}

/** Calls that grow a collection: push, unshift, Set.add, Map.set (spec/metrics.md, spaceDegree). */
const growing = new Set(["push", "unshift", "add", "set"]);

/** Whether an expression is a literal number. */
export function isLiteralNumber(n: ts.Node | undefined): boolean {
  return !!n && (ts.isNumericLiteral(n) || (ts.isPrefixUnaryExpression(n) && ts.isNumericLiteral(n.operand)));
}

/** spaceDegree: collection growth in loops, arrays of non-literal size, direct recursion. */
export function spaceDegree(f: Fn, selfCalls: number): number {
  let degree = 0;
  walkLoops(f, (n, depth) => {
    if (!ts.isCallExpression(n) && !ts.isNewExpression(n)) return;
    const callee = n.expression;
    if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(callee) && growing.has(callee.name.text)) degree = Math.max(degree, depth);
    // new Array(n), Array(n) and Array.from({ length: n }) allocate a sized array.
    const sizedArray = ts.isIdentifier(callee) && callee.text === "Array" && n.arguments?.length === 1 && !isLiteralNumber(n.arguments[0]);
    const from = ts.isCallExpression(n) && ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.expression) && callee.expression.text === "Array" && callee.name.text === "from"
      && n.arguments.length >= 1 && ts.isObjectLiteralExpression(n.arguments[0])
      && n.arguments[0].properties.some((prop) => ts.isPropertyAssignment(prop) && prop.name.getText() === "length" && !isLiteralNumber(prop.initializer));
    if (sizedArray || from) degree = Math.max(degree, depth + 1);
  });
  if (selfCalls > 0) degree = Math.max(degree, 1);
  return degree;
}

/** A method of a class with a body that belongs to an instance (spec/metrics.md, foreignMembers). */
export function isInstanceMethod(f: Fn): boolean {
  return !!f.owner && f.owner.kind === "class" && !!f.body && f.kind === "method" && !f.isStatic;
}

/** The member a property access names, if it is an instance field or property of a project class. */
export function memberOf(p: Project, f: Fn, access: ts.PropertyAccessExpression | ts.ElementAccessExpression): Member | undefined {
  const name = ts.isPropertyAccessExpression(access) ? access.name : access.argumentExpression;
  const entry = entryOf(p, resolveSymbol(f.file.checker, name));
  return entry && "member" in entry && entry.member.owner.kind === "class" && entry.member.kind !== "literal" && !entry.member.isStatic ? entry.member : undefined;
}

/** Fields and properties of its own type a function touches and, by owner, those of other project classes. */
export function memberUse(p: Project, f: Fn): { own: Set<Member>; foreign: Map<string, Set<string>> } {
  const own = new Set<Member>();
  const foreign = new Map<string, Set<string>>();
  walkBody(f, (n) => {
    if (!ts.isPropertyAccessExpression(n)) return;
    const member = memberOf(p, f, n);
    if (!member) return;
    if (member.owner === f.owner) own.add(member);
    else {
      if (!foreign.has(member.owner.id)) foreign.set(member.owner.id, new Set());
      foreign.get(member.owner.id)!.add(member.name);
    }
  });
  return { own, foreign };
}

/** The other type a method uses most fields of, by ordinal id on a tie. */
export function mostUsedForeign(p: Project, f: Fn): { owner: string; members: string[] } {
  const { foreign } = memberUse(p, f);
  let best = "";
  for (const id of [...foreign.keys()].sort(ordinal)) {
    if (best === "" || foreign.get(id)!.size > foreign.get(best)!.size) best = id;
  }
  return best === "" ? { owner: "", members: [] } : { owner: best, members: [...foreign.get(best)!].sort(ordinal) };
}

/** Instance methods with a body: the vertices of LCOM4. */
export function classMethods(t: TypeUnit): Fn[] {
  return t.methods.filter((m) => m.kind === "method" && !m.isStatic && !!m.body);
}

/** Sum of the cyclomatic complexity of methods and constructors; accessors are not methods. */
export function wmc(t: TypeUnit): number {
  return t.methods.filter((m) => m.kind !== "accessor").reduce((sum, m) => sum + cyclomatic(m), 0);
}

/** The base class a class extends, if any: a project type, or an external one (one step). */
export function baseOf(p: Project, t: TypeUnit): { project?: TypeUnit; external: boolean } | undefined {
  if (!ts.isClassDeclaration(t.node)) return undefined;
  const clause = t.node.heritageClauses?.find((h) => h.token === ts.SyntaxKind.ExtendsKeyword);
  const expression = clause?.types[0]?.expression;
  if (!expression) return undefined;
  const base = projectTypeOf(p, t.module.file.checker, expression);
  return base ? { project: base, external: false } : { external: true };
}

/** Depth of the base class chain; a base outside the project is one step, interfaces do not count. */
export function dit(p: Project, t: TypeUnit, seen = new Set<string>([t.id])): number {
  const base = baseOf(p, t);
  if (!base) return 0;
  if (!base.project || seen.has(base.project.id) || base.project.kind !== "class") return 1;
  return 1 + dit(p, base.project, new Set([...seen, base.project.id]));
}

/** Project functions a function calls through a property access or by name. */
export function calledFunctions(p: Project, f: Fn): Set<Fn> {
  const result = new Set<Fn>();
  walkBody(f, (n) => {
    if (!ts.isCallExpression(n)) return;
    const callee = ts.isPropertyAccessExpression(n.expression) ? n.expression.name : n.expression;
    const entry = entryOf(p, resolveSymbol(f.file.checker, callee));
    if (entry && "fn" in entry) result.add(entry.fn);
  });
  return result;
}

function overlaps<T>(a: Set<T>, b: Set<T>): boolean {
  for (const item of a) if (b.has(item)) return true;
  return false;
}

/** Connected components of instance methods: a shared field or a call. Null below one method. */
export function lcom4(p: Project, t: TypeUnit): number | null {
  const methods = classMethods(t);
  if (methods.length === 0) return null;
  const parent = methods.map((_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  const uses = methods.map((m) => memberUse(p, m).own);
  const calls = methods.map((m) => calledFunctions(p, m));
  for (let i = 0; i < methods.length; i++) {
    for (let j = i + 1; j < methods.length; j++) {
      if (overlaps(uses[i], uses[j]) || calls[i].has(methods[j]) || calls[j].has(methods[i])) parent[find(i)] = find(j);
    }
  }
  return new Set(methods.map((_, i) => find(i))).size;
}

/** Share of pairs of visible methods using a common field; visible means not private. Null below two. */
export function tcc(p: Project, t: TypeUnit): number | null {
  const methods = classMethods(t).filter((m) => m.visibility !== "private");
  if (methods.length < 2) return null;
  const uses = methods.map((m) => memberUse(p, m).own);
  let connected = 0;
  for (let i = 0; i < uses.length; i++) for (let j = i + 1; j < uses.length; j++) if (overlaps(uses[i], uses[j])) connected++;
  return round(connected / ((uses.length * (uses.length - 1)) / 2), 4);
}

/** Distinct fields and properties of other project classes reached by the methods of a type. */
export function atfd(p: Project, t: TypeUnit): number {
  const seen = new Set<string>();
  for (const m of t.methods) {
    for (const [owner, fields] of memberUse(p, m).foreign) for (const field of fields) seen.add(`${owner}.${field}`);
  }
  return seen.size;
}

const separators = new Set([
  ts.SyntaxKind.OpenParenToken, ts.SyntaxKind.CloseParenToken, ts.SyntaxKind.OpenBraceToken, ts.SyntaxKind.CloseBraceToken,
  ts.SyntaxKind.OpenBracketToken, ts.SyntaxKind.CloseBracketToken, ts.SyntaxKind.SemicolonToken, ts.SyntaxKind.CommaToken,
]);

/** N log2 n over the tokens of the lines of a function, without separators. */
export function halsteadVolume(f: Fn): number | null {
  let total = 0;
  const distinct = new Set<string>();
  for (const t of f.file.tokens) {
    if (t.line >= f.place.startLine && t.line <= f.place.endLine && !separators.has(t.kind)) {
      total++;
      distinct.add(t.text);
    }
  }
  if (distinct.size < 2) return null;
  return total * Math.log2(distinct.size);
}

export function maintainabilityIndex(f: Fn): number | null {
  const volume = halsteadVolume(f);
  const lines = f.place.endLine - f.place.startLine + 1;
  if (volume === null || lines === 0) return null;
  return Math.max(0, ((171 - 5.2 * Math.log(volume) - 0.23 * cyclomatic(f) - 16.2 * Math.log(lines)) * 100) / 171);
}

export function round(value: number, digits: number): number {
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}

export function lineSpan(place: { startLine: number; endLine: number }): number {
  return place.endLine - place.startLine + 1;
}
