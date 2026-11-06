"""Everything loaded from a root: files, modules, types, functions, and name resolution without a type checker (D-057)."""
from __future__ import annotations

import ast
import io
import keyword
import os
import re
import sys
import tokenize
from dataclasses import dataclass, field

from .suppress import Directives

SKIPPED_FOLDERS = {"__pycache__", "node_modules", "site-packages", "build", "dist"}
STDLIB = set(sys.stdlib_module_names) | {"__future__"}
BUILTINS = set(dir(__import__("builtins")))
TRY_STAR = getattr(ast, "TryStar", None)
TRY_NODES = (ast.Try,) + ((TRY_STAR,) if TRY_STAR else ())
FUNCTION_NODES = (ast.FunctionDef, ast.AsyncFunctionDef)
COMPREHENSIONS = (ast.ListComp, ast.SetComp, ast.DictComp, ast.GeneratorExp)
CONSTANT_NAME = re.compile(r"^_*[A-Z][A-Z0-9_]*$")


def is_dunder(name: str) -> bool:
    return name.startswith("__") and name.endswith("__") and len(name) > 4


def is_private(name: str) -> bool:
    return name.startswith("_") and not is_dunder(name)


@dataclass
class Place:
    file: str
    startLine: int
    startColumn: int
    endLine: int
    endColumn: int

    def as_dict(self) -> dict:
        return {"file": self.file, "startLine": self.startLine, "startColumn": self.startColumn, "endLine": self.endLine, "endColumn": self.endColumn}


@dataclass
class Token:
    line: int
    end_line: int
    kind: str  # name, keyword, number, string, op
    text: str


@dataclass(eq=False)
class SourceFile:
    path: str
    text: str
    lines: int
    loc: int
    tokens: list
    directives: Directives
    import_lines: set
    tree: ast.Module | None
    broken: bool
    line_texts: list
    comment_lines: set = field(default_factory=set)
    module: "Module" = None


@dataclass(eq=False)
class Global:
    id: str
    name: str
    place: Place
    node: ast.AST


@dataclass(eq=False)
class Member:
    """State of a type: a field, a property (accessor pair) or an enum value."""

    name: str
    kind: str  # field, property, literal
    node: ast.AST
    owner: "TypeUnit"
    visibility: str
    is_static: bool
    mutable: bool
    annotation: ast.AST | None = None
    # The expression assigned to the member, when its type has to come from the value.
    value: ast.AST | None = None
    value_fn: "Fn" = None
    order: tuple = (0, 0)


@dataclass(eq=False)
class TypeUnit:
    id: str
    name: str
    module: "Module"
    node: ast.ClassDef
    place: Place
    outer: "TypeUnit" = None
    kind: str = "class"
    is_abstract: bool = False
    members: list = field(default_factory=list)
    methods: list = field(default_factory=list)
    nested: list = field(default_factory=list)
    type_parameters: list = field(default_factory=list)
    # Resolved bases: project types and external ids.
    project_bases: list = field(default_factory=list)
    external_bases: list = field(default_factory=list)
    frozen: bool = False
    record: bool = False  # dataclass, NamedTuple, TypedDict: data meant to be read
    type_only: bool = False


@dataclass(eq=False)
class Fn:
    id: str
    name: str
    module: "Module"
    place: Place
    node: ast.AST  # FunctionDef, AsyncFunctionDef or Lambda
    kind: str  # function, method, constructor, accessor
    visibility: str
    owner: TypeUnit = None
    is_static: bool = False
    is_classmethod: bool = False
    is_abstract: bool = False
    has_body: bool = True
    decorators: list = field(default_factory=list)
    type_only: bool = False

    @property
    def file(self) -> SourceFile:
        return self.module.file

    @property
    def args(self) -> ast.arguments:
        return self.node.args

    def body_nodes(self) -> list:
        if not self.has_body:
            return []
        if isinstance(self.node, ast.Lambda):
            return [self.node.body]
        return list(self.node.body)

    def implicit_first(self) -> bool:
        """Whether the first parameter is self or cls, which is not a declared parameter."""
        return self.owner is not None and not self.is_static and not isinstance(self.node, ast.Lambda)


@dataclass
class Binding:
    """A module-level name: what it stands for and whether it exists at run time."""

    kind: str  # module, from, type, fn, global, variable
    target: object = None
    name: str = ""
    type_only: bool = False
    node: ast.AST = None


@dataclass(eq=False)
class ImportRef:
    """One import statement target: a dotted module name, as written and resolved."""

    name: str
    node: ast.AST
    type_only: bool
    imported: list = field(default_factory=list)  # names of `from x import a, b`


@dataclass(eq=False)
class Module:
    id: str
    name: str
    file: SourceFile
    is_package: bool
    types: list = field(default_factory=list)
    functions: list = field(default_factory=list)
    globals: list = field(default_factory=list)
    bindings: dict = field(default_factory=dict)
    imports: list = field(default_factory=list)
    dynamic_imports: list = field(default_factory=list)

    @property
    def package(self) -> str:
        """The package a relative import starts from."""
        if self.is_package:
            return self.id
        return self.id.rsplit(".", 1)[0] if "." in self.id else ""


# References: what a name or an attribute means.
@dataclass(frozen=True, eq=False)
class ModRef:
    name: str
    module: Module | None


@dataclass(frozen=True, eq=False)
class ExtRef:
    id: str
    stdlib: bool


@dataclass(frozen=True, eq=False)
class TypeRef:
    type: TypeUnit


@dataclass(frozen=True, eq=False)
class FnRef:
    fn: Fn
    through_type: bool = False


@dataclass(frozen=True, eq=False)
class MemberRef:
    member: Member
    through_type: bool = False


@dataclass(frozen=True, eq=False)
class GlobalRef:
    glob: Global


@dataclass(frozen=True, eq=False)
class Value:
    """A value whose type is known: an instance of a project type, or a builtin kind (list, str, dict...)."""

    type: TypeUnit | None = None
    builtin: str | None = None
    element: "Value" = None


def _glob_regex(pattern: str):
    expression = re.escape(pattern).replace(r"\*\*/", "\0").replace(r"\*\*", "\1").replace(r"\*", "[^/]*")
    expression = expression.replace("\0", "(.*/)?").replace("\1", ".*")
    return re.compile(f"^{expression}$")


def any_glob(patterns: list, value: str) -> bool:
    return any(_glob_regex(p).match(value) for p in patterns)


def read_source(path: str) -> str:
    with open(path, "rb") as f:
        data = f.read()
    try:
        encoding, _ = tokenize.detect_encoding(io.BytesIO(data).readline)
    except SyntaxError:
        encoding = "utf-8"
    try:
        text = data.decode(encoding)
    except (LookupError, UnicodeDecodeError):
        text = data.decode("utf-8", errors="replace")
    if text.startswith("﻿"):
        text = text[1:]
    return text.replace("\r\n", "\n").replace("\r", "\n")


_SKIPPED_TOKENS = {tokenize.NEWLINE, tokenize.NL, tokenize.INDENT, tokenize.DEDENT, tokenize.ENDMARKER, tokenize.ENCODING, tokenize.COMMENT}
_FSTRING_START = getattr(tokenize, "FSTRING_START", None)
_FSTRING_END = getattr(tokenize, "FSTRING_END", None)
_TSTRING_START = getattr(tokenize, "TSTRING_START", None)
_TSTRING_END = getattr(tokenize, "TSTRING_END", None)
_STARTS = {t for t in (_FSTRING_START, _TSTRING_START) if t is not None}
_ENDS = {t for t in (_FSTRING_END, _TSTRING_END) if t is not None}


def scan(text: str):
    """Tokens, comments and lines of code. An f-string is one string token, as before Python 3.12 (D-057)."""
    tokens: list = []
    comments: list = []
    code_lines: set = set()
    lines = text.split("\n")
    depth = 0
    start = None
    broken = False
    try:
        for tok in tokenize.generate_tokens(io.StringIO(text).readline):
            if tok.type in _STARTS:
                if depth == 0:
                    start = tok
                depth += 1
                continue
            if depth > 0:
                if tok.type in _ENDS:
                    depth -= 1
                    if depth == 0:
                        tokens.append(Token(start.start[0], tok.end[0], "string", _span(lines, start.start, tok.end)))
                        code_lines.update(range(start.start[0], tok.end[0] + 1))
                continue
            if tok.type == tokenize.COMMENT:
                comments.append((tok.string, tok.start[0], tok.end[0]))
                continue
            if tok.type in _SKIPPED_TOKENS or tok.type == tokenize.ERRORTOKEN and not tok.string.strip():
                continue
            if tok.type == tokenize.NAME:
                kind = "keyword" if keyword.iskeyword(tok.string) else "name"
            elif tok.type == tokenize.NUMBER:
                kind = "number"
            elif tok.type == tokenize.STRING:
                kind = "string"
            else:
                kind = "op"
            tokens.append(Token(tok.start[0], tok.end[0], kind, tok.string))
            code_lines.update(range(tok.start[0], tok.end[0] + 1))
    except (tokenize.TokenError, SyntaxError, IndentationError):
        broken = True
    return tokens, comments, len(code_lines), broken


def _span(lines: list, start: tuple, end: tuple) -> str:
    (l1, c1), (l2, c2) = start, end
    if l1 == l2:
        return lines[l1 - 1][c1:c2]
    parts = [lines[l1 - 1][c1:]] + lines[l1:l2 - 1] + [lines[l2 - 1][:c2]]
    return "\n".join(parts)


def is_type_checking(test: ast.AST) -> bool:
    return (isinstance(test, ast.Name) and test.id == "TYPE_CHECKING") or (isinstance(test, ast.Attribute) and test.attr == "TYPE_CHECKING")


def module_statements(body: list, type_only: bool = False):
    """Top-level statements with those in top-level if, try and with blocks; the flag marks `if TYPE_CHECKING:`."""
    for statement in body:
        if isinstance(statement, ast.If):
            inner = type_only or is_type_checking(statement.test)
            yield from module_statements(statement.body, inner)
            yield from module_statements(statement.orelse, type_only)
        elif isinstance(statement, TRY_NODES):
            yield from module_statements(statement.body, type_only)
            for handler in statement.handlers:
                yield from module_statements(handler.body, type_only)
            yield from module_statements(statement.orelse, type_only)
            yield from module_statements(statement.finalbody, type_only)
        elif isinstance(statement, (ast.With, ast.AsyncWith)):
            yield from module_statements(statement.body, type_only)
        else:
            yield statement, type_only


def decorator_name(node: ast.AST) -> str:
    """`property`, `x.setter`, `functools.cache`: the dotted text of a decorator without its call."""
    if isinstance(node, ast.Call):
        node = node.func
    parts = []
    while isinstance(node, ast.Attribute):
        parts.append(node.attr)
        node = node.value
    if isinstance(node, ast.Name):
        parts.append(node.id)
    return ".".join(reversed(parts))


def dotted(node: ast.AST):
    """The dotted text of a Name or Attribute chain, or None."""
    parts = []
    while isinstance(node, ast.Attribute):
        parts.append(node.attr)
        node = node.value
    if not isinstance(node, ast.Name):
        return None
    parts.append(node.id)
    return ".".join(reversed(parts))


def is_stub_body(body: list) -> bool:
    """A body of only `...`, `pass` and a docstring: a protocol method without an implementation."""
    for statement in body:
        if isinstance(statement, ast.Pass):
            continue
        if isinstance(statement, ast.Expr) and isinstance(statement.value, ast.Constant) and (statement.value.value is Ellipsis or isinstance(statement.value.value, str)):
            continue
        return False
    return True


ENUM_BASES = {"Enum", "IntEnum", "StrEnum", "Flag", "IntFlag", "ReprEnum"}
NOT_BASE_CLASSES = {"object", "Generic", "Protocol", "ABC", "NamedTuple", "TypedDict"}


class Project:
    """Everything loaded from a root."""

    def __init__(self, root: str) -> None:
        self.root = os.path.abspath(root)
        self.files: list = []
        self.modules: list = []
        self.by_id: dict = {}
        self.types: dict = {}
        self.functions: dict = {}
        self.notes: list = []
        self._ids: set = set()
        self.type_of_node: dict = {}
        self.fn_of_node: dict = {}
        self.member_of_node: dict = {}
        self._resolver = None

    # Loading -------------------------------------------------------------------------------------------------------
    def relative(self, full: str) -> str:
        return os.path.relpath(full, self.root).replace(os.sep, "/")

    def load(self, include: list, exclude: list) -> None:
        found = []

        def walk(folder: str) -> None:
            try:
                entries = sorted(os.listdir(folder))
            except OSError:
                return
            for name in entries:
                full = os.path.join(folder, name)
                if os.path.isdir(full):
                    if name in SKIPPED_FOLDERS or name.startswith(".") or os.path.exists(os.path.join(full, "pyvenv.cfg")):
                        continue
                    walk(full)
                elif name.endswith(".py") and os.path.isfile(full):
                    rel = self.relative(full)
                    if (not include or any_glob(include, rel)) and not any_glob(exclude, rel):
                        found.append(full)

        walk(self.root)
        found.sort(key=self.relative)
        ids = self._module_ids([self.relative(f) for f in found])
        for full in found:
            self._add_file(full, ids[self.relative(full)])
        for m in self.modules:
            self._declare_module(m)
        from .resolve import Resolver

        self._resolver = Resolver(self)
        self._resolver.link()

    @property
    def resolver(self):
        return self._resolver

    def _module_ids(self, paths: list) -> dict:
        def base(p: str) -> str:
            stem = p[:-3]
            if stem == "__init__":
                return "__init__"
            if stem.endswith("/__init__"):
                stem = stem[: -len("/__init__")]
            return stem.replace("/", ".")

        result = {}
        seen = set()
        for p in paths:
            candidate = base(p)
            if candidate in seen:
                candidate = p[:-3].replace("/", ".")
            seen.add(candidate)
            result[p] = candidate
        return result

    def _add_file(self, full: str, module_id: str) -> None:
        rel = self.relative(full)
        text = read_source(full)
        lines = text.count("\n") + (1 if text and not text.endswith("\n") else 0)
        tokens, comments, loc, token_broken = scan(text)
        directives = Directives()
        for comment, start, end in comments:
            directives.add(comment, start, end)
        tree = None
        broken = token_broken
        try:
            tree = ast.parse(text, filename=rel)
        except (SyntaxError, ValueError):
            broken = True
            tree = None
        import_lines = set()
        if tree is not None:
            for node in ast.walk(tree):
                if isinstance(node, (ast.Import, ast.ImportFrom)):
                    import_lines.update(range(node.lineno, node.end_lineno + 1))
        info = SourceFile(rel, text, lines, loc, tokens, directives, import_lines, tree, broken, text.split("\n"))
        name = module_id.rsplit(".", 1)[-1]
        m = Module(module_id, name, info, os.path.basename(full) == "__init__.py")
        info.module = m
        self.files.append(info)
        self.modules.append(m)
        self.by_id[module_id] = m

    def unique_id(self, base: str) -> str:
        candidate = base
        n = 2
        while candidate in self._ids:
            candidate = f"{base}#{n}"
            n += 1
        self._ids.add(candidate)
        return candidate

    # Places --------------------------------------------------------------------------------------------------------
    def column(self, info: SourceFile, line: int, offset: int) -> int:
        """ast columns are UTF-8 byte offsets; facts count characters, like the other analyzers."""
        text = info.line_texts[line - 1] if 0 < line <= len(info.line_texts) else ""
        return len(text.encode("utf-8")[:offset].decode("utf-8", errors="ignore")) + 1

    def place(self, info: SourceFile, node: ast.AST) -> Place:
        end_line = getattr(node, "end_lineno", None) or node.lineno
        end_col = getattr(node, "end_col_offset", None)
        if end_col is None:
            end_col = node.col_offset
        return Place(info.path, node.lineno, self.column(info, node.lineno, node.col_offset), end_line, self.column(info, end_line, end_col))

    # Declarations --------------------------------------------------------------------------------------------------
    def _declare_module(self, m: Module) -> None:
        tree = m.file.tree
        if tree is None:
            return
        for statement, type_only in module_statements(tree.body):
            if isinstance(statement, ast.ClassDef):
                t = self._declare_class(m, statement, None)
                t.type_only = type_only
                m.bindings[statement.name] = Binding("type", t, statement.name, type_only, statement)
            elif isinstance(statement, FUNCTION_NODES):
                f = self._declare_function(m, statement, None)
                f.type_only = type_only
                m.bindings[statement.name] = Binding("fn", f, statement.name, type_only, statement)
            elif isinstance(statement, ast.Assign) and len(statement.targets) == 1 and isinstance(statement.targets[0], ast.Name) and isinstance(statement.value, ast.Lambda):
                name = statement.targets[0].id
                f = Fn(self.unique_id(f"{m.id}.{name}"), name, m, self.place(m.file, statement), statement.value, "function", "internal" if is_private(name) else "public")
                self._add_function(f)
                m.bindings[name] = Binding("fn", f, name, type_only, statement)
            elif isinstance(statement, (ast.Assign, ast.AnnAssign, ast.AugAssign)):
                targets = statement.targets if isinstance(statement, ast.Assign) else [statement.target]
                for target in targets:
                    for name_node in _names(target):
                        if name_node.id not in m.bindings or m.bindings[name_node.id].kind == "variable":
                            known = m.bindings.get(name_node.id)
                            binding = known or Binding("variable", None, name_node.id, type_only, name_node)
                            binding.target = (binding.target or []) + [statement]
                            m.bindings[name_node.id] = binding
            elif isinstance(statement, ast.Import):
                for alias in statement.names:
                    m.imports.append(ImportRef(alias.name, statement, type_only))
                    if alias.asname:
                        m.bindings[alias.asname] = Binding("module", alias.name, alias.asname, type_only, statement)
                    else:
                        top = alias.name.split(".")[0]
                        m.bindings[top] = Binding("module", top, top, type_only, statement)
            elif isinstance(statement, ast.ImportFrom):
                base = self.absolute(m, statement.module or "", statement.level)
                names = [a.name for a in statement.names]
                m.imports.append(ImportRef(base, statement, type_only, names))
                for alias in statement.names:
                    if alias.name == "*":
                        continue
                    local = alias.asname or alias.name
                    m.bindings[local] = Binding("from", (base, alias.name, statement.level > 0), local, type_only, statement)
        # Imports below the top level still run when their function does.
        for node in ast.walk(tree):
            if isinstance(node, (ast.Import, ast.ImportFrom)) and not any(node is i.node for i in m.imports):
                if isinstance(node, ast.Import):
                    for alias in node.names:
                        m.imports.append(ImportRef(alias.name, node, False))
                else:
                    m.imports.append(ImportRef(self.absolute(m, node.module or "", node.level), node, False, [a.name for a in node.names]))
            elif isinstance(node, ast.Call) and dotted(node.func) in ("importlib.import_module", "import_module", "__import__") and node.args \
                    and isinstance(node.args[0], ast.Constant) and isinstance(node.args[0].value, str) and len(node.args) == 1:
                m.dynamic_imports.append(ImportRef(node.args[0].value, node, False))

    def absolute(self, m: Module, name: str, level: int) -> str:
        if level == 0:
            return name
        parts = m.package.split(".") if m.package else []
        if level > 1:
            parts = parts[: len(parts) - (level - 1)] if level - 1 <= len(parts) else []
        prefix = ".".join(parts)
        if not name:
            return prefix
        return f"{prefix}.{name}" if prefix else name

    def _declare_class(self, m: Module, node: ast.ClassDef, outer: TypeUnit | None) -> TypeUnit:
        base = f"{outer.id}.{node.name}" if outer else f"{m.id}.{node.name}"
        t = TypeUnit(self.unique_id(base), node.name, m, node, self.place(m.file, node), outer)
        self.types[t.id] = t
        self.type_of_node[node] = t
        m.types.append(t)
        if outer:
            outer.nested.append(t)
        params = getattr(node, "type_params", None) or []
        t.type_parameters = [p.name for p in params if hasattr(p, "name")]
        for statement in node.body:
            if isinstance(statement, ast.ClassDef):
                self._declare_class(m, statement, t)
            elif isinstance(statement, FUNCTION_NODES):
                self._declare_function(m, statement, t)
        return t

    def _declare_function(self, m: Module, node: ast.AST, owner: TypeUnit | None) -> Fn | None:
        names = [decorator_name(d) for d in node.decorator_list]
        short = [n.rsplit(".", 1)[-1] for n in names]
        if "overload" in short:
            return None  # a signature for the type checker; the implementation follows
        place = self.place(m.file, node)
        if owner is None:
            f = Fn(self.unique_id(f"{m.id}.{node.name}"), node.name, m, place, node, "function", "internal" if is_private(node.name) else "public", decorators=names)
            self._add_function(f)
            return f
        kind = "method"
        suffix = ""
        if node.name == "__init__":
            kind = "constructor"
        elif "property" in short or "cached_property" in short:
            kind, suffix = "accessor", ".get"
        elif any(n.endswith(".setter") for n in names):
            kind, suffix = "accessor", ".set"
        elif any(n.endswith(".deleter") for n in names):
            kind, suffix = "accessor", ".delete"
        visibility = "private" if is_private(node.name) else "public"
        f = Fn(self.unique_id(f"{owner.id}.{node.name}{suffix}"), node.name, m, place, node, kind, visibility, owner, decorators=names)
        f.is_static = "staticmethod" in short or "classmethod" in short
        f.is_classmethod = "classmethod" in short
        f.is_abstract = "abstractmethod" in short
        self._add_function(f)
        return f

    def _add_function(self, f: Fn) -> None:
        self.functions[f.id] = f
        self.fn_of_node[f.node] = f
        if f.owner:
            f.owner.methods.append(f)
        else:
            f.module.functions.append(f)

    def all_types(self) -> list:
        return [self.types[k] for k in sorted(self.types)]

    def all_functions(self) -> list:
        return [self.functions[k] for k in sorted(self.functions)]


def _names(target: ast.AST):
    if isinstance(target, ast.Name):
        yield target
    elif isinstance(target, (ast.Tuple, ast.List)):
        for e in target.elts:
            yield from _names(e)
    elif isinstance(target, ast.Starred):
        yield from _names(target.value)


def names_of(target: ast.AST) -> list:
    return list(_names(target))
