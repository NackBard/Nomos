"""Metrics of spec/metrics.md over the Python syntax tree."""
from __future__ import annotations

import ast
import math

from .project import COMPREHENSIONS, FUNCTION_NODES, TRY_NODES, Fn, FnRef, MemberRef, Project, TypeRef, TypeUnit, Value, dotted
from .resolve import strip_quotes
from .text import js_round

LOOPS = (ast.For, ast.AsyncFor, ast.While)
MATCH = getattr(ast, "Match", None)
MATCH_CASE = getattr(ast, "match_case", None)
MATCH_CLASS = getattr(ast, "MatchClass", None)
MATCH_AS = getattr(ast, "MatchAs", None)


def round_to(value: float, digits: int) -> float:
    scale = 10 ** digits
    return js_round(value * scale) / scale


def line_span(place) -> int:
    return place.endLine - place.startLine + 1


def walk_body(f: Fn):
    """Every node of the body, nested functions and lambdas included: they belong to their owner."""
    for node in f.body_nodes():
        yield from ast.walk(node)


def is_default_case(case) -> bool:
    pattern = case.pattern
    return case.guard is None and MATCH_AS is not None and isinstance(pattern, MATCH_AS) and pattern.pattern is None and pattern.name is None


def cyclomatic(f: Fn) -> int:
    """1 + decision points: if and elif, case labels, loops, except, conditional expressions, and/or, comprehension ifs."""
    count = 1
    for n in walk_body(f):
        if isinstance(n, (ast.If, ast.IfExp, ast.ExceptHandler) + LOOPS):
            count += 1
        elif isinstance(n, ast.BoolOp):
            count += len(n.values) - 1
        elif isinstance(n, ast.comprehension):
            count += len(n.ifs)
        elif MATCH_CASE is not None and isinstance(n, MATCH_CASE) and not is_default_case(n):
            count += 1
    return count


def is_elif(f: Fn, node: ast.If) -> bool:
    text = f.file.line_texts[node.lineno - 1] if node.lineno <= len(f.file.line_texts) else ""
    column = len(text.encode("utf-8")[: node.col_offset].decode("utf-8", errors="ignore"))
    return text[column:].startswith("elif")


def max_nesting(f: Fn) -> int:
    """Deepest number of enclosing if, match, loop, try and with statements; elif stays on the level of its if."""
    deepest = 0
    nesting = (ast.With, ast.AsyncWith) + LOOPS + TRY_NODES + ((MATCH,) if MATCH else ())

    def visit(n: ast.AST, d: int) -> None:
        nonlocal deepest
        deepest = max(deepest, d)
        if isinstance(n, ast.If):
            visit_if(n, d)
            return
        if isinstance(n, nesting):
            deepest = max(deepest, d + 1)
            for c in ast.iter_child_nodes(n):
                visit(c, d + 1)
            return
        for c in ast.iter_child_nodes(n):
            visit(c, d)

    def visit_if(s: ast.If, d: int) -> None:
        visit(s.test, d)
        for c in s.body:
            visit(c, d + 1)
        if len(s.orelse) == 1 and isinstance(s.orelse[0], ast.If) and is_elif(f, s.orelse[0]):
            visit_if(s.orelse[0], d)
        else:
            for c in s.orelse:
                visit(c, d + 1)

    for node in f.body_nodes():
        visit(node, 0)
    return deepest


def all_parameters(arguments: ast.arguments) -> list:
    return arguments.posonlyargs + arguments.args + ([arguments.vararg] if arguments.vararg else []) + arguments.kwonlyargs + ([arguments.kwarg] if arguments.kwarg else [])


def declared_parameters(f: Fn) -> list:
    """Parameters without the implicit self or cls of a method."""
    params = all_parameters(f.args)
    if f.implicit_first() and (f.args.posonlyargs + f.args.args):
        params = params[1:]
    return params


def parameter_count(f: Fn) -> int:
    return len(declared_parameters(f))


CALLABLES = {"Callable"}
SEQUENCE_HEADS = {"list", "List", "Sequence", "Iterable", "Iterator", "tuple", "Tuple", "set", "Set", "frozenset", "Optional", "Union", "Collection"}


def function_depth(annotation: ast.AST, depth: int = 0) -> int:
    """Depth of function types in an annotation: Callable[[A], R] is 1 + the deepest of A and R."""
    node = strip_quotes(annotation)
    if node is None or depth > 10:
        return 0
    if isinstance(node, ast.BinOp) and isinstance(node.op, ast.BitOr):
        return max(function_depth(node.left, depth + 1), function_depth(node.right, depth + 1))
    if isinstance(node, (ast.Name, ast.Attribute)):
        return 1 if (dotted(node) or "").split(".")[-1] in CALLABLES else 0
    if isinstance(node, ast.Subscript):
        head = (dotted(node.value) or "").split(".")[-1]
        arguments = node.slice.elts if isinstance(node.slice, ast.Tuple) else [node.slice]
        if head in CALLABLES:
            inner = 0
            for argument in arguments:
                parts = argument.elts if isinstance(argument, ast.List) else [argument]
                for part in parts:
                    inner = max(inner, function_depth(part, depth + 1))
            return 1 + inner
        if head in SEQUENCE_HEADS or head in ("Annotated", "Final", "ClassVar"):
            return max([function_depth(a, depth + 1) for a in arguments] or [0])
    return 0


def hof_order(p: Project, f: Fn) -> int:
    """1 + the deepest function type in the parameters and the result; without annotations, a parameter called in the
    body or a returned lambda or local function is a function of data (spec/paradigms.md, Python)."""
    depth = 0
    params = declared_parameters(f)
    called = set()
    returned_function = False
    local_functions = set()
    for n in walk_body(f):
        if isinstance(n, ast.Call) and isinstance(n.func, ast.Name):
            called.add(n.func.id)
        if isinstance(n, FUNCTION_NODES):
            local_functions.add(n.name)
    for n in walk_body(f):
        if isinstance(n, ast.Return) and n.value is not None:
            if isinstance(n.value, ast.Lambda) or (isinstance(n.value, ast.Name) and n.value.id in local_functions):
                returned_function = True
    if isinstance(f.node, ast.Lambda) and isinstance(f.node.body, ast.Lambda):
        returned_function = True
    for a in params:
        if a.annotation is not None:
            depth = max(depth, function_depth(a.annotation))
        elif a.arg in called:
            depth = max(depth, 1)
    returns = getattr(f.node, "returns", None)
    if returns is not None:
        depth = max(depth, function_depth(returns))
    elif returned_function:
        depth = max(depth, 1)
    return 1 + depth


def lambda_nesting(f: Fn) -> int:
    def depth(n: ast.AST) -> int:
        deepest = 0
        for c in ast.iter_child_nodes(n):
            deepest = max(deepest, 1 + depth(c) if isinstance(c, ast.Lambda) else depth(c))
        return deepest

    return max([depth(n) if not isinstance(n, ast.Lambda) else 1 + depth(n) for n in f.body_nodes()] or [0])


def tested_types(p: Project, f: Fn) -> list:
    """Distinct project types a function tests at run time: isinstance, issubclass and class patterns."""
    r = p.resolver
    scope = r.scope_of(f)
    seen = set()

    def add(expression: ast.AST) -> None:
        targets = expression.elts if isinstance(expression, ast.Tuple) else [expression]
        for target in targets:
            ref = r.resolve(target, scope)
            if isinstance(ref, TypeRef):
                seen.add(ref.type.id)

    for n in walk_body(f):
        if isinstance(n, ast.Call) and isinstance(n.func, ast.Name) and n.func.id in ("isinstance", "issubclass") and len(n.args) == 2 and r.is_builtin(n.func.id, scope):
            add(n.args[1])
        elif MATCH_CLASS is not None and isinstance(n, MATCH_CLASS):
            add(n.cls)
    return sorted(seen)


def walk_loops(f: Fn, visit) -> None:
    """Visits every node with the number of loops whose body holds it; loop headers that run once are outside."""

    def go(n: ast.AST, depth: int) -> None:
        visit(n, depth)
        if isinstance(n, (ast.For, ast.AsyncFor)):
            go(n.target, depth + 1)
            go(n.iter, depth)
            for c in n.body:
                go(c, depth + 1)
            for c in n.orelse:
                go(c, depth)
            return
        if isinstance(n, ast.While):
            go(n.test, depth + 1)
            for c in n.body:
                go(c, depth + 1)
            for c in n.orelse:
                go(c, depth)
            return
        if isinstance(n, COMPREHENSIONS):
            level = depth
            for i, generator in enumerate(n.generators):
                go(generator.iter, level)
                level += 1
                go(generator.target, level)
                for condition in generator.ifs:
                    go(condition, level)
            for element in ([n.key, n.value] if isinstance(n, ast.DictComp) else [n.elt]):
                go(element, level)
            return
        for c in ast.iter_child_nodes(n):
            go(c, depth)

    for node in f.body_nodes():
        go(node, 0)


BUILTIN_CONTAINERS = {"list", "tuple", "set", "dict", "frozenset", "sorted", "bytearray"}


def allocates(p: Project, f: Fn, n: ast.AST) -> bool:
    """Creates an object on the heap: a list, set or dict literal or comprehension, a lambda, a class instance."""
    if isinstance(n, (ast.List, ast.Set, ast.Dict)):
        return not isinstance(getattr(n, "ctx", None), (ast.Store, ast.Del))
    if isinstance(n, (ast.ListComp, ast.SetComp, ast.DictComp, ast.Lambda)):
        return True
    if isinstance(n, ast.Call):
        return class_instantiation(p, f, n) is not None
    return False


def class_instantiation(p: Project, f: Fn, call: ast.Call):
    """The text of the class a call creates: a project class or a name in CapWords (PEP 8 class names)."""
    r = p.resolver
    ref = r.resolve(call.func, r.scope_of(f))
    name = dotted(call.func)
    if isinstance(ref, TypeRef):
        return name or ref.type.name
    if isinstance(ref, (FnRef, MemberRef, Value)) or name is None:
        return None
    tail = name.split(".")[-1]
    if tail[:1].isupper() and not tail.isupper():
        return name
    return None


def allocation_depth(p: Project, f: Fn) -> int:
    deepest = 0

    def visit(n, depth):
        nonlocal deepest
        if allocates(p, f, n):
            deepest = max(deepest, depth)

    walk_loops(f, visit)
    return deepest


GROWING = {"append", "extend", "insert", "add", "update", "setdefault", "appendleft", "extendleft"}


def is_literal_number(n) -> bool:
    if isinstance(n, ast.UnaryOp) and isinstance(n.op, (ast.USub, ast.UAdd)):
        n = n.operand
    return isinstance(n, ast.Constant) and isinstance(n.value, (int, float)) and not isinstance(n.value, bool)


def space_degree(p: Project, f: Fn, self_calls: int) -> int:
    """Collection growth in loops, lists of non-literal size ([x] * n), direct recursion."""
    degree = 0

    def visit(n, depth):
        nonlocal degree
        if isinstance(n, ast.Call) and isinstance(n.func, ast.Attribute) and n.func.attr in GROWING:
            ref = p.resolver.resolve(n.func, p.resolver.scope_of(f))
            if not isinstance(ref, FnRef):
                degree = max(degree, depth)
        if isinstance(n, ast.BinOp) and isinstance(n.op, ast.Mult):
            for sequence, size in ((n.left, n.right), (n.right, n.left)):
                if isinstance(sequence, ast.List) and not is_literal_number(size):
                    degree = max(degree, depth + 1)

    walk_loops(f, visit)
    if self_calls > 0:
        degree = max(degree, 1)
    return degree


def is_instance_method(f: Fn) -> bool:
    return f.owner is not None and f.owner.kind == "class" and f.has_body and f.kind == "method" and not f.is_static


def member_of(p: Project, f: Fn, node: ast.Attribute):
    """The member an attribute names, if it is an instance field or property of a project class."""
    ref = p.resolver.resolve(node, p.resolver.scope_of(f))
    if isinstance(ref, MemberRef):
        member = ref.member
        if member.owner.kind == "class" and member.kind != "literal" and not member.is_static and not ref.through_type:
            return member
    return None


def member_use(p: Project, f: Fn):
    """Fields and properties of its own type a function touches and, by owner, those of other project classes."""
    key = ("use", f.id)
    cache = p.__dict__.setdefault("_member_use", {})
    if key in cache:
        return cache[key]
    own: set = set()
    foreign: dict = {}
    for n in walk_body(f):
        if not isinstance(n, ast.Attribute):
            continue
        member = member_of(p, f, n)
        if member is None:
            continue
        if member.owner is f.owner:
            own.add(member)
        else:
            foreign.setdefault(member.owner.id, set()).add(member.name)
    cache[key] = (own, foreign)
    return own, foreign


def most_used_foreign(p: Project, f: Fn):
    _, foreign = member_use(p, f)
    best = ""
    for owner in sorted(foreign):
        if best == "" or len(foreign[owner]) > len(foreign[best]):
            best = owner
    return (best, sorted(foreign[best])) if best else ("", [])


def class_methods(t: TypeUnit) -> list:
    return [m for m in t.methods if m.kind == "method" and not m.is_static and m.has_body]


def wmc(t: TypeUnit) -> int:
    return sum(cyclomatic(m) for m in t.methods if m.kind != "accessor")


def dit(p: Project, t: TypeUnit, seen=None) -> int:
    """Longest chain of base classes; a base outside the project is one step, protocols and helpers do not count."""
    seen = seen or {t.id}
    depth = 0
    for base in t.project_bases:
        if base.kind == "protocol":
            continue
        if base.id in seen or base.kind != "class":
            depth = max(depth, 1)
        else:
            depth = max(depth, 1 + dit(p, base, seen | {base.id}))
    from .project import NOT_BASE_CLASSES

    for external in t.external_bases:
        if external.split(".")[-1] not in NOT_BASE_CLASSES:
            depth = max(depth, 1)
    return depth


def called_functions(p: Project, f: Fn) -> set:
    r = p.resolver
    scope = r.scope_of(f)
    result = set()
    for n in walk_body(f):
        if isinstance(n, ast.Call):
            ref = r.resolve(n.func, scope)
            if isinstance(ref, FnRef):
                result.add(ref.fn)
    return result


def lcom4(p: Project, t: TypeUnit):
    methods = class_methods(t)
    if not methods:
        return None
    parent = list(range(len(methods)))

    def find(i: int) -> int:
        while parent[i] != i:
            parent[i] = parent[parent[i]]
            i = parent[i]
        return i

    uses = [member_use(p, m)[0] for m in methods]
    calls = [called_functions(p, m) for m in methods]
    for i in range(len(methods)):
        for j in range(i + 1, len(methods)):
            if uses[i] & uses[j] or methods[j] in calls[i] or methods[i] in calls[j]:
                parent[find(i)] = find(j)
    return len({find(i) for i in range(len(methods))})


def tcc(p: Project, t: TypeUnit):
    methods = [m for m in class_methods(t) if m.visibility != "private"]
    if len(methods) < 2:
        return None
    uses = [member_use(p, m)[0] for m in methods]
    connected = sum(1 for i in range(len(uses)) for j in range(i + 1, len(uses)) if uses[i] & uses[j])
    return round_to(connected / (len(uses) * (len(uses) - 1) / 2), 4)


def atfd(p: Project, t: TypeUnit) -> int:
    seen = set()
    for m in t.methods:
        for owner, fields in member_use(p, m)[1].items():
            for name in fields:
                seen.add(f"{owner}.{name}")
    return len(seen)


SEPARATORS = {"(", ")", "{", "}", "[", "]", ";", ","}


def halstead_volume(f: Fn):
    """N log2 n over the tokens of the lines of a function, without separators."""
    total = 0
    distinct = set()
    for t in f.file.tokens:
        if f.place.startLine <= t.line <= f.place.endLine and not (t.kind == "op" and t.text in SEPARATORS):
            total += 1
            distinct.add(t.text)
    if len(distinct) < 2:
        return None
    return total * math.log2(len(distinct))


def maintainability_index(f: Fn):
    volume = halstead_volume(f)
    lines = f.place.endLine - f.place.startLine + 1
    if volume is None or lines == 0:
        return None
    return max(0.0, (171 - 5.2 * math.log(volume) - 0.23 * cyclomatic(f) - 16.2 * math.log(lines)) * 100 / 171)
