import { builtinModules } from "node:module";
import path from "node:path";
import ts from "typescript";
import { ordinal } from "./config.ts";
import type { Entry, Fn, Module, Place, Project, SourceInfo, TypeUnit } from "./project.ts";
import { unwrap } from "./project.ts";

/** One occurrence of a dependency between units, or an import between modules. */
export interface Edge {
  from: string;
  to: string;
  kind: string;
  external: boolean;
  stdlib: boolean;
  toType: boolean;
  /** Erased at run time: a type annotation, an interface, `import type` (D-055). */
  typeOnly: boolean;
  place: Place;
}

const builtins = new Set(builtinModules.flatMap((name) => [name, `node:${name}`]));

/** The symbol a reference means, through import aliases. */
export function resolveSymbol(checker: ts.TypeChecker, node: ts.Node): ts.Symbol | undefined {
  let symbol = ts.isShorthandPropertyAssignment(node.parent) && node.parent.name === node
    ? checker.getShorthandAssignmentValueSymbol(node.parent)
    : checker.getSymbolAtLocation(node);
  if (symbol && symbol.flags & ts.SymbolFlags.Alias) {
    try {
      symbol = checker.getAliasedSymbol(symbol);
    } catch {
      return undefined;
    }
  }
  // CommonJS: `const { f } = require("./m")` binds a local name; the function or class behind it is its type's symbol.
  if (symbol && symbol.flags & ts.SymbolFlags.Variable && fromRequire(symbol.valueDeclaration)) {
    const target = checker.getTypeOfSymbolAtLocation(symbol, node).symbol;
    if (target && target.flags & (ts.SymbolFlags.Function | ts.SymbolFlags.Class)) return target;
  }
  return symbol;
}

/** Whether a variable or a destructured name is initialized from `require(…)` or a property of it. */
function fromRequire(declaration: ts.Declaration | undefined): boolean {
  let node: ts.Node | undefined = declaration;
  while (node && (ts.isBindingElement(node) || ts.isObjectBindingPattern(node) || ts.isArrayBindingPattern(node))) node = node.parent;
  if (!node || !ts.isVariableDeclaration(node) || !node.initializer) return false;
  let value = unwrap(node.initializer);
  while (ts.isPropertyAccessExpression(value)) value = unwrap(value.expression);
  return ts.isCallExpression(value) && ts.isIdentifier(value.expression) && value.expression.text === "require";
}

/** The project entry a symbol is declared as. */
export function entryOf(p: Project, symbol: ts.Symbol | undefined): Entry | undefined {
  for (const declaration of symbol?.declarations ?? []) {
    const entry = p.lookup(declaration);
    if (entry) return entry;
  }
  return undefined;
}

/** The unit an entry belongs to: the type itself, the owner of a member or method, or a free function. */
export function unitOf(entry: Entry | undefined): { id: string; isType: boolean; type?: TypeUnit; fn?: Fn } | undefined {
  if (!entry) return undefined;
  if ("type" in entry) return { id: entry.type.id, isType: true, type: entry.type };
  if ("member" in entry) return { id: entry.member.owner.id, isType: true, type: entry.member.owner };
  if ("fn" in entry) return entry.fn.owner ? { id: entry.fn.owner.id, isType: true, type: entry.fn.owner, fn: entry.fn } : { id: entry.fn.id, isType: false, fn: entry.fn };
  return undefined;
}

/** The package a declaration file belongs to, `@types/x` read as `x`; undefined outside node_modules. */
function packageOf(fileName: string): string | undefined {
  const normalized = fileName.split(path.sep).join("/");
  const at = normalized.lastIndexOf("/node_modules/");
  if (at < 0) return undefined;
  const parts = normalized.slice(at + "/node_modules/".length).split("/");
  let name = parts[0].startsWith("@") ? `${parts[0]}/${parts[1]}` : parts[0];
  if (name.startsWith("@types/")) {
    const inner = name.slice("@types/".length);
    name = inner.includes("__") ? `@${inner.replace("__", "/")}` : inner;
  }
  return name;
}

/** The id of a declaration outside the analyzed files: library, Node.js, another language of the project. */
function externalOf(p: Project, symbol: ts.Symbol): { id: string; stdlib: boolean; isType: boolean } | undefined {
  const declaration = symbol.declarations?.[0];
  if (!declaration) return undefined;
  const flags = symbol.flags;
  let owner: ts.Node | undefined;
  let name = symbol.name;
  let isType = !!(flags & (ts.SymbolFlags.Class | ts.SymbolFlags.Interface | ts.SymbolFlags.Enum | ts.SymbolFlags.TypeAlias));
  if (!isType && !(flags & ts.SymbolFlags.Function)) {
    if (!(flags & (ts.SymbolFlags.Method | ts.SymbolFlags.Property | ts.SymbolFlags.Accessor | ts.SymbolFlags.Constructor))) return undefined;
    owner = declaration.parent;
    if (!owner || !(ts.isClassLike(owner) || ts.isInterfaceDeclaration(owner)) || !owner.name) return undefined;
    name = owner.name.text;
    isType = true;
  }
  if (name === "__type" || name === "default" || name.startsWith("__")) return undefined;
  const sf = declaration.getSourceFile();
  const pkg = packageOf(sf.fileName);
  const isLibrary = /[\\/]typescript[\\/]lib[\\/]lib\.[^\\/]*\.d\.ts$/.test(sf.fileName);
  if (isLibrary) return { id: name, stdlib: true, isType };
  if (pkg === "node" || pkg === "undici-types") return { id: `node.${name}`, stdlib: true, isType };
  if (pkg) return { id: `${pkg}.${name}`, stdlib: false, isType };
  const rel = p.relative(sf.fileName);
  if (rel.startsWith("..")) return undefined;
  return { id: `${rel.replace(/\.d\.[cm]?ts$|\.[^./]+$/, "")}.${name}`, stdlib: false, isType };
}

/** Whether a node lies in a type position below `root`: an annotation, a type argument, `implements`. */
export function inTypePosition(node: ts.Node, root: ts.Node): boolean {
  for (let n: ts.Node = node; n && n !== root; n = n.parent) {
    if (ts.isExpressionWithTypeArguments(n) && ts.isHeritageClause(n.parent)) {
      return n.parent.token === ts.SyntaxKind.ImplementsKeyword || ts.isInterfaceDeclaration(n.parent.parent);
    }
    if (ts.isTypeNode(n)) return true;
    if (ts.isTypeAliasDeclaration(n) || ts.isInterfaceDeclaration(n)) return true;
  }
  return false;
}

function isCallee(node: ts.Node): boolean {
  const parent = node.parent;
  if ((ts.isCallExpression(parent) || ts.isNewExpression(parent)) && parent.expression === node) return true;
  if (ts.isTaggedTemplateExpression(parent) && parent.tag === node) return true;
  if ((ts.isJsxOpeningElement(parent) || ts.isJsxSelfClosingElement(parent) || ts.isJsxClosingElement(parent)) && parent.tagName === node) return true;
  if (ts.isPropertyAccessExpression(parent) && parent.name === node) return isCallee(parent);
  return false;
}

function inHeritage(node: ts.Node, unit: ts.Node): boolean {
  for (let n: ts.Node = node; n && n !== unit; n = n.parent) {
    if (ts.isExpressionWithTypeArguments(n)) return ts.isHeritageClause(n.parent) && n.parent.parent === unit && isWithin(node, n.expression);
  }
  return false;
}

function isWithin(node: ts.Node, container: ts.Node): boolean {
  return node.pos >= container.pos && node.end <= container.end;
}

/** Visits every identifier below a node, the names of property accesses included. */
export function forEachIdentifier(node: ts.Node, visit: (id: ts.Identifier) => void): void {
  const walk = (n: ts.Node) => {
    if (ts.isIdentifier(n)) visit(n);
    else ts.forEachChild(n, walk);
  };
  walk(node);
}

/** Dependency occurrences by spec/metrics.md: rolled up to units, self-loops dropped. */
export function collectEdges(p: Project): Edge[] {
  const edges: Edge[] = [];
  const visitUnit = (from: string, unitNode: ts.Node, info: SourceInfo, erased: boolean) => {
    const checker = info.checker;
    forEachIdentifier(unitNode, (id) => {
      const symbol = resolveSymbol(checker, id);
      if (!symbol) return;
      const typeOnly = erased || inTypePosition(id, unitNode);
      let kind = "type-ref";
      if (inHeritage(id, unitNode)) kind = "inheritance";
      else if (isCallee(id)) kind = "call";
      else if (ts.isPropertyAccessExpression(id.parent) && id.parent.name === id && (symbol.flags & ts.SymbolFlags.EnumMember || isStaticMember(symbol))) kind = "call";
      const entry = entryOf(p, symbol);
      const place = p.nodePlace(id);
      if (entry) {
        const unit = unitOf(entry);
        if (!unit || unit.id === from) return;
        // An interface or a type alias does not exist at run time: every reference to it is erased (D-055).
        const erasedTarget = unit.type?.kind === "interface" || unit.type?.kind === "type";
        // A field read is a type-ref; a static member, an enum value, a call or a creation is a call.
        edges.push({ from, to: unit.id, kind, external: false, stdlib: false, toType: unit.isType, typeOnly: typeOnly || erasedTarget, place });
        return;
      }
      if (symbol.flags & (ts.SymbolFlags.Variable | ts.SymbolFlags.TypeParameter)) return;
      const external = externalOf(p, symbol);
      if (external) edges.push({ from, to: external.id, kind, external: true, stdlib: external.stdlib, toType: external.isType, typeOnly, place });
    });
  };
  for (const m of p.modules) {
    edges.push(...importEdges(p, m));
    for (const t of m.types) {
      for (const part of t.parts) visitUnit(t.id, part, m.file, t.kind === "interface" || t.kind === "type");
    }
    for (const f of m.functions) visitUnit(f.id, f.node, m.file, false);
  }
  return edges;
}

function isStaticMember(symbol: ts.Symbol): boolean {
  const declaration = symbol.valueDeclaration;
  return !!declaration && ts.canHaveModifiers(declaration) && (ts.getModifiers(declaration)?.some((m) => m.kind === ts.SyntaxKind.StaticKeyword) ?? false);
}

/** The module specifiers of a file with the node that names them and whether the import is erased at run time. */
function moduleReferences(info: SourceInfo): { specifier: ts.StringLiteralLike; statement: ts.Node; typeOnly: boolean }[] {
  const sf = info.sf;
  const list: { specifier: ts.StringLiteralLike; statement: ts.Node; typeOnly: boolean }[] = [];
  const javascript = /\.[cm]?jsx?$/.test(sf.fileName);
  const preserved = !!(info.options.verbatimModuleSyntax || info.options.preserveValueImports);
  const usedAsValue = valueBindings(info);
  for (const statement of sf.statements) {
    if (ts.isImportDeclaration(statement) && ts.isStringLiteralLike(statement.moduleSpecifier)) {
      const clause = statement.importClause;
      let typeOnly = !!clause?.isTypeOnly;
      if (!typeOnly && clause && !javascript) {
        const named = clause.namedBindings;
        const bindings: ts.Node[] = [];
        if (clause.name) bindings.push(clause);
        if (named && ts.isNamespaceImport(named)) bindings.push(named);
        if (named && ts.isNamedImports(named)) bindings.push(...named.elements.filter((e) => !e.isTypeOnly));
        const explicitTypes = named && ts.isNamedImports(named) && named.elements.length > 0 && named.elements.every((e) => e.isTypeOnly) && !clause.name;
        // TypeScript drops an import whose bindings are used only as types, unless the options keep it (D-055).
        typeOnly = !!explicitTypes || (!preserved && bindings.length > 0 && bindings.every((b) => !usedAsValue.has(b)));
      }
      list.push({ specifier: statement.moduleSpecifier, statement, typeOnly });
    } else if (ts.isExportDeclaration(statement) && statement.moduleSpecifier && ts.isStringLiteralLike(statement.moduleSpecifier)) {
      list.push({ specifier: statement.moduleSpecifier, statement, typeOnly: statement.isTypeOnly });
    } else if (ts.isImportEqualsDeclaration(statement) && ts.isExternalModuleReference(statement.moduleReference) && ts.isStringLiteralLike(statement.moduleReference.expression)) {
      list.push({ specifier: statement.moduleReference.expression, statement, typeOnly: statement.isTypeOnly });
    }
  }
  const walk = (n: ts.Node) => {
    if (ts.isCallExpression(n) && n.arguments.length >= 1 && ts.isStringLiteralLike(n.arguments[0])) {
      const callee = unwrap(n.expression);
      if (n.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(callee) && callee.text === "require")) {
        list.push({ specifier: n.arguments[0], statement: n, typeOnly: false });
      }
    }
    if (ts.isImportTypeNode(n)) return;
    ts.forEachChild(n, walk);
  };
  walk(sf);
  return list;
}

/** Import bindings of a file that some expression reads as a value. */
function valueBindings(info: SourceInfo): Set<ts.Node> {
  const used = new Set<ts.Node>();
  const checker = info.checker;
  const sf = info.sf;
  const walk = (n: ts.Node) => {
    if (ts.isImportDeclaration(n)) return;
    if (ts.isIdentifier(n)) {
      const symbol = checker.getSymbolAtLocation(n);
      if (symbol && symbol.flags & ts.SymbolFlags.Alias && !inTypePosition(n, sf)) {
        for (const declaration of symbol.declarations ?? []) used.add(declaration);
      }
      return;
    }
    if (ts.isShorthandPropertyAssignment(n)) {
      const symbol = checker.getSymbolAtLocation(n.name);
      for (const declaration of symbol?.declarations ?? []) used.add(declaration);
    }
    ts.forEachChild(n, walk);
  };
  walk(sf);
  return used;
}

function importEdges(p: Project, m: Module): Edge[] {
  const info = m.file;
  const edges: Edge[] = [];
  for (const { specifier, statement, typeOnly } of moduleReferences(info)) {
    const text = specifier.text;
    const place = p.nodePlace(statement);
    let target: string;
    let external = true;
    let stdlib = false;
    const resolved = builtins.has(text) ? undefined : p.resolveModule(text, info);
    const own = resolved && p.moduleOfFile(resolved.resolvedFileName);
    if (own) {
      target = own.id;
      external = false;
    } else if (builtins.has(text)) {
      target = text.replace(/^node:/, "");
      stdlib = true;
    } else if (resolved && !resolved.isExternalLibraryImport && !p.relative(resolved.resolvedFileName).startsWith("..")) {
      // A project file these facts do not describe: the other language, a declaration file or an excluded file.
      target = p.relative(resolved.resolvedFileName).replace(/\.d\.[cm]?ts$|\.[^./]+$/, "");
    } else if (text.startsWith(".") || text.startsWith("/")) {
      target = p.relative(path.resolve(path.dirname(info.sf.fileName), text)).replace(/\.[cm]?[jt]sx?$/, "");
    } else {
      target = text.startsWith("@") ? text.split("/").slice(0, 2).join("/") : text.split("/")[0];
    }
    if (target === m.id) continue;
    edges.push({ from: m.id, to: target, kind: "import", external, stdlib, toType: false, typeOnly, place });
  }
  return edges;
}

/** A directed graph over string keys. */
export class Graph {
  next = new Map<string, Set<string>>();
  prev = new Map<string, Set<string>>();

  node(n: string): void {
    if (!this.next.has(n)) {
      this.next.set(n, new Set());
      this.prev.set(n, new Set());
    }
  }

  edge(a: string, b: string): void {
    this.node(a);
    this.node(b);
    this.next.get(a)!.add(b);
    this.prev.get(b)!.add(a);
  }
}

/**
 * The unit graph and the module graph over every edge, for coupling and blast radius, and the same graphs over
 * run-time edges only, for cycles: a cycle closed only by erased references does not exist when the code runs (D-055).
 */
export interface Graphs {
  units: Graph;
  modules: Graph;
  runtimeUnits: Graph;
  runtimeModules: Graph;
  moduleOf: Map<string, Module>;
  radius: Map<string, number>;
}

export function buildGraphs(p: Project, edges: Edge[]): Graphs {
  const g: Graphs = { units: new Graph(), modules: new Graph(), runtimeUnits: new Graph(), runtimeModules: new Graph(), moduleOf: new Map(), radius: new Map() };
  for (const m of p.modules) {
    g.modules.node(m.id);
    g.runtimeModules.node(m.id);
    for (const unit of [...m.types, ...m.functions]) {
      g.moduleOf.set(unit.id, m);
      g.units.node(unit.id);
      g.runtimeUnits.node(unit.id);
    }
  }
  for (const e of edges) {
    if (e.external) continue;
    const graphs = e.typeOnly ? [[g.units, g.modules]] : [[g.units, g.modules], [g.runtimeUnits, g.runtimeModules]];
    for (const [units, modules] of graphs) {
      if (e.kind === "import") {
        modules.edge(e.from, e.to);
        continue;
      }
      units.edge(e.from, e.to);
      const a = g.moduleOf.get(e.from);
      const b = g.moduleOf.get(e.to);
      if (a && b && a !== b) modules.edge(a.id, b.id);
    }
  }
  for (const unit of g.units.next.keys()) g.radius.set(unit, reach(g.units, unit));
  return g;
}

function reach(g: Graph, start: string): number {
  const seen = new Set([start]);
  const queue = [start];
  while (queue.length > 0) {
    const current = queue.shift()!;
    for (const dependent of g.prev.get(current) ?? []) {
      if (!seen.has(dependent)) {
        seen.add(dependent);
        queue.push(dependent);
      }
    }
  }
  return seen.size - 1;
}

/** Strongly connected components with two or more members (Tarjan), iteratively. */
export function components(g: Graph): string[][] {
  const index = new Map<string, number>();
  const low = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const result: string[][] = [];
  let counter = 0;
  for (const start of [...g.next.keys()].sort(ordinal)) {
    if (index.has(start)) continue;
    const work: { node: string; next: string[] }[] = [];
    const enter = (n: string) => {
      index.set(n, counter);
      low.set(n, counter);
      counter++;
      stack.push(n);
      onStack.add(n);
      work.push({ node: n, next: [...g.next.get(n)!].sort(ordinal) });
    };
    enter(start);
    while (work.length > 0) {
      const top = work[work.length - 1];
      if (top.next.length > 0) {
        const successor = top.next.shift()!;
        if (!index.has(successor)) enter(successor);
        else if (onStack.has(successor)) low.set(top.node, Math.min(low.get(top.node)!, index.get(successor)!));
        continue;
      }
      work.pop();
      if (work.length > 0) {
        const parent = work[work.length - 1].node;
        low.set(parent, Math.min(low.get(parent)!, low.get(top.node)!));
      }
      if (low.get(top.node) !== index.get(top.node)) continue;
      const component: string[] = [];
      for (;;) {
        const member = stack.pop()!;
        onStack.delete(member);
        component.push(member);
        if (member === top.node) break;
      }
      if (component.length > 1) result.push(component.sort(ordinal));
    }
  }
  return result.sort((a, b) => ordinal(a[0], b[0]));
}

export function simpleName(id: string): string {
  const tail = id.slice(id.lastIndexOf("/") + 1);
  return tail.slice(tail.lastIndexOf(".") + 1);
}
