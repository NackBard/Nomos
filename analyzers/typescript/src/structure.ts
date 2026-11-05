import ts from "typescript";
import { ordinal } from "./config.ts";
import { entryOf } from "./graph.ts";
import type { Fn, Member, Project, TypeUnit } from "./project.ts";

/** Structure of types and functions for facts 1.3.0, as spec/structure.md defines it. */

export interface FactsMember {
  name: string;
  kind: string;
  visibility: string;
  typeName?: string;
  type?: string;
  isStatic?: boolean;
  isCollection?: boolean;
}

export interface FactsParameter { name: string; typeName?: string }

/** Type text as written, with line breaks and runs of spaces collapsed. */
export function typeText(node: ts.Node | undefined): string | undefined {
  if (!node) return undefined;
  return node.getText().replace(/\s+/g, " ").trim() || undefined;
}

/** Generic collections of the standard library whose last type argument is the element. */
const collections = new Set(["Array", "ReadonlyArray", "Set", "ReadonlySet", "Map", "ReadonlyMap", "WeakMap", "WeakSet", "Iterable", "AsyncIterable", "IterableIterator"]);

/** The project type a member is about: the element of an array or collection, through unions with null and undefined. */
function memberTarget(p: Project, checker: ts.TypeChecker, type: ts.Type): { type?: string; collection: boolean } {
  let collection = false;
  if (type.isUnion()) {
    const rest = type.types.filter((t) => !(t.flags & (ts.TypeFlags.Null | ts.TypeFlags.Undefined)));
    if (rest.length !== 1) return { collection };
    type = rest[0];
  }
  const reference = type as ts.TypeReference;
  const name = type.symbol?.name ?? type.aliasSymbol?.name;
  if (name && collections.has(name) && reference.target) {
    const args = checker.getTypeArguments(reference);
    if (args.length > 0) {
      collection = true;
      type = args[args.length - 1];
    }
  }
  const entry = entryOf(p, type.aliasSymbol ?? type.symbol);
  return { type: entry && "type" in entry ? entry.type.id : undefined, collection };
}

function memberFacts(p: Project, member: Member): FactsMember {
  const result: FactsMember = { name: member.name, kind: member.kind, visibility: member.visibility };
  if (member.kind === "literal") return result;
  const typeName = typeText(member.typeNode);
  if (typeName) result.typeName = typeName;
  const checker = member.owner.module.file.checker;
  if (member.typeNode) {
    const target = memberTarget(p, checker, checker.getTypeFromTypeNode(member.typeNode));
    if (target.type) result.type = target.type;
    if (target.collection) result.isCollection = true;
  }
  if (member.isStatic) result.isStatic = true;
  return result;
}

/** Own fields, accessor pairs and enum values in declaration order. */
export function members(p: Project, t: TypeUnit): FactsMember[] | undefined {
  if (t.members.length === 0) return undefined;
  return [...t.members].sort((a, b) => a.node.pos - b.node.pos).map((m) => memberFacts(p, m));
}

/** Parameters as written: `...` of a rest parameter is part of the type; a `this` parameter is not one. */
export function parameters(f: Fn): FactsParameter[] {
  return f.fn.parameters
    .filter((x) => !(ts.isIdentifier(x.name) && x.name.text === "this"))
    .map((x) => {
      const result: FactsParameter = { name: x.name.getText().replace(/\s+/g, " ") };
      const typeName = typeText(x.type);
      if (typeName) result.typeName = x.dotDotDotToken ? `...${typeName}` : typeName;
      else if (x.dotDotDotToken) result.typeName = "...";
      return result;
    });
}

/** Result type as written; none for a constructor, void and a function without an annotation. */
export function returnTypeName(f: Fn): string | undefined {
  if (f.kind === "constructor" || !f.fn.type || f.fn.type.kind === ts.SyntaxKind.VoidKeyword) return undefined;
  return typeText(f.fn.type);
}

/**
 * Project interfaces a class matches without naming them (structural typing): not in its own implements or extends
 * and not inherited from a base class. Generic types and interfaces without members are left out (spec/structure.md).
 */
export function satisfies(p: Project, t: TypeUnit, all: TypeUnit[]): string[] | undefined {
  if (t.kind !== "class" || t.typeParameters.length > 0 || !ts.isClassDeclaration(t.node)) return undefined;
  const checker = t.module.file.checker;
  const named = new Set<string>();
  const collect = (declaration: ts.ClassDeclaration | ts.InterfaceDeclaration, seen: Set<ts.Node>) => {
    if (seen.has(declaration)) return;
    seen.add(declaration);
    for (const clause of declaration.heritageClauses ?? []) {
      for (const expression of clause.types) {
        const symbol = checker.getSymbolAtLocation(expression.expression);
        const target = symbol && symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol;
        for (const d of target?.declarations ?? []) {
          const entry = p.lookup(d);
          if (entry && "type" in entry) named.add(entry.type.id);
          if (ts.isClassDeclaration(d) || ts.isInterfaceDeclaration(d)) collect(d, seen);
        }
      }
    }
  };
  collect(t.node, new Set());
  const instance = checker.getTypeAtLocation(t.node);
  const assignable = (checker as unknown as { isTypeAssignableTo?: (a: ts.Type, b: ts.Type) => boolean }).isTypeAssignableTo;
  if (!assignable) return undefined;
  const list: string[] = [];
  for (const candidate of all) {
    if (candidate.kind !== "interface" || candidate.typeParameters.length > 0 || named.has(candidate.id)) continue;
    if (candidate.members.length + candidate.methods.length === 0) continue;
    // The checker of the class's program sees the interface through its own copy of the file.
    const declaration = candidate.node;
    const other = checker.getTypeAtLocation(otherCopy(t, declaration) ?? declaration);
    if (assignable.call(checker, instance, other)) list.push(candidate.id);
  }
  return list.length > 0 ? list.sort(ordinal) : undefined;
}

/** The declaration of `node` as the program of `t` parsed it, when the two live in different programs. */
function otherCopy(t: TypeUnit, node: ts.Node): ts.Node | undefined {
  const sf = node.getSourceFile();
  const own = t.module.file.sf;
  if (own === sf) return node;
  const copy = t.module.file.program.getSourceFile(sf.fileName);
  if (!copy) return undefined;
  let found: ts.Node | undefined;
  const visit = (n: ts.Node) => {
    if (found) return;
    if (n.pos === node.pos && n.kind === node.kind) found = n;
    else ts.forEachChild(n, visit);
  };
  visit(copy);
  return found;
}
