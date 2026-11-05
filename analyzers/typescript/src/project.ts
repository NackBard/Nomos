import fs from "node:fs";
import path from "node:path";
import ts from "typescript";
import { ordinal } from "./config.ts";
import { Directives } from "./suppress.ts";

/** Extensions each language reads; declaration files (.d.ts) are types of other code, not the analyzed program. */
export const extensions: Record<string, string[]> = {
  typescript: [".ts", ".tsx", ".mts", ".cts"],
  javascript: [".js", ".jsx", ".mjs", ".cjs"],
};

/** Folders that hold dependencies or build output rather than sources (D-055). */
const skippedFolders = new Set(["node_modules", "bower_components", "dist", "out", "build", "coverage"]);

/** A source range; the file is relative to the root with forward slashes, lines and columns from 1, end exclusive. */
export interface Place { file: string; startLine: number; startColumn: number; endLine: number; endColumn: number }

/** A lexical token of a file; comments are not tokens. */
export interface Token { line: number; kind: ts.SyntaxKind; text: string }

/** One analyzed source file: a module of its own (D-055). */
export interface SourceInfo {
  path: string;
  lines: number;
  loc: number;
  tokens: Token[];
  directives: Directives;
  importLines: Set<number>;
  comments: { text: string; line: number; endLine: number }[];
  sf: ts.SourceFile;
  checker: ts.TypeChecker;
  program: ts.Program;
  options: ts.CompilerOptions;
  module: Module;
  broken: boolean;
}

export interface ImportRef { target: string; external: boolean; stdlib: boolean; typeOnly: boolean; place: Place }

export interface Module {
  id: string;
  name: string;
  file: SourceInfo;
  types: TypeUnit[];
  functions: Fn[];
  globals: Global[];
  imports: ImportRef[];
}

/** A module-level `let` or `var`. */
export interface Global { id: string; name: string; place: Place; node: ts.VariableDeclaration }

/** State of a type: a field, an accessor pair (property) or an enum value. */
export interface Member {
  name: string;
  kind: "field" | "property" | "literal";
  node: ts.Node;
  owner: TypeUnit;
  visibility: string;
  isStatic: boolean;
  isReadonly: boolean;
  typeNode?: ts.TypeNode;
  /** A setter exists (accessor pair) or the field is not readonly. */
  mutable: boolean;
}

export interface TypeUnit {
  id: string;
  name: string;
  module: Module;
  /** class, interface, enum or type (an alias). */
  kind: string;
  node: ts.ClassDeclaration | ts.InterfaceDeclaration | ts.EnumDeclaration | ts.TypeAliasDeclaration;
  /** Further declarations merged into this one (interfaces declared twice). */
  parts: ts.Node[];
  place: Place;
  isAbstract: boolean;
  members: Member[];
  methods: Fn[];
  typeParameters: string[];
}

export type FunctionNode = ts.SignatureDeclaration & { body?: ts.Node };

export interface Fn {
  id: string;
  name: string;
  module: Module;
  owner?: TypeUnit;
  place: Place;
  /** The declaration a symbol points to: the function, method, property or variable declaration. */
  node: ts.Node;
  /** The function-like node with parameters, result and body. */
  fn: FunctionNode;
  body?: ts.Node;
  kind: "function" | "method" | "constructor" | "accessor";
  visibility: string;
  isStatic: boolean;
  isAbstract: boolean;
  file: SourceInfo;
}

/** What a declaration of the project is in the model. */
export type Entry = { type: TypeUnit } | { fn: Fn } | { member: Member } | { global: Global };

/** Unwraps parentheses, `as`, `satisfies` and `!` around an expression. */
export function unwrap(node: ts.Expression): ts.Expression {
  while (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isSatisfiesExpression(node) || ts.isNonNullExpression(node) || ts.isTypeAssertionExpression(node)) {
    node = node.expression;
  }
  return node;
}

export function isFunctionValue(node: ts.Node | undefined): node is ts.ArrowFunction | ts.FunctionExpression {
  return !!node && (ts.isArrowFunction(node) || ts.isFunctionExpression(node));
}

function hasModifier(node: ts.Node, kind: ts.SyntaxKind): boolean {
  return ts.canHaveModifiers(node) && (ts.getModifiers(node)?.some((m) => m.kind === kind) ?? false);
}

function globMatches(pattern: string, value: string): boolean {
  let expression = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
  expression = expression.replaceAll("**/", "\u0000").replaceAll("**", "\u0001").replaceAll("*", "[^/]*");
  expression = expression.replaceAll("\u0000", "(.*/)?").replaceAll("\u0001", ".*");
  return new RegExp(`^${expression}$`).test(value);
}

function anyGlob(patterns: string[], value: string): boolean {
  return patterns.some((p) => globMatches(p, value));
}

const defaultOptions: ts.CompilerOptions = {
  allowJs: true,
  jsx: ts.JsxEmit.Preserve,
  target: ts.ScriptTarget.ESNext,
  module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  strict: true,
  resolveJsonModule: true,
  esModuleInterop: true,
  allowSyntheticDefaultImports: true,
};

/** Everything loaded from a root. */
export class Project {
  readonly root: string;
  readonly language: string;
  files: SourceInfo[] = [];
  modules: Module[] = [];
  types = new Map<string, TypeUnit>();
  functions = new Map<string, Fn>();
  /** Declarations of the project by `file#position`. */
  index = new Map<string, Entry>();
  /** Notes for facts.diagnostics, such as a tsconfig that could not be read. */
  notes: { level: string; message: string; file?: string; code: string }[] = [];
  private analyzed = new Set<string>();
  private ids = new Set<string>();
  private byFile = new Map<string, Module>();
  private caches = new Map<ts.CompilerOptions, ts.ModuleResolutionCache>();

  constructor(root: string, language: string) {
    this.root = path.resolve(root);
    this.language = language;
  }

  /** The path relative to the root with forward slashes. */
  relative(fileName: string): string {
    return path.relative(this.root, path.resolve(fileName)).split(path.sep).join("/");
  }

  place(sf: ts.SourceFile, start: number, end: number): Place {
    const a = sf.getLineAndCharacterOfPosition(start);
    const b = sf.getLineAndCharacterOfPosition(end);
    return { file: this.relative(sf.fileName), startLine: a.line + 1, startColumn: a.character + 1, endLine: b.line + 1, endColumn: b.character + 1 };
  }

  /** From the first token of the declaration without decorators and documentation comments to its end. */
  nodePlace(node: ts.Node): Place {
    const sf = node.getSourceFile();
    return this.place(sf, startOf(node, sf), node.getEnd());
  }

  key(node: ts.Node): string {
    return `${this.relative(node.getSourceFile().fileName)}#${node.pos}`;
  }

  lookup(node: ts.Node | undefined): Entry | undefined {
    return node ? this.index.get(this.key(node)) : undefined;
  }

  /** Whether a source file is one of the analyzed files. */
  isAnalyzed(sf: ts.SourceFile): boolean {
    return this.analyzed.has(path.resolve(sf.fileName));
  }

  /** The module of an analyzed file. */
  moduleOfFile(fileName: string): Module | undefined {
    return this.byFile.get(path.resolve(fileName));
  }

  /** Resolves a module specifier the way the file's program does, with one cache per set of options. */
  resolveModule(specifier: string, info: SourceInfo): ts.ResolvedModuleFull | undefined {
    let cache = this.caches.get(info.options);
    if (!cache) {
      cache = ts.createModuleResolutionCache(this.root, (f) => (ts.sys.useCaseSensitiveFileNames ? f : f.toLowerCase()), info.options);
      this.caches.set(info.options, cache);
    }
    return ts.resolveModuleName(specifier, info.sf.fileName, info.options, ts.sys, cache).resolvedModule;
  }

  allTypes(): TypeUnit[] {
    return [...this.types.values()].sort((a, b) => ordinal(a.id, b.id));
  }

  allFunctions(): Fn[] {
    return [...this.functions.values()].sort((a, b) => ordinal(a.id, b.id));
  }

  private uniqueId(id: string): string {
    let candidate = id;
    for (let n = 2; this.ids.has(candidate); n++) candidate = `${id}#${n}`;
    this.ids.add(candidate);
    return candidate;
  }

  /** Lists the files of the language under the root, groups them by their nearest config and builds one program per group. */
  load(include: string[], exclude: string[]): void {
    const own = new Set(extensions[this.language]);
    const found: string[] = [];
    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => ordinal(a.name, b.name))) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (!skippedFolders.has(entry.name) && !entry.name.startsWith(".")) walk(full);
        } else if (entry.isFile() && own.has(path.extname(entry.name)) && !/\.d\.[cm]?ts$/.test(entry.name) && !/\.min\.js$/.test(entry.name)) {
          const rel = this.relative(full);
          if ((include.length === 0 || anyGlob(include, rel)) && !anyGlob(exclude, rel)) found.push(full);
        }
      }
    };
    walk(this.root);
    for (const file of found) this.analyzed.add(path.resolve(file));

    const groups = new Map<string, string[]>();
    const nearest = new Map<string, string>();
    const configOf = (dir: string): string => {
      const known = nearest.get(dir);
      if (known !== undefined) return known;
      const names = this.language === "javascript" ? ["jsconfig.json", "tsconfig.json"] : ["tsconfig.json"];
      let result = "";
      for (const name of names) {
        if (fs.existsSync(path.join(dir, name))) {
          result = path.join(dir, name);
          break;
        }
      }
      if (!result) {
        const parent = path.dirname(dir);
        result = dir === this.root || parent === dir || !parent.startsWith(this.root) ? "" : configOf(parent);
      }
      nearest.set(dir, result);
      return result;
    };
    for (const file of found) {
      const config = configOf(path.dirname(file));
      groups.set(config, [...(groups.get(config) ?? []), file]);
    }

    const sources: { sf: ts.SourceFile; program: ts.Program; options: ts.CompilerOptions }[] = [];
    for (const config of [...groups.keys()].sort(ordinal)) {
      const options = { ...this.optionsOf(config), noEmit: true, allowJs: true, skipLibCheck: true };
      const program = ts.createProgram({ rootNames: groups.get(config)!, options });
      for (const file of groups.get(config)!) {
        const sf = program.getSourceFile(file);
        if (sf) sources.push({ sf, program, options });
      }
    }
    sources.sort((a, b) => ordinal(this.relative(a.sf.fileName), this.relative(b.sf.fileName)));
    const moduleIds = this.moduleIds(sources.map((s) => this.relative(s.sf.fileName)));
    for (const { sf, program, options } of sources) this.addFile(sf, program, options, moduleIds.get(this.relative(sf.fileName))!);
    for (const m of this.modules) this.declareModule(m);
  }

  private optionsOf(config: string): ts.CompilerOptions {
    if (!config) return { ...defaultOptions };
    const read = ts.readConfigFile(config, ts.sys.readFile);
    if (read.error) {
      this.notes.push({ level: "warning", message: "tsconfig could not be read; default compiler options are used.", file: this.relative(config), code: "config-error" });
      return { ...defaultOptions };
    }
    const parsed = ts.parseJsonConfigFileContent(read.config, ts.sys, path.dirname(config), undefined, config);
    return { ...defaultOptions, ...parsed.options };
  }

  /** Module id: the path without extension; files that would share one keep their extension. */
  private moduleIds(paths: string[]): Map<string, string> {
    const strip = (p: string) => p.replace(/\.[^./]+$/, "");
    const count = new Map<string, number>();
    for (const p of paths) count.set(strip(p), (count.get(strip(p)) ?? 0) + 1);
    return new Map(paths.map((p) => [p, count.get(strip(p))! > 1 ? p : strip(p)]));
  }

  private addFile(sf: ts.SourceFile, program: ts.Program, options: ts.CompilerOptions, id: string): void {
    const rel = this.relative(sf.fileName);
    const text = sf.text;
    let lines = text.split("\n").length - 1;
    if (text.length > 0 && !text.endsWith("\n")) lines++;
    const { tokens, comments, loc } = scan(sf);
    const directives = new Directives();
    for (const c of comments) directives.add(c.text, c.line, c.endLine);
    const info: SourceInfo = {
      path: rel, lines, loc, tokens, directives, importLines: new Set(), comments, sf, checker: program.getTypeChecker(), program, options,
      module: undefined as unknown as Module, broken: program.getSyntacticDiagnostics(sf).length > 0,
    };
    for (const statement of sf.statements) {
      if (ts.isImportDeclaration(statement) || ts.isImportEqualsDeclaration(statement) || (ts.isExportDeclaration(statement) && statement.moduleSpecifier)) {
        const start = sf.getLineAndCharacterOfPosition(statement.getStart(sf)).line + 1;
        const end = sf.getLineAndCharacterOfPosition(statement.getEnd()).line + 1;
        for (let line = start; line <= end; line++) info.importLines.add(line);
      }
    }
    const name = path.basename(rel).replace(/\.[^.]+$/, "");
    const m: Module = { id, name, file: info, types: [], functions: [], globals: [], imports: [] };
    info.module = m;
    this.files.push(info);
    this.modules.push(m);
    this.byFile.set(path.resolve(sf.fileName), m);
  }

  private visibilityOfTop(node: ts.Node): string {
    return hasModifier(node, ts.SyntaxKind.ExportKeyword) ? "public" : "internal";
  }

  private addType(m: Module, node: TypeUnit["node"], kind: string, name: string, isAbstract: boolean): TypeUnit | undefined {
    const existing = m.types.find((t) => t.name === name && t.kind === kind && kind === "interface");
    if (existing) {
      existing.parts.push(node);
      this.index.set(this.key(node), { type: existing });
      return existing;
    }
    const t: TypeUnit = {
      id: this.uniqueId(`${m.id}.${name}`), name, module: m, kind, node, parts: [node], place: this.nodePlace(node), isAbstract,
      members: [], methods: [], typeParameters: (node as ts.ClassDeclaration).typeParameters?.map((p) => p.name.text) ?? [],
    };
    m.types.push(t);
    this.types.set(t.id, t);
    this.index.set(this.key(node), { type: t });
    return t;
  }

  private addFunction(fn: Omit<Fn, "id"> & { id?: string }, baseId: string): Fn {
    const entry: Fn = { ...fn, id: this.uniqueId(baseId) };
    this.functions.set(entry.id, entry);
    this.index.set(this.key(entry.node), { fn: entry });
    if (entry.owner) entry.owner.methods.push(entry);
    else entry.module.functions.push(entry);
    return entry;
  }

  /** Builds types, functions and globals from the top-level statements of a module. */
  private declareModule(m: Module): void {
    const sf = m.file.sf;
    for (const statement of moduleStatements(sf)) {
      if (hasModifier(statement, ts.SyntaxKind.DeclareKeyword)) continue;
      const defaultName = hasModifier(statement, ts.SyntaxKind.DefaultKeyword) ? "default" : "";
      if (ts.isClassDeclaration(statement)) {
        const t = this.addType(m, statement, "class", statement.name?.text ?? defaultName, hasModifier(statement, ts.SyntaxKind.AbstractKeyword));
        if (t) this.declareClass(t, statement);
      } else if (ts.isInterfaceDeclaration(statement)) {
        const t = this.addType(m, statement, "interface", statement.name.text, true);
        if (t) this.declareSignatures(t, statement.members);
      } else if (ts.isEnumDeclaration(statement)) {
        const t = this.addType(m, statement, "enum", statement.name.text, false);
        if (t) {
          for (const member of statement.members) {
            this.addMember({ name: member.name.getText(sf), kind: "literal", node: member, owner: t, visibility: "public", isStatic: false, isReadonly: true, mutable: false });
          }
        }
      } else if (ts.isTypeAliasDeclaration(statement)) {
        // An alias of an object shape is an abstraction like an interface (D-055).
        const shape = ts.isTypeLiteralNode(statement.type);
        const t = this.addType(m, statement, "type", statement.name.text, shape);
        if (t && shape) this.declareSignatures(t, (statement.type as ts.TypeLiteralNode).members);
      } else if (ts.isFunctionDeclaration(statement)) {
        if (!statement.body) continue; // an overload signature
        const name = statement.name?.text ?? defaultName;
        this.addFunction({
          name, module: m, place: this.nodePlace(statement), node: statement, fn: statement, body: statement.body, kind: "function",
          visibility: this.visibilityOfTop(statement), isStatic: false, isAbstract: false, file: m.file,
        }, `${m.id}.${name}`);
      } else if (ts.isVariableStatement(statement)) {
        const single = statement.declarationList.declarations.length === 1;
        const mutable = !(statement.declarationList.flags & (ts.NodeFlags.Const | ts.NodeFlags.Using | ts.NodeFlags.AwaitUsing));
        for (const declaration of statement.declarationList.declarations) {
          if (!ts.isIdentifier(declaration.name)) continue;
          const name = declaration.name.text;
          const value = declaration.initializer && unwrap(declaration.initializer);
          if (isFunctionValue(value)) {
            this.addFunction({
              name, module: m, place: this.nodePlace(single ? statement : declaration), node: declaration, fn: value, body: value.body, kind: "function",
              visibility: this.visibilityOfTop(statement), isStatic: false, isAbstract: false, file: m.file,
            }, `${m.id}.${name}`);
          } else if (mutable) {
            const g: Global = { id: `${m.id}.${name}`, name, place: this.nodePlace(declaration.name), node: declaration };
            m.globals.push(g);
            this.index.set(this.key(declaration), { global: g });
          }
        }
      } else if (ts.isExportAssignment(statement) && isFunctionValue(unwrap(statement.expression))) {
        const value = unwrap(statement.expression) as ts.ArrowFunction;
        this.addFunction({
          name: "default", module: m, place: this.nodePlace(statement), node: statement, fn: value, body: value.body, kind: "function",
          visibility: "public", isStatic: false, isAbstract: false, file: m.file,
        }, `${m.id}.default`);
      }
    }
  }

  private addMember(member: Member): void {
    member.owner.members.push(member);
    this.index.set(this.key(member.node), { member });
  }

  private memberVisibility(node: ts.Node, name: ts.Node | undefined): string {
    if (name && ts.isPrivateIdentifier(name)) return "private";
    if (hasModifier(node, ts.SyntaxKind.PrivateKeyword)) return "private";
    if (hasModifier(node, ts.SyntaxKind.ProtectedKeyword)) return "protected";
    return "public";
  }

  private declareClass(t: TypeUnit, node: ts.ClassDeclaration): void {
    const sf = node.getSourceFile();
    const accessors = new Map<string, Member>();
    const m = t.module;
    for (const member of node.members) {
      const name = member.name ? member.name.getText(sf) : "";
      const isStatic = hasModifier(member, ts.SyntaxKind.StaticKeyword);
      const visibility = this.memberVisibility(member, member.name);
      const base = { module: m, owner: t, file: m.file, visibility, isStatic };
      if (ts.isPropertyDeclaration(member)) {
        const value = member.initializer && unwrap(member.initializer);
        if (isFunctionValue(value)) {
          this.addFunction({ ...base, name, place: this.nodePlace(member), node: member, fn: value, body: value.body, kind: "method", isAbstract: false }, `${t.id}.${name}`);
        } else {
          const readonly = hasModifier(member, ts.SyntaxKind.ReadonlyKeyword);
          this.addMember({ name, kind: "field", node: member, owner: t, visibility, isStatic, isReadonly: readonly, typeNode: member.type, mutable: !readonly });
        }
      } else if (ts.isMethodDeclaration(member)) {
        const abstract = hasModifier(member, ts.SyntaxKind.AbstractKeyword);
        if (!member.body && !abstract) continue; // an overload signature
        this.addFunction({ ...base, name, place: this.nodePlace(member), node: member, fn: member, body: member.body, kind: "method", isAbstract: abstract }, `${t.id}.${name}`);
      } else if (ts.isConstructorDeclaration(member)) {
        for (const parameter of member.parameters) {
          if (!ts.isParameterPropertyDeclaration(parameter, member) || !ts.isIdentifier(parameter.name)) continue;
          const readonly = hasModifier(parameter, ts.SyntaxKind.ReadonlyKeyword);
          this.addMember({
            name: parameter.name.text, kind: "field", node: parameter, owner: t, visibility: this.memberVisibility(parameter, undefined), isStatic: false,
            isReadonly: readonly, typeNode: parameter.type, mutable: !readonly,
          });
        }
        if (!member.body) continue;
        this.addFunction({ ...base, name: "constructor", place: this.nodePlace(member), node: member, fn: member, body: member.body, kind: "constructor", isAbstract: false, isStatic: false }, `${t.id}.constructor`);
      } else if (ts.isGetAccessorDeclaration(member) || ts.isSetAccessorDeclaration(member)) {
        const getter = ts.isGetAccessorDeclaration(member);
        const abstract = hasModifier(member, ts.SyntaxKind.AbstractKeyword);
        this.addFunction({ ...base, name, place: this.nodePlace(member), node: member, fn: member, body: member.body, kind: "accessor", isAbstract: abstract }, `${t.id}.${name}.${getter ? "get" : "set"}`);
        const known = accessors.get(`${isStatic}:${name}`);
        if (known) {
          known.mutable ||= !getter;
          this.index.set(this.key(member), { member: known });
          if (!known.typeNode && getter) known.typeNode = member.type;
        } else {
          const property: Member = {
            name, kind: "property", node: member, owner: t, visibility, isStatic, isReadonly: getter, mutable: !getter,
            typeNode: getter ? member.type : member.parameters[0]?.type,
          };
          accessors.set(`${isStatic}:${name}`, property);
          this.addMember(property);
        }
      }
    }
  }

  /** Members of an interface or of an object type alias: property and method signatures. */
  private declareSignatures(t: TypeUnit, members: ts.NodeArray<ts.TypeElement>): void {
    const m = t.module;
    const sf = m.file.sf;
    for (const member of members) {
      const name = member.name ? member.name.getText(sf) : "";
      if (ts.isPropertySignature(member)) {
        const readonly = hasModifier(member, ts.SyntaxKind.ReadonlyKeyword);
        this.addMember({ name, kind: "field", node: member, owner: t, visibility: "public", isStatic: false, isReadonly: readonly, typeNode: member.type, mutable: !readonly });
      } else if (ts.isMethodSignature(member)) {
        if (t.methods.some((f) => f.name === name)) {
          this.index.set(this.key(member), { fn: t.methods.find((f) => f.name === name)! });
          continue; // an overload of the same method
        }
        this.addFunction({
          name, module: m, owner: t, place: this.nodePlace(member), node: member, fn: member, kind: "method", visibility: "public",
          isStatic: false, isAbstract: true, file: m.file,
        }, `${t.id}.${name}`);
      }
    }
  }
}

/**
 * Top-level statements of a file, with the body of an immediately invoked function at the top level read as top level
 * too: `(function () { … })()` only scopes the declarations of a browser script (D-055).
 */
function moduleStatements(sf: ts.SourceFile): ts.Statement[] {
  const result: ts.Statement[] = [];
  const add = (statements: readonly ts.Statement[]) => {
    for (const statement of statements) {
      const body = ts.isExpressionStatement(statement) ? invokedBody(statement.expression) : undefined;
      if (body) add(body.statements);
      else result.push(statement);
    }
  };
  add(sf.statements);
  return result;
}

/** The block of `(function () {…})()`, `(() => {…})()`, `!function () {…}()` and `void …`. */
function invokedBody(expression: ts.Expression): ts.Block | undefined {
  let node = unwrap(expression);
  if ((ts.isPrefixUnaryExpression(node) && node.operator === ts.SyntaxKind.ExclamationToken) || ts.isVoidExpression(node)) node = unwrap((node as ts.PrefixUnaryExpression).operand ?? (node as ts.VoidExpression).expression);
  if (!ts.isCallExpression(node)) return undefined;
  const callee = unwrap(node.expression);
  return isFunctionValue(callee) && ts.isBlock(callee.body) ? callee.body : undefined;
}

/** First token of a declaration, after its decorators and documentation comments. */
export function startOf(node: ts.Node, sf: ts.SourceFile): number {
  for (const child of node.getChildren(sf)) {
    if (child.kind >= ts.SyntaxKind.FirstJSDocNode && child.kind <= ts.SyntaxKind.LastJSDocNode) continue;
    if (child.kind === ts.SyntaxKind.SyntaxList) {
      const first = child.getChildren(sf).find((c) => c.kind !== ts.SyntaxKind.Decorator);
      if (first) return first.getStart(sf);
      continue;
    }
    if (child.kind === ts.SyntaxKind.Decorator) continue;
    return child.getStart(sf);
  }
  return node.getStart(sf);
}

/** Tokens, comments and lines of code of a file, from its syntax tree so that templates and regular expressions read right. */
function scan(sf: ts.SourceFile): { tokens: Token[]; comments: { text: string; line: number; endLine: number }[]; loc: number } {
  const tokens: Token[] = [];
  const comments = new Map<number, { text: string; line: number; endLine: number }>();
  const lines = new Set<number>();
  const text = sf.text;
  const lineOf = (pos: number) => sf.getLineAndCharacterOfPosition(pos).line + 1;
  const addComments = (ranges: ts.CommentRange[] | undefined) => {
    for (const range of ranges ?? []) {
      if (!comments.has(range.pos)) comments.set(range.pos, { text: text.slice(range.pos, range.end), line: lineOf(range.pos), endLine: lineOf(range.end) });
    }
  };
  const visit = (node: ts.Node) => {
    if (node.kind >= ts.SyntaxKind.FirstJSDocNode && node.kind <= ts.SyntaxKind.LastJSDocNode) return;
    if (node.kind >= ts.SyntaxKind.FirstNode) {
      for (const child of node.getChildren(sf)) visit(child);
      return;
    }
    addComments(ts.getLeadingCommentRanges(text, node.pos));
    addComments(ts.getTrailingCommentRanges(text, node.end));
    if (node.kind === ts.SyntaxKind.EndOfFileToken) return;
    const start = node.getStart(sf);
    if (start >= node.end) return; // an empty JSX text or a missing token
    if (node.kind === ts.SyntaxKind.JsxText && text.slice(start, node.end).trim() === "") return;
    const first = lineOf(start);
    for (let line = first, last = lineOf(node.end); line <= last; line++) lines.add(line);
    tokens.push({ line: first, kind: node.kind, text: text.slice(start, node.end) });
  };
  visit(sf);
  return { tokens, comments: [...comments.values()].sort((a, b) => a.line - b.line), loc: lines.size };
}
