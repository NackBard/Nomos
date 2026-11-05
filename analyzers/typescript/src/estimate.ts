import ts from "typescript";
import { entryOf, resolveSymbol } from "./graph.ts";
import { isLiteralNumber, walkBody } from "./metrics.ts";
import type { Fn, Project } from "./project.ts";
import { isFunctionValue, unwrap } from "./project.ts";

/** n^degree · (log n)^log, or exponential (spec/metrics.md). */
export interface Growth { degree: number; log: number; exponential: boolean; uncertain: boolean }

export const constant: Growth = { degree: 0, log: 0, exponential: false, uncertain: false };
const linear: Growth = { degree: 1, log: 0, exponential: false, uncertain: false };
const logarithmic: Growth = { degree: 0, log: 1, exponential: false, uncertain: false };

function times(a: Growth, b: Growth): Growth {
  return { degree: a.degree + b.degree, log: a.log + b.log, exponential: a.exponential || b.exponential, uncertain: a.uncertain || b.uncertain };
}

function or(a: Growth, b: Growth): Growth {
  const larger = (b.exponential !== a.exponential && b.exponential) || (b.exponential === a.exponential && (b.degree > a.degree || (b.degree === a.degree && b.log > a.log))) ? b : a;
  return { ...larger, uncertain: a.uncertain || b.uncertain };
}

/** The estimate as a message shows it. */
export function growthText(g: Growth): string {
  if (g.exponential) return "O(2ⁿ)";
  const parts: string[] = [];
  if (g.degree === 1) parts.push("n");
  else if (g.degree === 2) parts.push("n²");
  else if (g.degree === 3) parts.push("n³");
  else if (g.degree > 3) parts.push(`n^${g.degree}`);
  if (g.log === 1) parts.push("log n");
  else if (g.log > 1) parts.push(`log^${g.log} n`);
  return parts.length === 0 ? "O(1)" : `O(${parts.join(" ")})`;
}

/** Library methods that walk a whole sequence or string; the list belongs to the analyzer (spec/metrics.md). */
export const linearMethods = new Set([
  "includes", "indexOf", "lastIndexOf", "find", "findIndex", "findLast", "findLastIndex", "filter", "map", "forEach", "reduce", "reduceRight",
  "some", "every", "flat", "flatMap", "join", "slice", "concat", "fill", "reverse", "toReversed", "keys", "values", "entries", "from",
]);
const sortMethods = new Set(["sort", "toSorted"]);

/**
 * The method name of a call to a library method on a sequence: the standard library, a package, or a receiver of
 * unknown type. Methods of strings are left out: n is the size of the input, not the length of one string (D-055).
 */
function libraryMethod(p: Project, f: Fn, call: ts.CallExpression): string | undefined {
  const callee = unwrap(call.expression);
  if (!ts.isPropertyAccessExpression(callee)) return undefined;
  const symbol = resolveSymbol(f.file.checker, callee.name);
  if (entryOf(p, symbol)) return undefined;
  if (f.file.checker.getTypeAtLocation(callee.expression).flags & ts.TypeFlags.StringLike) return undefined;
  return callee.name.text;
}

/** Project callee of a call, through a name or a property access. */
export function calleeOf(p: Project, f: Fn, call: ts.CallExpression | ts.NewExpression): Fn | undefined {
  const callee = unwrap(call.expression);
  const name = ts.isPropertyAccessExpression(callee) ? callee.name : callee;
  const entry = entryOf(p, resolveSymbol(f.file.checker, name));
  return entry && "fn" in entry ? entry.fn : undefined;
}

export function selfCalls(p: Project, f: Fn): ts.CallExpression[] {
  const calls: ts.CallExpression[] = [];
  walkBody(f, (n) => {
    if (ts.isCallExpression(n) && calleeOf(p, f, n) === f) calls.push(n);
  });
  return calls;
}

/**
 * Estimates every function with a body in ordinal id order: mutual recursion is cut at the function still being
 * estimated, so another order could give another value.
 */
export function timeEstimates(p: Project): Map<string, Growth> {
  const e = new Estimator(p);
  const result = new Map<string, Growth>();
  for (const f of p.allFunctions()) if (f.body) result.set(f.id, e.estimate(f));
  return result;
}

class Estimator {
  private memo = new Map<Fn, Growth>();
  private active = new Set<Fn>();
  /** Names bound to one element of an enclosing iteration. */
  private elements = new Set<string>();
  private current?: Fn;
  private readonly p: Project;

  constructor(p: Project) {
    this.p = p;
  }

  estimate(f: Fn): Growth {
    const known = this.memo.get(f);
    if (known) return known;
    if (!f.body || this.active.has(f)) return constant;
    this.active.add(f);
    const outerElements = this.elements;
    const outer = this.current;
    this.elements = new Set();
    this.current = f;
    const growth = this.combine(f, this.cost(f.body));
    this.elements = outerElements;
    this.current = outer;
    this.active.delete(f);
    this.memo.set(f, growth);
    return growth;
  }

  private children(n: ts.Node): Growth {
    let total = constant;
    ts.forEachChild(n, (c) => {
      total = or(total, this.cost(c));
    });
    return total;
  }

  private bindElement(name: ts.BindingName | ts.Expression | ts.VariableDeclarationList): string[] {
    const added: string[] = [];
    const bind = (n: ts.Node) => {
      if (ts.isIdentifier(n) && !this.elements.has(n.text)) {
        this.elements.add(n.text);
        added.push(n.text);
      } else if (ts.isVariableDeclarationList(n)) n.declarations.forEach((d) => bind(d.name));
      else if (ts.isObjectBindingPattern(n) || ts.isArrayBindingPattern(n)) n.elements.forEach((e) => ts.isBindingElement(e) && bind(e.name));
    };
    bind(name);
    return added;
  }

  cost(n: ts.Node): Growth {
    if (ts.isForStatement(n)) {
      const header = n.initializer ? this.cost(n.initializer) : constant;
      let iteration = this.cost(n.statement);
      if (n.condition) iteration = or(iteration, this.cost(n.condition));
      if (n.incrementor) iteration = or(iteration, this.cost(n.incrementor));
      return or(header, times(this.forFactor(n), iteration));
    }
    if (ts.isForOfStatement(n) || ts.isForInStatement(n)) {
      const header = this.cost(n.expression);
      const added = this.bindElement(n.initializer);
      const iteration = this.cost(n.statement);
      for (const name of added) this.elements.delete(name);
      const factor = this.isElementWalk(n.expression) || isConstantCollection(n.expression) ? constant : linear;
      return or(header, times(factor, iteration));
    }
    if (ts.isWhileStatement(n) || ts.isDoStatement(n)) {
      const iteration = or(this.cost(n.statement), this.cost(n.expression));
      return times(this.whileFactor(n.statement), iteration);
    }
    if (ts.isVariableDeclaration(n) && n.initializer && ts.isIdentifier(n.name) && this.isElementWalk(n.initializer)) {
      this.elements.add(n.name.text);
      return this.cost(n.initializer);
    }
    if (ts.isCallExpression(n)) return this.call(n);
    return this.children(n);
  }

  private isElementWalk(x: ts.Expression): boolean {
    x = unwrap(x);
    if (ts.isIdentifier(x)) return this.elements.has(x.text);
    if (ts.isPropertyAccessExpression(x) || ts.isElementAccessExpression(x)) return this.isElementWalk(x.expression);
    if (ts.isCallExpression(x)) return this.isElementWalk(x.expression);
    return false;
  }

  private call(call: ts.CallExpression): Growth {
    let parts = this.cost(call.expression);
    let lambda = constant;
    const bound: string[] = [];
    for (const argument of call.arguments) {
      const value = unwrap(argument);
      if (!isFunctionValue(value)) {
        parts = or(parts, this.cost(argument));
        continue;
      }
      for (const parameter of value.parameters) bound.push(...this.bindElement(parameter.name));
      lambda = or(lambda, this.cost(value.body));
    }
    for (const name of bound) this.elements.delete(name);
    const f = this.current!;
    const target = calleeOf(this.p, f, call);
    if (target) {
      const callee = { ...this.estimate(target) };
      if (callee.degree > 0 || callee.log > 0 || callee.exponential) callee.uncertain = true;
      return or(or(parts, lambda), callee);
    }
    const method = libraryMethod(this.p, f, call);
    if (method && sortMethods.has(method)) return or(parts, { degree: 1, log: 1, exponential: false, uncertain: false });
    if (method && linearMethods.has(method)) return or(parts, times(linear, lambda));
    return or(parts, lambda);
  }

  private forFactor(loop: ts.ForStatement): Growth {
    if (loop.incrementor && isHalving(loop.incrementor)) return logarithmic;
    const condition = loop.condition && unwrap(loop.condition);
    const initializer = loop.initializer && ts.isVariableDeclarationList(loop.initializer) ? loop.initializer.declarations[0]?.initializer : undefined;
    if (condition && ts.isBinaryExpression(condition) && isLiteralNumber(condition.right) && isLiteralNumber(initializer)) return constant;
    if (!loop.initializer && !loop.incrementor) return this.whileFactor(loop.statement);
    return linear;
  }

  /** A loop with a condition only: linear, logarithmic when its body halves a counter; never certain. */
  private whileFactor(body: ts.Node): Growth {
    let halves = false;
    const visit = (c: ts.Node) => {
      if (halves) return;
      if (ts.isExpression(c) && isHalving(c)) halves = true;
      else ts.forEachChild(c, visit);
    };
    visit(body);
    return { ...(halves ? logarithmic : linear), uncertain: true };
  }

  private combine(f: Fn, work: Growth): Growth {
    const self = selfCalls(this.p, f);
    if (self.length === 0) return work;
    const halfNames = new Set<string>();
    let memoized = false;
    walkBody(f, (n) => {
      if (ts.isVariableDeclaration(n) && n.initializer && dividesByTwo(n.initializer) && ts.isIdentifier(n.name)) halfNames.add(n.name.text);
      if (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.EqualsToken && dividesByTwo(n.right) && ts.isIdentifier(n.left)) halfNames.add(n.left.text);
      // A memo lookup: table.has(key) or key in table.
      if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) && n.expression.name.text === "has") memoized = true;
      if (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.InKeyword) memoized = true;
    });
    let halving = false;
    let decrements = false;
    for (const call of self) {
      for (const argument of call.arguments) {
        const visit = (c: ts.Node) => {
          if (ts.isIdentifier(c)) halving ||= halfNames.has(c.text);
          if (ts.isBinaryExpression(c)) decrements ||= c.operatorToken.kind === ts.SyntaxKind.MinusToken || c.operatorToken.kind === ts.SyntaxKind.PlusToken;
          ts.forEachChild(c, visit);
        };
        visit(argument);
        halving ||= dividesByTwo(argument);
      }
    }
    const perPath = this.callsOnPath(f, f.body!);
    let recursion: Growth;
    if (perPath <= 1 && halving) recursion = logarithmic;
    else if (perPath <= 1) recursion = linear;
    else if (halving) recursion = linear;
    else if (memoized || !decrements) recursion = linear;
    else recursion = { degree: 0, log: 0, exponential: true, uncertain: false };
    let total: Growth;
    if (perPath > 1 && halving) total = times(or(work, linear), logarithmic);
    else if (!halving && !decrements) total = or(work, linear);
    else total = times(recursion, work);
    return { ...total, uncertain: true };
  }

  /** Self-calls on the worst path: exclusive branches do not add up, a guard that leaves excludes the rest of its block. */
  private callsOnPath(f: Fn, n: ts.Node): number {
    if (ts.isIfStatement(n)) {
      return this.callsOnPath(f, n.expression) + Math.max(this.callsOnPath(f, n.thenStatement), n.elseStatement ? this.callsOnPath(f, n.elseStatement) : 0);
    }
    if (ts.isConditionalExpression(n)) {
      return this.callsOnPath(f, n.condition) + Math.max(this.callsOnPath(f, n.whenTrue), this.callsOnPath(f, n.whenFalse));
    }
    if (ts.isSwitchStatement(n)) {
      return this.callsOnPath(f, n.expression) + Math.max(0, ...n.caseBlock.clauses.map((c) => this.blockCalls(f, [...c.statements])));
    }
    if (ts.isBlock(n)) return this.blockCalls(f, [...n.statements]);
    if (isFunctionValue(n)) return 0;
    let count = ts.isCallExpression(n) && calleeOf(this.p, f, n) === f ? 1 : 0;
    ts.forEachChild(n, (c) => {
      count += this.callsOnPath(f, c);
    });
    return count;
  }

  private blockCalls(f: Fn, list: ts.Statement[]): number {
    if (list.length === 0) return 0;
    const [first, ...rest] = list;
    if (ts.isIfStatement(first) && !first.elseStatement && !canComplete(first.thenStatement)) {
      return this.callsOnPath(f, first.expression) + Math.max(this.callsOnPath(f, first.thenStatement), this.blockCalls(f, rest));
    }
    return this.callsOnPath(f, first) + this.blockCalls(f, rest);
  }
}

function isConstantCollection(x: ts.Expression): boolean {
  x = unwrap(x);
  return ts.isArrayLiteralExpression(x) || ts.isStringLiteral(x) || ts.isNoSubstitutionTemplateLiteral(x);
}

function canComplete(statement: ts.Statement): boolean {
  const last = ts.isBlock(statement) ? statement.statements[statement.statements.length - 1] : statement;
  return !last || !(ts.isReturnStatement(last) || ts.isThrowStatement(last) || ts.isBreakStatement(last) || ts.isContinueStatement(last));
}

/** Division by two: x / 2, x >> 1, Math.floor(x / 2). */
export function dividesByTwo(n: ts.Node): boolean {
  let found = false;
  const visit = (c: ts.Node) => {
    if (found) return;
    if (ts.isBinaryExpression(c) && ts.isNumericLiteral(c.right)) {
      const op = c.operatorToken.kind;
      if ((op === ts.SyntaxKind.SlashToken && c.right.text === "2") || ((op === ts.SyntaxKind.GreaterThanGreaterThanToken || op === ts.SyntaxKind.GreaterThanGreaterThanGreaterThanToken) && c.right.text === "1")) found = true;
    }
    ts.forEachChild(c, visit);
  };
  visit(n);
  return found;
}

/** A step that divides or multiplies a counter: /=, *=, >>=, <<=, or i = i / 2. */
function isHalving(n: ts.Node): boolean {
  if (!ts.isBinaryExpression(n)) return false;
  const op = n.operatorToken.kind;
  if (op === ts.SyntaxKind.SlashEqualsToken || op === ts.SyntaxKind.AsteriskEqualsToken || op === ts.SyntaxKind.GreaterThanGreaterThanEqualsToken
    || op === ts.SyntaxKind.GreaterThanGreaterThanGreaterThanEqualsToken || op === ts.SyntaxKind.LessThanLessThanEqualsToken) return true;
  return op === ts.SyntaxKind.EqualsToken && dividesByTwo(n.right);
}
