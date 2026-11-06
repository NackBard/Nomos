"""Names, imports and the types Python code states: annotations and explicit creation, no inference beyond (D-057)."""
from __future__ import annotations

import ast

from .project import (
    BUILTINS, COMPREHENSIONS, CONSTANT_NAME, ENUM_BASES, FUNCTION_NODES, STDLIB, Binding, ExtRef, Fn, FnRef, Global, GlobalRef, Member,
    MemberRef, ModRef, Module, Project, TypeRef, TypeUnit, Value, decorator_name, dotted, is_dunder, is_private, is_stub_body, names_of,
)

# Annotations of collections: the element is the last type argument (spec/structure.md).
COLLECTIONS = {
    "list", "List", "set", "Set", "frozenset", "FrozenSet", "dict", "Dict", "deque", "Deque", "defaultdict", "DefaultDict", "OrderedDict",
    "Counter", "ChainMap", "Sequence", "MutableSequence", "Iterable", "Iterator", "Collection", "Mapping", "MutableMapping", "AbstractSet",
    "MutableSet", "Generator", "AsyncIterable", "AsyncIterator", "Reversible", "KeysView", "ValuesView", "ItemsView",
}
WRAPPERS = {"Optional", "Annotated", "ClassVar", "Final", "Required", "NotRequired", "ReadOnly", "Type", "type"}
BUILTIN_KINDS = {"list": "list", "List": "list", "Sequence": "list", "MutableSequence": "list", "tuple": "tuple", "Tuple": "tuple",
                 "str": "str", "dict": "dict", "Dict": "dict", "Mapping": "dict", "MutableMapping": "dict", "set": "set", "Set": "set",
                 "frozenset": "set", "FrozenSet": "set", "deque": "deque", "Deque": "deque", "defaultdict": "dict", "OrderedDict": "dict"}


def strip_quotes(node: ast.AST):
    """A string annotation as the expression it holds."""
    if isinstance(node, ast.Constant) and isinstance(node.value, str):
        try:
            return ast.parse(node.value.strip(), mode="eval").body
        except SyntaxError:
            return None
    return node


class Scope:
    """Where an expression is read: a module, a class body or a function with its local names."""

    def __init__(self, module: Module, fn: Fn | None = None, cls: TypeUnit | None = None) -> None:
        self.module = module
        self.fn = fn
        self.cls = cls if cls is not None else (fn.owner if fn else None)
        self.locals: set = set()
        self.values: dict = {}
        # Names a function imports for itself: `from .facts import analyze` inside the body.
        self.bindings: dict = {}
        self.self_name = None
        self.cls_name = None


class Resolver:
    def __init__(self, p: Project) -> None:
        self.p = p
        self._scopes: dict = {}
        self._field_values: dict = {}
        self._from_guard: set = set()

    # Modules -------------------------------------------------------------------------------------------------------
    def find_module(self, name: str, importer: Module | None):
        """The project module an absolute import names: the id itself or a suffix of an id (spec/metrics.md, Python)."""
        if not name:
            return None
        exact = self.p.by_id.get(name)
        if exact:
            return exact
        suffix = "." + name
        candidates = [m for m in self.p.modules if m.id.endswith(suffix)]
        if not candidates:
            return None

        def common(m: Module) -> int:
            if importer is None:
                return 0
            a, b = m.id.split("."), importer.id.split(".")
            n = 0
            while n < len(a) and n < len(b) and a[n] == b[n]:
                n += 1
            return n

        candidates.sort(key=lambda m: (-common(m), len(m.id), m.id))
        return candidates[0]

    def is_namespace(self, name: str, importer: Module | None) -> bool:
        """Whether a dotted name is a package prefix of project modules without a module of its own."""
        return any(m.id.startswith(name + ".") or ("." + name + ".") in ("." + m.id) for m in self.p.modules)

    def external(self, name: str) -> ExtRef:
        top = name.split(".")[0]
        return ExtRef(name, top in STDLIB)

    def module_ref(self, name: str, importer: Module | None):
        own = self.find_module(name, importer)
        if own:
            return ModRef(own.id, own)
        if self.is_namespace(name, importer):
            return ModRef(name, None)
        return self.external(name)

    def import_target(self, name: str, importer: Module, relative: bool = False):
        """The module id an import statement reaches, its external flag and its stdlib flag."""
        own = self.p.by_id.get(name) if relative else self.find_module(name, importer)
        if own:
            return own.id, False, False
        top = name.split(".")[0] if name else ""
        return top, True, top in STDLIB

    # Linking -------------------------------------------------------------------------------------------------------
    def link(self) -> None:
        for t in self.p.all_types():
            self._link_bases(t)
        for t in self.p.all_types():
            self._link_kind(t)
        for t in self.p.all_types():
            self._declare_members(t)
        for f in self.p.all_functions():
            self._link_function(f)
        for m in self.p.modules:
            self._declare_globals(m)
        self._mark_rebound_class_attributes()

    def _link_bases(self, t: TypeUnit) -> None:
        scope = self.class_scope(t)
        for base in t.node.bases:
            expression = base.value if isinstance(base, ast.Subscript) else base
            ref = self.resolve(expression, scope)
            if isinstance(ref, TypeRef):
                t.project_bases.append(ref.type)
            elif isinstance(ref, ExtRef):
                t.external_bases.append(ref.id)
            elif ref is None and isinstance(expression, ast.Name) and self._is_builtin(expression.id, scope):
                t.external_bases.append(expression.id)  # Exception, dict…: a base outside the project, one step of DIT
            if isinstance(base, ast.Subscript) and (dotted(base.value) or "").split(".")[-1] in ("Generic", "Protocol"):
                arguments = base.slice.elts if isinstance(base.slice, ast.Tuple) else [base.slice]
                for argument in arguments:
                    name = dotted(argument.value if isinstance(argument, ast.Starred) else argument)
                    if name and name not in t.type_parameters:
                        t.type_parameters.append(name)

    def _external_tail(self, t: TypeUnit) -> set:
        return {e.split(".")[-1] for e in t.external_bases}

    def _link_kind(self, t: TypeUnit, seen=None) -> None:
        tails = self._external_tail(t)
        decorators = {decorator_name(d).split(".")[-1] for d in t.node.decorator_list}
        if "Protocol" in tails:
            t.kind = "protocol"
            t.is_abstract = True
        elif tails & ENUM_BASES or any(self._is_enum(b, set()) for b in t.project_bases):
            t.kind = "enum"
        else:
            t.kind = "class"
            metaclass = any(k.arg == "metaclass" and (dotted(k.value) or "").split(".")[-1] == "ABCMeta" for k in t.node.keywords)
            abstract_method = any(isinstance(s, FUNCTION_NODES) and any(decorator_name(d).split(".")[-1] == "abstractmethod" for d in s.decorator_list) for s in t.node.body)
            t.is_abstract = "ABC" in tails or metaclass or abstract_method
        frozen = False
        for d in t.node.decorator_list:
            if decorator_name(d).split(".")[-1] == "dataclass":
                t.record = True
                if isinstance(d, ast.Call):
                    frozen = any(k.arg == "frozen" and isinstance(k.value, ast.Constant) and k.value.value is True for k in d.keywords)
        if "NamedTuple" in tails:
            t.record = True
            frozen = True
        if "TypedDict" in tails:
            t.record = True
        t.frozen = frozen or "dataclass" in decorators and frozen

    def _is_enum(self, t: TypeUnit, seen: set) -> bool:
        if t in seen:
            return False
        seen.add(t)
        return bool(self._external_tail(t) & ENUM_BASES) or any(self._is_enum(b, seen) for b in t.project_bases)

    def _link_function(self, f: Fn) -> None:
        if isinstance(f.node, ast.Lambda):
            return
        if f.owner and f.owner.kind == "protocol" and is_stub_body(f.node.body):
            f.is_abstract = True
        if f.is_abstract:
            f.has_body = False

    def _declare_members(self, t: TypeUnit) -> None:
        info = t.module.file
        by_name: dict = {}

        def add(member: Member) -> None:
            if member.name in by_name:
                return
            by_name[member.name] = member
            t.members.append(member)
            self.p.member_of_node[member.node] = member

        for statement in t.node.body:
            if isinstance(statement, ast.AnnAssign) and isinstance(statement.target, ast.Name):
                name = statement.target.id
                if is_dunder(name):
                    continue
                if t.kind == "enum":
                    add(Member(name, "literal", statement.target, t, "public", False, False, order=(statement.lineno, statement.col_offset)))
                    continue
                head = (dotted(strip_quotes(statement.annotation).value) if isinstance(strip_quotes(statement.annotation), ast.Subscript) else dotted(strip_quotes(statement.annotation))) or ""
                static = head.split(".")[-1] == "ClassVar"
                add(Member(name, "field", statement.target, t, "private" if is_private(name) else "public", static, not t.frozen if not static else False,
                           statement.annotation, statement.value, order=(statement.lineno, statement.col_offset)))
            elif isinstance(statement, ast.Assign):
                for target in statement.targets:
                    for name_node in names_of(target):
                        name = name_node.id
                        if is_dunder(name) or name == "_ignore_":
                            continue
                        if t.kind == "enum":
                            add(Member(name, "literal", name_node, t, "public", False, False, order=(statement.lineno, statement.col_offset)))
                        else:
                            add(Member(name, "field", name_node, t, "private" if is_private(name) else "public", True, False, None, statement.value,
                                       order=(statement.lineno, statement.col_offset)))
        # Properties: the getter and an optional setter are one member.
        for f in t.methods:
            if f.kind != "accessor":
                continue
            known = by_name.get(f.name)
            if known is None:
                member = Member(f.name, "property", f.node, t, f.visibility, f.is_static, False, f.node.returns if f.id.endswith(".get") else None,
                                order=(f.node.lineno, f.node.col_offset))
                add(member)
                known = member
            elif known.kind == "property":
                self.p.member_of_node[f.node] = known
            if f.id.endswith(".set"):
                known.mutable = True
            if known.annotation is None and f.id.endswith(".get"):
                known.annotation = f.node.returns
        # Instance fields assigned through self in the methods, in method order.
        for f in t.methods:
            if f.is_static or isinstance(f.node, ast.Lambda) or not f.node.args.args:
                continue
            self_name = (f.node.args.posonlyargs + f.node.args.args)[0].arg
            for node in ast.walk(f.node):
                target, annotation, value = None, None, None
                if isinstance(node, ast.Assign):
                    for target_node in node.targets:
                        for attribute in _attributes(target_node):
                            if isinstance(attribute.value, ast.Name) and attribute.value.id == self_name:
                                self._instance_field(t, attribute, None, node.value if attribute is target_node else None, f, add, by_name)
                    continue
                if isinstance(node, ast.AnnAssign):
                    target, annotation, value = node.target, node.annotation, node.value
                elif isinstance(node, ast.AugAssign):
                    target = node.target
                if isinstance(target, ast.Attribute) and isinstance(target.value, ast.Name) and target.value.id == self_name:
                    self._instance_field(t, target, annotation, value, f, add, by_name)
        t.members.sort(key=lambda m: m.order)

    def _instance_field(self, t: TypeUnit, target: ast.Attribute, annotation, value, f: Fn, add, by_name) -> None:
        name = target.attr
        known = by_name.get(name)
        if known is not None:
            if known.kind == "field" and known.is_static and f.is_classmethod is False:
                pass
            if known.kind == "field" and known.annotation is None and annotation is not None:
                known.annotation = annotation
            if known.kind == "field" and known.value is None and value is not None:
                known.value, known.value_fn = value, f
            return
        member = Member(name, "field", target, t, "private" if is_private(name) else "public", False, not t.frozen, annotation, value, f,
                        order=(10 ** 9, f.node.lineno, target.lineno, target.col_offset))
        add(member)

    def _declare_globals(self, m: Module) -> None:
        """Module variables that are state (spec/paradigms.md, Python): rebound, or a list, dict or set."""
        tree = m.file.tree
        if tree is None:
            return
        declared_global = set()
        for node in ast.walk(tree):
            if isinstance(node, ast.Global):
                declared_global.update(node.names)
        for name, binding in sorted(m.bindings.items()):
            if binding.kind != "variable" or is_dunder(name):
                continue
            statements = binding.target or []
            constant = bool(CONSTANT_NAME.match(name))
            annotated_final = any(isinstance(s, ast.AnnAssign) and (dotted(s.annotation.value if isinstance(s.annotation, ast.Subscript) else s.annotation) or "").split(".")[-1] == "Final"
                                  for s in statements)
            first = statements[0]
            value = getattr(first, "value", None)
            rebound = name in declared_global or len([s for s in statements if not (isinstance(s, ast.AnnAssign) and s.value is None)]) > 1 \
                or any(isinstance(s, ast.AugAssign) for s in statements)
            collection = isinstance(value, (ast.List, ast.Dict, ast.Set, ast.ListComp, ast.DictComp, ast.SetComp))
            if constant or annotated_final or not (rebound or collection):
                continue
            target = binding.node
            g = Global(f"{m.id}.{name}", name, self.p.place(m.file, target), target)
            m.globals.append(g)
            binding.kind = "global"
            binding.target = g
        m.globals.sort(key=lambda g: (g.place.startLine, g.name))

    def _mark_rebound_class_attributes(self) -> None:
        """A class attribute assigned through its class anywhere is shared mutable state (STR002)."""
        for m in self.p.modules:
            tree = m.file.tree
            if tree is None:
                continue
            for node in ast.walk(tree):
                targets = node.targets if isinstance(node, ast.Assign) else [node.target] if isinstance(node, (ast.AugAssign, ast.AnnAssign)) else []
                for target in targets:
                    for attribute in _attributes(target):
                        owner = self._class_of_expression(attribute.value, m, node)
                        if owner is None:
                            continue
                        for member in owner.members:
                            if member.name == attribute.attr and member.kind == "field" and member.is_static:
                                member.mutable = True

    def _class_of_expression(self, expression: ast.AST, m: Module, statement: ast.AST):
        if isinstance(expression, ast.Name):
            f = self._enclosing_function(m, statement)
            if f and f.is_classmethod and f.node.args.args and f.node.args.args[0].arg == expression.id:
                return f.owner
            if f is None or expression.id not in self.scope_of(f).locals:
                ref = self.resolve(expression, self.scope_of(f) if f else self.module_scope(m))
                return ref.type if isinstance(ref, TypeRef) else None
            return None
        if isinstance(expression, ast.Attribute):
            f = self._enclosing_function(m, statement)
            ref = self.resolve(expression, self.scope_of(f) if f else self.module_scope(m))
            return ref.type if isinstance(ref, TypeRef) else None
        return None

    def _enclosing_function(self, m: Module, node: ast.AST):
        best = None
        for f in self.p.functions.values():
            if f.module is m and not isinstance(f.node, ast.Lambda) and f.node.lineno <= node.lineno <= f.node.end_lineno:
                if best is None or f.node.lineno >= best.node.lineno:
                    best = f
        return best

    # Scopes --------------------------------------------------------------------------------------------------------
    def module_scope(self, m: Module) -> Scope:
        key = ("module", m.id)
        if key not in self._scopes:
            self._scopes[key] = Scope(m)
        return self._scopes[key]

    def class_scope(self, t: TypeUnit) -> Scope:
        key = ("class", t.id)
        if key not in self._scopes:
            scope = Scope(t.module, None, t)
            # Names bound in a class body are class attributes, not module names; methods do not see them.
            self._scopes[key] = scope
        return self._scopes[key]

    def scope_of(self, f: Fn) -> Scope:
        key = ("fn", f.id)
        if key in self._scopes:
            return self._scopes[key]
        scope = Scope(f.module, f)
        self._scopes[key] = scope
        node = f.node
        arguments = node.args
        params = arguments.posonlyargs + arguments.args + arguments.kwonlyargs + [a for a in (arguments.vararg, arguments.kwarg) if a]
        scope.locals.update(a.arg for a in params)
        if f.implicit_first() and (arguments.posonlyargs + arguments.args):
            first = (arguments.posonlyargs + arguments.args)[0].arg
            if f.is_classmethod:
                scope.cls_name = first
            else:
                scope.self_name = first
        declared = set()
        for child in ast.walk(node):
            if isinstance(child, (ast.Global, ast.Nonlocal)):
                declared.update(child.names)
            elif isinstance(child, ast.Name) and isinstance(child.ctx, (ast.Store, ast.Del)):
                scope.locals.add(child.id)
            elif isinstance(child, ast.arg):
                scope.locals.add(child.arg)
            elif isinstance(child, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)) and child is not node:
                scope.locals.add(child.name)
            elif isinstance(child, ast.Import):
                for alias in child.names:
                    local = alias.asname or alias.name.split(".")[0]
                    scope.bindings[local] = Binding("module", alias.name if alias.asname else local, local, False, child)
            elif isinstance(child, ast.ImportFrom):
                base = self.p.absolute(f.module, child.module or "", child.level)
                for alias in child.names:
                    if alias.name != "*":
                        local = alias.asname or alias.name
                        scope.bindings[local] = Binding("from", (base, alias.name, child.level > 0), local, False, child)
            elif isinstance(child, ast.ExceptHandler) and child.name:
                scope.locals.add(child.name)
        scope.locals -= declared
        scope.locals -= set(scope.bindings)
        # Parameter annotations first, then assignments in source order; the first known type of a name stays.
        for a in params:
            if a.annotation is not None:
                value = self.annotation_value(a.annotation, scope)
                if value is not None:
                    if a is arguments.vararg:
                        value = Value(builtin="tuple", element=value)
                    elif a is arguments.kwarg:
                        value = Value(builtin="dict", element=value)
                    scope.values[a.arg] = value
        statements = sorted((n for n in ast.walk(node) if isinstance(n, (ast.Assign, ast.AnnAssign, ast.For, ast.AsyncFor, ast.comprehension, ast.withitem))),
                            key=lambda n: (getattr(n, "lineno", 0) or getattr(getattr(n, "target", None), "lineno", 0), getattr(n, "col_offset", 0)))
        for n in statements:
            if isinstance(n, ast.AnnAssign) and isinstance(n.target, ast.Name):
                value = self.annotation_value(n.annotation, scope)
                if value is not None:
                    scope.values.setdefault(n.target.id, value)
            elif isinstance(n, ast.Assign) and len(n.targets) == 1 and isinstance(n.targets[0], ast.Name):
                value = self.value_of(n.value, scope)
                if value is not None:
                    scope.values.setdefault(n.targets[0].id, value)
            elif isinstance(n, (ast.For, ast.AsyncFor, ast.comprehension)) and isinstance(n.target, ast.Name):
                collection = self.value_of(n.iter, scope)
                if collection is not None and collection.element is not None:
                    scope.values.setdefault(n.target.id, collection.element)
        return scope

    # Values --------------------------------------------------------------------------------------------------------
    def annotation_value(self, annotation: ast.AST, scope: Scope, depth: int = 0):
        """The value an annotation states: a project type, a builtin kind, a collection with its element."""
        node = strip_quotes(annotation)
        if node is None or depth > 8:
            return None
        if isinstance(node, ast.BinOp) and isinstance(node.op, ast.BitOr):
            parts = [x for x in _union_parts(node) if not _is_none(x)]
            return self.annotation_value(parts[0], scope, depth + 1) if len(parts) == 1 else None
        if isinstance(node, ast.Subscript):
            head = (dotted(node.value) or "").split(".")[-1]
            arguments = node.slice.elts if isinstance(node.slice, ast.Tuple) else [node.slice]
            if head == "Union":
                parts = [x for x in arguments if not _is_none(x)]
                return self.annotation_value(parts[0], scope, depth + 1) if len(parts) == 1 else None
            if head in WRAPPERS and head not in ("Type", "type"):
                return self.annotation_value(arguments[0], scope, depth + 1)
            if head in ("tuple", "Tuple"):
                if len(arguments) == 2 and isinstance(arguments[1], ast.Constant) and arguments[1].value is Ellipsis:
                    return Value(builtin="tuple", element=self.annotation_value(arguments[0], scope, depth + 1))
                return Value(builtin="tuple")
            if head in COLLECTIONS:
                return Value(builtin=BUILTIN_KINDS.get(head, "collection"), element=self.annotation_value(arguments[-1], scope, depth + 1))
            ref = self.resolve(node.value, scope)
            return Value(type=ref.type) if isinstance(ref, TypeRef) else None
        if isinstance(node, (ast.Name, ast.Attribute)):
            name = dotted(node) or ""
            tail = name.split(".")[-1]
            if tail in BUILTIN_KINDS and (tail not in scope.module.bindings or scope.module.bindings[tail].kind in ("from", "module")):
                return Value(builtin=BUILTIN_KINDS[tail])
            ref = self.resolve(node, scope)
            if isinstance(ref, TypeRef):
                return Value(type=ref.type)
        return None

    def member_value(self, member: Member):
        if member.kind == "literal":
            return Value(type=member.owner)
        key = id(member)
        if key in self._field_values:
            return self._field_values[key]
        self._field_values[key] = None
        value = None
        if member.annotation is not None:
            scope = self.scope_of(member.value_fn) if member.value_fn else self.class_scope(member.owner)
            value = self.annotation_value(member.annotation, scope if member.value_fn else self._annotation_scope(member.owner))
        if value is None and member.value is not None:
            scope = self.scope_of(member.value_fn) if member.value_fn else self._annotation_scope(member.owner)
            value = self.value_of(member.value, scope)
        self._field_values[key] = value
        return value

    def _annotation_scope(self, t: TypeUnit) -> Scope:
        return self.module_scope(t.module)

    def value_of(self, expression: ast.AST, scope: Scope):
        """The value of an expression when the code states it."""
        if isinstance(expression, (ast.List, ast.ListComp)):
            element = None
            if isinstance(expression, ast.List) and expression.elts:
                element = self.value_of(expression.elts[0], scope)
            return Value(builtin="list", element=element)
        if isinstance(expression, ast.Tuple):
            return Value(builtin="tuple")
        if isinstance(expression, (ast.Dict, ast.DictComp)):
            return Value(builtin="dict")
        if isinstance(expression, (ast.Set, ast.SetComp)):
            return Value(builtin="set")
        if isinstance(expression, ast.JoinedStr) or (isinstance(expression, ast.Constant) and isinstance(expression.value, str)):
            return Value(builtin="str")
        if isinstance(expression, ast.BinOp) and isinstance(expression.op, ast.Add):
            left = self.value_of(expression.left, scope)
            if left is not None and left.builtin == "str":
                return left
        if isinstance(expression, ast.Call):
            ref = self.resolve(expression.func, scope)
            if isinstance(ref, TypeRef):
                return Value(type=ref.type)
            if isinstance(ref, FnRef) and not isinstance(ref.fn.node, ast.Lambda) and ref.fn.node.returns is not None:
                return self.annotation_value(ref.fn.node.returns, self._function_annotation_scope(ref.fn))
            if isinstance(expression.func, ast.Name) and expression.func.id in ("list", "sorted", "tuple", "dict", "set", "str") and self._is_builtin(expression.func.id, scope):
                kind = {"sorted": "list"}.get(expression.func.id, expression.func.id)
                element = None
                if expression.args and kind in ("list", "tuple"):
                    source = self.value_of(expression.args[0], scope)
                    element = source.element if source else None
                return Value(builtin=kind, element=element)
            return None
        if isinstance(expression, ast.Subscript):
            container = self.value_of(expression.value, scope)
            if container is not None and container.element is not None and not isinstance(expression.slice, ast.Slice):
                return container.element
            if container is not None and isinstance(expression.slice, ast.Slice):
                return container
            return None
        if isinstance(expression, (ast.Name, ast.Attribute)):
            ref = self.resolve(expression, scope)
            if isinstance(ref, Value):
                return ref
            if isinstance(ref, MemberRef):
                return self.member_value(ref.member)
            if isinstance(ref, FnRef) and ref.fn.kind == "accessor" and not isinstance(ref.fn.node, ast.Lambda) and ref.fn.node.returns is not None:
                return self.annotation_value(ref.fn.node.returns, self._function_annotation_scope(ref.fn))
        return None

    def _function_annotation_scope(self, f: Fn) -> Scope:
        return self.scope_of(f) if not isinstance(f.node, ast.Lambda) else self.module_scope(f.module)

    def _is_builtin(self, name: str, scope: Scope) -> bool:
        if scope.fn is not None and name in self.scope_of(scope.fn).locals:
            return False
        return name in BUILTINS and name not in scope.module.bindings

    def is_builtin(self, name: str, scope: Scope) -> bool:
        return self._is_builtin(name, scope)

    # References ----------------------------------------------------------------------------------------------------
    def binding_ref(self, binding: Binding, m: Module):
        if binding.kind == "type":
            return TypeRef(binding.target)
        if binding.kind == "fn":
            return FnRef(binding.target)
        if binding.kind == "global":
            return GlobalRef(binding.target)
        if binding.kind == "module":
            return self.module_ref(binding.target, m)
        if binding.kind == "from":
            base, name, relative = binding.target
            key = (m.id, binding.name)
            if key in self._from_guard:
                return None
            self._from_guard.add(key)
            try:
                return self._from_ref(base, name, relative, m)
            finally:
                self._from_guard.discard(key)
        return None

    def _from_ref(self, base: str, name: str, relative: bool, m: Module):
        full = f"{base}.{name}" if base else name
        own = self.p.by_id.get(full) if relative else self.find_module(full, m)
        if own:
            return ModRef(own.id, own)
        container = self.p.by_id.get(base) if relative else self.find_module(base, m)
        if container is not None:
            return self.member_of_module(container, name)
        if relative or self.is_namespace(base, m):
            return None
        return self.external(full)

    def member_of_module(self, m: Module, name: str):
        binding = m.bindings.get(name)
        if binding is not None:
            return self.binding_ref(binding, m)
        sub = self.p.by_id.get(f"{m.id}.{name}")
        return ModRef(sub.id, sub) if sub else None

    def lookup_type(self, t: TypeUnit, name: str, seen=None):
        """A method, member or nested type of a class or of its project bases, in base order."""
        seen = seen or set()
        if t in seen:
            return None
        seen.add(t)
        for f in t.methods:
            if f.name == name and f.kind != "accessor":
                return f
        for member in t.members:
            if member.name == name:
                return member
        for nested in t.nested:
            if nested.name == name:
                return nested
        for base in t.project_bases:
            found = self.lookup_type(base, name, seen)
            if found is not None:
                return found
        return None

    def resolve(self, node: ast.AST, scope: Scope):
        """What a Name or an Attribute chain refers to, or None."""
        if isinstance(node, ast.Name):
            return self._resolve_name(node.id, scope)
        if isinstance(node, ast.Attribute):
            base = self.resolve(node.value, scope)
            return self.attribute(base, node.attr, scope)
        if isinstance(node, ast.Call):
            value = self.value_of(node, scope)
            return value
        if isinstance(node, ast.Subscript):
            return self.value_of(node, scope)
        if isinstance(node, ast.Constant) and isinstance(node.value, str):
            return Value(builtin="str")
        return None

    def _resolve_name(self, name: str, scope: Scope):
        if scope.fn is not None:
            if name == scope.self_name and scope.cls is not None:
                return Value(type=scope.cls)
            if name == scope.cls_name and scope.cls is not None:
                return TypeRef(scope.cls)
            if name in scope.locals:
                return scope.values.get(name) or None
            if name in scope.bindings:
                return self.binding_ref(scope.bindings[name], scope.module)
        m = scope.module
        binding = m.bindings.get(name)
        if binding is not None:
            return self.binding_ref(binding, m)
        return None

    def attribute(self, base, name: str, scope: Scope):
        if base is None:
            return None
        if isinstance(base, ModRef):
            if base.module is not None:
                found = self.member_of_module(base.module, name)
                if found is not None:
                    return found
                return None
            sub = self.find_module(f"{base.name}.{name}", scope.module)
            if sub:
                return ModRef(sub.id, sub)
            if self.is_namespace(f"{base.name}.{name}", scope.module):
                return ModRef(f"{base.name}.{name}", None)
            return None
        if isinstance(base, ExtRef):
            return ExtRef(f"{base.id}.{name}", base.stdlib)
        if isinstance(base, TypeRef):
            found = self.lookup_type(base.type, name)
            if isinstance(found, Fn):
                return FnRef(found, True)
            if isinstance(found, Member):
                return MemberRef(found, True)
            if isinstance(found, TypeUnit):
                return TypeRef(found)
            return None
        value = None
        if isinstance(base, Value):
            value = base
        elif isinstance(base, MemberRef):
            value = self.member_value(base.member)
        if value is not None and value.type is not None:
            found = self.lookup_type(value.type, name)
            if isinstance(found, Fn):
                return FnRef(found)
            if isinstance(found, Member):
                return MemberRef(found)
            if isinstance(found, TypeUnit):
                return TypeRef(found)
        return None


def _union_parts(node: ast.AST):
    if isinstance(node, ast.BinOp) and isinstance(node.op, ast.BitOr):
        yield from _union_parts(node.left)
        yield from _union_parts(node.right)
    else:
        yield node


def _is_none(node: ast.AST) -> bool:
    return isinstance(node, ast.Constant) and node.value is None or (isinstance(node, ast.Name) and node.id == "None")


def _attributes(target: ast.AST):
    if isinstance(target, ast.Attribute):
        yield target
    elif isinstance(target, (ast.Tuple, ast.List)):
        for e in target.elts:
            yield from _attributes(e)
    elif isinstance(target, ast.Starred):
        yield from _attributes(target.value)
