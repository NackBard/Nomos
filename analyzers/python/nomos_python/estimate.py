"""Time estimates of spec/metrics.md: n^degree · log^l n, or exponential."""
from __future__ import annotations

import ast
from dataclasses import dataclass, replace

from .metrics import is_literal_number, walk_body
from .project import COMPREHENSIONS, FUNCTION_NODES, Fn, FnRef, Project, TypeRef, Value, decorator_name


@dataclass(frozen=True)
class Growth:
    degree: int = 0
    log: int = 0
    exponential: bool = False
    uncertain: bool = False


CONSTANT = Growth()
LINEAR = Growth(1)
LOGARITHMIC = Growth(0, 1)


def times(a: Growth, b: Growth) -> Growth:
    return Growth(a.degree + b.degree, a.log + b.log, a.exponential or b.exponential, a.uncertain or b.uncertain)


def larger(a: Growth, b: Growth) -> Growth:
    pick_b = (b.exponential != a.exponential and b.exponential) or (b.exponential == a.exponential and (b.degree > a.degree or (b.degree == a.degree and b.log > a.log)))
    winner = b if pick_b else a
    return replace(winner, uncertain=a.uncertain or b.uncertain)


def growth_text(g: Growth) -> str:
    if g.exponential:
        return "O(2ⁿ)"
    parts = []
    if g.degree == 1:
        parts.append("n")
    elif g.degree == 2:
        parts.append("n²")
    elif g.degree == 3:
        parts.append("n³")
    elif g.degree > 3:
        parts.append(f"n^{g.degree}")
    if g.log == 1:
        parts.append("log n")
    elif g.log > 1:
        parts.append(f"log^{g.log} n")
    return "O(1)" if not parts else f"O({' '.join(parts)})"


LINEAR_BUILTINS = {"sum", "min", "max", "any", "all", "list", "tuple", "set", "frozenset", "dict"}
SORT_BUILTINS = {"sorted"}
LINEAR_METHODS = {"index", "count", "remove", "extend", "copy", "join"}
SORT_METHODS = {"sort"}
SEQUENCES = {"list", "tuple"}


def callee_of(p: Project, f: Fn, call: ast.Call):
    ref = p.resolver.resolve(call.func, p.resolver.scope_of(f))
    return ref.fn if isinstance(ref, FnRef) else None


def self_calls(p: Project, f: Fn) -> list:
    return [n for n in walk_body(f) if isinstance(n, ast.Call) and callee_of(p, f, n) is f]


def time_estimates(p: Project) -> dict:
    """Estimates every function with a body in ordinal id order: mutual recursion is cut at the function still being estimated."""
    e = Estimator(p)
    return {f.id: e.estimate(f) for f in p.all_functions() if f.has_body}


def divides_by_two(n: ast.AST) -> bool:
    for c in ast.walk(n):
        if isinstance(c, ast.BinOp) and isinstance(c.right, ast.Constant):
            if isinstance(c.op, (ast.FloorDiv, ast.Div)) and c.right.value == 2:
                return True
            if isinstance(c.op, ast.RShift) and c.right.value == 1:
                return True
    return False


def is_halving(n: ast.AST) -> bool:
    """A step that divides or multiplies a counter: //=, /=, *=, >>=, <<=, or i = i // 2."""
    if isinstance(n, ast.AugAssign):
        return isinstance(n.op, (ast.FloorDiv, ast.Div, ast.Mult, ast.RShift, ast.LShift))
    if isinstance(n, ast.Assign):
        return divides_by_two(n.value)
    return False


def constant_collection(x: ast.AST) -> bool:
    if isinstance(x, (ast.List, ast.Tuple, ast.Set)):
        return True
    if isinstance(x, ast.Constant) and isinstance(x.value, str):
        return True
    if isinstance(x, ast.Call) and isinstance(x.func, ast.Name) and x.func.id == "range" and x.args and all(is_literal_number(a) for a in x.args):
        return True
    return False


def can_complete(body: list) -> bool:
    if not body:
        return True
    return not isinstance(body[-1], (ast.Return, ast.Raise, ast.Break, ast.Continue))


class Estimator:
    def __init__(self, p: Project) -> None:
        self.p = p
        self.memo: dict = {}
        self.active: set = set()
        self.elements: set = set()
        self.current: Fn | None = None

    def estimate(self, f: Fn) -> Growth:
        if f in self.memo:
            return self.memo[f]
        if not f.has_body or f in self.active:
            return CONSTANT
        self.active.add(f)
        outer_elements, outer = self.elements, self.current
        self.elements, self.current = set(), f
        growth = self.combine(f, self.block(f.body_nodes()))
        self.elements, self.current = outer_elements, outer
        self.active.discard(f)
        self.memo[f] = growth
        return growth

    def block(self, nodes: list) -> Growth:
        total = CONSTANT
        for n in nodes:
            total = larger(total, self.cost(n))
        return total

    def children(self, n: ast.AST) -> Growth:
        return self.block(list(ast.iter_child_nodes(n)))

    def bind(self, target: ast.AST) -> list:
        added = []
        for name in ast.walk(target):
            if isinstance(name, ast.Name) and name.id not in self.elements:
                self.elements.add(name.id)
                added.append(name.id)
        return added

    def cost(self, n: ast.AST) -> Growth:
        if isinstance(n, (ast.For, ast.AsyncFor)):
            header = self.cost(n.iter)
            added = self.bind(n.target)
            iteration = self.block(n.body)
            for name in added:
                self.elements.discard(name)
            factor = CONSTANT if self.is_element_walk(n.iter) or constant_collection(n.iter) else LINEAR
            return larger(larger(header, times(factor, iteration)), self.block(n.orelse))
        if isinstance(n, ast.While):
            iteration = larger(self.block(n.body), self.cost(n.test))
            return larger(times(self.while_factor(n.body), iteration), self.block(n.orelse))
        if isinstance(n, COMPREHENSIONS):
            return self.comprehension(n)
        if isinstance(n, ast.Assign) and len(n.targets) == 1 and isinstance(n.targets[0], ast.Name) and self.is_element_walk(n.value):
            self.elements.add(n.targets[0].id)
            return self.cost(n.value)
        if isinstance(n, ast.Call):
            return self.call(n)
        if isinstance(n, ast.Compare):
            parts = self.children(n)
            if any(isinstance(op, (ast.In, ast.NotIn)) for op in n.ops) and self.is_sequence(n.comparators[-1]):
                return larger(parts, LINEAR)
            return parts
        return self.children(n)

    def comprehension(self, n: ast.AST) -> Growth:
        added = []
        factors = []
        header = CONSTANT
        for i, generator in enumerate(n.generators):
            if i == 0:
                header = self.cost(generator.iter)
            factor = CONSTANT if self.is_element_walk(generator.iter) or constant_collection(generator.iter) else LINEAR
            factors.append((factor, generator))
            added += self.bind(generator.target)
        inner = CONSTANT
        for element in ([n.key, n.value] if isinstance(n, ast.DictComp) else [n.elt]):
            inner = larger(inner, self.cost(element))
        for factor, generator in reversed(factors):
            for condition in generator.ifs:
                inner = larger(inner, self.cost(condition))
            if generator is not n.generators[0]:
                inner = larger(inner, self.cost(generator.iter))
            inner = times(factor, inner)
        for name in added:
            self.elements.discard(name)
        return larger(header, inner)

    def is_element_walk(self, x: ast.AST) -> bool:
        if isinstance(x, ast.Name):
            return x.id in self.elements
        if isinstance(x, (ast.Attribute, ast.Subscript)):
            return self.is_element_walk(x.value)
        if isinstance(x, ast.Call):
            return self.is_element_walk(x.func)
        return False

    def is_sequence(self, x: ast.AST) -> bool:
        if isinstance(x, (ast.List, ast.Tuple)):
            return False  # a literal collection has a constant size
        value = self.p.resolver.value_of(x, self.p.resolver.scope_of(self.current))
        return value is not None and value.builtin in SEQUENCES

    def library(self, call: ast.Call):
        """The library operation a call is: ('linear' or 'sort', name), or None."""
        r = self.p.resolver
        scope = r.scope_of(self.current)
        func = call.func
        if isinstance(func, ast.Name):
            if r.is_builtin(func.id, scope):
                if func.id in SORT_BUILTINS:
                    return "sort"
                if func.id in LINEAR_BUILTINS and call.args:
                    return "linear"
            return None
        if isinstance(func, ast.Attribute):
            ref = r.resolve(func, scope)
            if isinstance(ref, (FnRef, TypeRef)):
                return None
            receiver = r.value_of(func.value, scope)
            if func.attr == "join":
                return "linear" if receiver is not None and receiver.builtin == "str" or isinstance(func.value, ast.Constant) else None
            if receiver is not None and receiver.builtin == "str":
                return None
            if func.attr in SORT_METHODS:
                return "sort"
            if func.attr in LINEAR_METHODS:
                return "linear"
        return None

    def call(self, call: ast.Call) -> Growth:
        parts = self.cost(call.func)
        lam = CONSTANT
        bound = []
        for argument in list(call.args) + [k.value for k in call.keywords]:
            if isinstance(argument, ast.Lambda):
                for a in argument.args.posonlyargs + argument.args.args:
                    if a.arg not in self.elements:
                        self.elements.add(a.arg)
                        bound.append(a.arg)
                lam = larger(lam, self.cost(argument.body))
            else:
                parts = larger(parts, self.cost(argument))
        for name in bound:
            self.elements.discard(name)
        target = callee_of(self.p, self.current, call)
        if target is not None:
            callee = self.estimate(target)
            if callee.degree > 0 or callee.log > 0 or callee.exponential:
                callee = replace(callee, uncertain=True)
            return larger(larger(parts, lam), callee)
        kind = self.library(call)
        if kind == "sort":
            return larger(parts, Growth(1, 1))
        if kind == "linear":
            return larger(parts, times(LINEAR, lam))
        return larger(parts, lam)

    def while_factor(self, body: list) -> Growth:
        halves = any(is_halving(c) for n in body for c in ast.walk(n))
        return replace(LOGARITHMIC if halves else LINEAR, uncertain=True)

    def combine(self, f: Fn, work: Growth) -> Growth:
        own = self_calls(self.p, f)
        if not own:
            return work
        half_names = set()
        memoized = any(decorator_name(d).split(".")[-1] in ("cache", "lru_cache") for d in getattr(f.node, "decorator_list", []))
        for n in walk_body(f):
            if isinstance(n, ast.Assign) and divides_by_two(n.value):
                for target in n.targets:
                    if isinstance(target, ast.Name):
                        half_names.add(target.id)
            if isinstance(n, ast.Compare) and any(isinstance(op, (ast.In, ast.NotIn)) for op in n.ops):
                memoized = True
            if isinstance(n, ast.Call) and isinstance(n.func, ast.Attribute) and n.func.attr == "get":
                memoized = True
        halving = False
        decrements = False
        for call in own:
            for argument in list(call.args) + [k.value for k in call.keywords]:
                for c in ast.walk(argument):
                    if isinstance(c, ast.Name) and c.id in half_names:
                        halving = True
                    if isinstance(c, ast.BinOp) and isinstance(c.op, (ast.Sub, ast.Add)):
                        decrements = True
                halving = halving or divides_by_two(argument)
        per_path = self.calls_on_path_block(f, f.body_nodes())
        if per_path <= 1 and halving:
            recursion = LOGARITHMIC
        elif per_path <= 1:
            recursion = LINEAR
        elif halving:
            recursion = LINEAR
        elif memoized or not decrements:
            recursion = LINEAR
        else:
            recursion = Growth(0, 0, True)
        if per_path > 1 and halving:
            total = times(larger(work, LINEAR), LOGARITHMIC)
        elif not halving and not decrements:
            total = larger(work, LINEAR)
        else:
            total = times(recursion, work)
        return replace(total, uncertain=True)

    def calls_on_path(self, f: Fn, n: ast.AST) -> int:
        if isinstance(n, ast.If):
            return self.calls_on_path(f, n.test) + max(self.calls_on_path_block(f, n.body), self.calls_on_path_block(f, n.orelse))
        if isinstance(n, ast.IfExp):
            return self.calls_on_path(f, n.test) + max(self.calls_on_path(f, n.body), self.calls_on_path(f, n.orelse))
        match = getattr(ast, "Match", None)
        if match is not None and isinstance(n, match):
            return self.calls_on_path(f, n.subject) + max([self.calls_on_path_block(f, c.body) for c in n.cases] or [0])
        if isinstance(n, (ast.Lambda,) + FUNCTION_NODES):
            return 0
        count = 1 if isinstance(n, ast.Call) and callee_of(self.p, f, n) is f else 0
        for c in ast.iter_child_nodes(n):
            count += self.calls_on_path(f, c)
        return count

    def calls_on_path_block(self, f: Fn, statements: list) -> int:
        if not statements:
            return 0
        first, rest = statements[0], statements[1:]
        if isinstance(first, ast.If) and not first.orelse and not can_complete(first.body):
            return self.calls_on_path(f, first.test) + max(self.calls_on_path_block(f, first.body), self.calls_on_path_block(f, rest))
        return self.calls_on_path(f, first) + self.calls_on_path_block(f, rest)
