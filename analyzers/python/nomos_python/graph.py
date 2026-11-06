"""Dependency edges by spec/metrics.md, the unit and module graphs, cycles and blast radius."""
from __future__ import annotations

import ast
from dataclasses import dataclass

from .project import FUNCTION_NODES, ExtRef, Fn, FnRef, MemberRef, Module, Place, Project, TypeRef, TypeUnit, is_dunder
from .resolve import Scope, strip_quotes


@dataclass
class Edge:
    source: str
    to: str
    kind: str
    external: bool
    stdlib: bool
    to_type: bool
    type_only: bool
    place: Place


def unit_of_ref(ref):
    """The unit a reference belongs to: the type, the owner of a member or method, or a free function."""
    if isinstance(ref, TypeRef):
        return ref.type, True
    if isinstance(ref, FnRef):
        return (ref.fn.owner, True) if ref.fn.owner else (ref.fn, False)
    if isinstance(ref, MemberRef):
        return ref.member.owner, True
    return None, False


class _Collector:
    def __init__(self, p: Project, edges: list) -> None:
        self.p = p
        self.r = p.resolver
        self.edges = edges

    def unit(self, unit_id: str, nodes: list, scope: Scope, info, bases=()) -> None:
        self.unit_id = unit_id
        self.info = info
        self.bases = {id(b) for b in bases}
        for node in nodes:
            self.visit(node, scope, False, False)

    def root_type_only(self, node: ast.AST, scope: Scope) -> bool:
        while isinstance(node, ast.Attribute):
            node = node.value
        if isinstance(node, ast.Name):
            if scope.fn is not None and node.id in self.r.scope_of(scope.fn).locals:
                return False
            binding = scope.module.bindings.get(node.id)
            return bool(binding and binding.type_only)
        return False

    def record(self, node: ast.AST, ref, kind: str, type_only: bool, scope: Scope, place: Place | None) -> None:
        where = place or self.p.place(self.info, node)
        if isinstance(ref, ExtRef):
            tail = ref.id.split(".")[-1]
            to_type = tail[:1].isupper()
            self.edges.append(Edge(self.unit_id, ref.id, kind, True, ref.stdlib, to_type, type_only or self.root_type_only(node, scope), where))
            return
        target, is_type = unit_of_ref(ref)
        if target is None or target.id == self.unit_id:
            return
        erased = type_only or self.root_type_only(node, scope) or getattr(target, "type_only", False)
        self.edges.append(Edge(self.unit_id, target.id, kind, False, False, is_type, erased, where))

    def kind_of(self, node: ast.AST, ref, callee: bool, inheritance: bool) -> str:
        if inheritance:
            return "inheritance"
        if callee:
            return "call"
        if isinstance(ref, (FnRef, MemberRef)) and ref.through_type:
            return "call"
        return "type-ref"

    def visit(self, node: ast.AST, scope: Scope, annotation: bool, callee: bool, inheritance: bool = False, place: Place | None = None) -> None:
        if isinstance(node, ast.ClassDef):
            return  # a nested class is a unit of its own
        if isinstance(node, FUNCTION_NODES):
            f = self.p.fn_of_node.get(node)
            inner = self.r.scope_of(f) if f is not None else scope
            for d in node.decorator_list:
                self.visit(d, scope, False, not isinstance(d, ast.Call), False, place)
            self._arguments(node.args, inner, annotation, place)
            if node.returns is not None:
                self._annotation(node.returns, inner, place)
            for statement in node.body:
                self.visit(statement, inner, annotation, False, False, place)
            return
        if isinstance(node, ast.Lambda):
            self._arguments(node.args, scope, annotation, place)
            self.visit(node.body, scope, annotation, False, False, place)
            return
        if isinstance(node, ast.AnnAssign):
            self._annotation(node.annotation, scope, place)
            self.visit(node.target, scope, annotation, False, False, place)
            if node.value is not None:
                self.visit(node.value, scope, annotation, False, False, place)
            return
        if isinstance(node, ast.Call):
            self.visit(node.func, scope, annotation, True, False, place)
            for a in node.args:
                self.visit(a, scope, annotation, False, False, place)
            for k in node.keywords:
                self.visit(k.value, scope, annotation, False, False, place)
            return
        if isinstance(node, ast.Name):
            ref = self.r.resolve(node, scope)
            if ref is not None:
                self.record(node, ref, self.kind_of(node, ref, callee, inheritance), annotation, scope, place)
            return
        if isinstance(node, ast.Attribute):
            ref = self.r.resolve(node, scope)
            if ref is not None:
                self.record(node, ref, self.kind_of(node, ref, callee, inheritance), annotation, scope, place)
            if isinstance(ref, ExtRef):
                return  # one edge for os.path.join, not three for its prefixes
            self.visit(node.value, scope, annotation, False, inheritance, place)
            return
        if isinstance(node, ast.Subscript) and inheritance:
            self.visit(node.value, scope, annotation, False, True, place)
            self.visit(node.slice, scope, annotation, False, False, place)
            return
        if annotation and isinstance(node, ast.Constant) and isinstance(node.value, str):
            parsed = strip_quotes(node)
            if parsed is not None:
                self.visit(parsed, scope, True, False, False, place or self.p.place(self.info, node))
            return
        for child in ast.iter_child_nodes(node):
            self.visit(child, scope, annotation, False, False, place)

    def _annotation(self, node: ast.AST, scope: Scope, place) -> None:
        self.visit(node, scope, True, False, False, place)

    def _arguments(self, arguments: ast.arguments, scope: Scope, annotation: bool, place) -> None:
        for a in arguments.posonlyargs + arguments.args + arguments.kwonlyargs + [x for x in (arguments.vararg, arguments.kwarg) if x]:
            if a.annotation is not None:
                self._annotation(a.annotation, scope, place)
        for default in arguments.defaults + [d for d in arguments.kw_defaults if d is not None]:
            self.visit(default, scope, annotation, False, False, place)

    def type_unit(self, t: TypeUnit) -> None:
        scope = self.r.class_scope(t)
        node = t.node
        self.unit_id = t.id
        self.info = t.module.file
        for d in node.decorator_list:
            self.visit(d, scope, False, not isinstance(d, ast.Call))
        for base in node.bases:
            self.visit(base, scope, False, False, True)
        for k in node.keywords:
            self.visit(k.value, scope, False, False)
        for statement in node.body:
            self.visit(statement, scope, False, False)


def collect_edges(p: Project) -> list:
    edges: list = []
    collector = _Collector(p, edges)
    for m in p.modules:
        edges.extend(import_edges(p, m))
        for t in m.types:
            collector.type_unit(t)
        for f in m.functions:
            collector.unit_id = f.id
            collector.info = m.file
            if isinstance(f.node, ast.Lambda):
                collector.visit(f.node, p.resolver.scope_of(f), False, False)
            else:
                collector.visit(f.node, p.resolver.module_scope(m), False, False)
    return edges


def import_edges(p: Project, m: Module) -> list:
    r = p.resolver
    edges = []
    for ref in m.imports + m.dynamic_imports:
        node = ref.node
        relative = isinstance(node, ast.ImportFrom) and node.level > 0
        place = p.place(m.file, node)
        targets = []
        if ref.imported:
            reached_base = False
            for name in ref.imported:
                full = f"{ref.name}.{name}" if ref.name else name
                own = p.by_id.get(full) if relative else (r.find_module(full, m) if name != "*" else None)
                if own:
                    targets.append((own.id, False, False))
                elif not reached_base:
                    reached_base = True
                    targets.append(r.import_target(ref.name, m, relative))
        else:
            targets.append(r.import_target(ref.name, m, relative))
        for target, external, stdlib in targets:
            if not target or target == m.id:
                continue
            edges.append(Edge(m.id, target, "import", external, stdlib, False, ref.type_only, place))
    return edges


class Graph:
    def __init__(self) -> None:
        self.next: dict = {}
        self.prev: dict = {}

    def node(self, n: str) -> None:
        if n not in self.next:
            self.next[n] = set()
            self.prev[n] = set()

    def edge(self, a: str, b: str) -> None:
        self.node(a)
        self.node(b)
        self.next[a].add(b)
        self.prev[b].add(a)


class Graphs:
    def __init__(self) -> None:
        self.units = Graph()
        self.modules = Graph()
        self.runtime_units = Graph()
        self.runtime_modules = Graph()
        self.module_of: dict = {}
        self.radius: dict = {}


def build_graphs(p: Project, edges: list) -> Graphs:
    g = Graphs()
    for m in p.modules:
        for graph in (g.modules, g.runtime_modules):
            graph.node(m.id)
        for unit in m.types + m.functions:
            g.module_of[unit.id] = m
            g.units.node(unit.id)
            g.runtime_units.node(unit.id)
    for e in edges:
        if e.external:
            continue
        pairs = [(g.units, g.modules)] if e.type_only else [(g.units, g.modules), (g.runtime_units, g.runtime_modules)]
        for units, modules in pairs:
            if e.kind == "import":
                modules.edge(e.source, e.to)
                continue
            units.edge(e.source, e.to)
            a = g.module_of.get(e.source)
            b = g.module_of.get(e.to)
            if a is not None and b is not None and a is not b:
                modules.edge(a.id, b.id)
    for unit in g.units.next:
        g.radius[unit] = _reach(g.units, unit)
    return g


def _reach(g: Graph, start: str) -> int:
    seen = {start}
    queue = [start]
    while queue:
        current = queue.pop(0)
        for dependent in g.prev.get(current, ()):
            if dependent not in seen:
                seen.add(dependent)
                queue.append(dependent)
    return len(seen) - 1


def components(g: Graph) -> list:
    """Strongly connected components with two or more members (Tarjan), iteratively."""
    index: dict = {}
    low: dict = {}
    on_stack: set = set()
    stack: list = []
    result: list = []
    counter = 0
    for start in sorted(g.next):
        if start in index:
            continue
        work: list = []

        def enter(n: str) -> None:
            nonlocal counter
            index[n] = counter
            low[n] = counter
            counter += 1
            stack.append(n)
            on_stack.add(n)
            work.append([n, sorted(g.next[n])])

        enter(start)
        while work:
            top = work[-1]
            if top[1]:
                successor = top[1].pop(0)
                if successor not in index:
                    enter(successor)
                elif successor in on_stack:
                    low[top[0]] = min(low[top[0]], index[successor])
                continue
            work.pop()
            if work:
                parent = work[-1][0]
                low[parent] = min(low[parent], low[top[0]])
            if low[top[0]] != index[top[0]]:
                continue
            component = []
            while True:
                member = stack.pop()
                on_stack.discard(member)
                component.append(member)
                if member == top[0]:
                    break
            if len(component) > 1:
                result.append(sorted(component))
    return sorted(result, key=lambda c: c[0])


def simple_name(unit_id: str) -> str:
    tail = unit_id[unit_id.rfind("/") + 1:]
    return tail[tail.rfind(".") + 1:]


def is_special(name: str) -> bool:
    return is_dunder(name)
