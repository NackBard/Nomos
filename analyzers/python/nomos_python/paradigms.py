"""Paradigm evidence of spec/paradigms.md and the conservative definition of a pure function."""
from __future__ import annotations

import ast

from .metrics import hof_order, walk_body
from .project import CONSTANT_NAME, FUNCTION_NODES, Fn, FnRef, GlobalRef, MemberRef, Module, Project, TypeRef, TypeUnit, Value

ACTIVATING = {"oop.classes", "str.free-functions", "str.control-flow", "fp.higher-order", "fp.pure-functions"}


def active_paradigms(evidence: list) -> list:
    return sorted({e["paradigm"] for e in evidence if e["kind"] in ACTIVATING})


def _add(result: list, paradigm: str, kind: str, description: str, ids: list, count=None) -> None:
    count = len(ids) if count is None else count
    if count == 0:
        return
    result.append({"paradigm": paradigm, "kind": kind, "count": count, "description": description, "examples": sorted(set(ids))[:5]})


def module_functions(m: Module) -> list:
    return list(m.functions) + [f for t in m.types for f in t.methods]


def has_control_flow(f: Fn) -> bool:
    kinds = (ast.If, ast.For, ast.AsyncFor, ast.While) + ((ast.Match,) if hasattr(ast, "Match") else ())
    return any(isinstance(n, kinds) for n in walk_body(f))


def collect_evidence(p: Project, m: Module, pure: set) -> list:
    result: list = []
    classes, mutable, inheriting, abstract, immutable = [], [], [], [], []
    for t in m.types:
        if t.kind == "class":
            state = [x for x in t.members if not x.is_static]
            if t.members or t.methods:
                classes.append(t.id)
            if any(x.mutable for x in state):
                mutable.append(t.id)
            elif state and t.frozen:
                immutable.append(t.id)
            if any(b.kind == "class" for b in t.project_bases):
                inheriting.append(t.id)
        if t.is_abstract:
            abstract.append(t.id)
    _add(result, "oop", "oop.classes", "classes with methods or fields", classes)
    _add(result, "oop", "oop.mutable-state-classes", "classes with mutable instance state", mutable)
    _add(result, "oop", "oop.inheritance", "project types inheriting project types", inheriting)
    _add(result, "oop", "oop.abstractions", "protocols and abstract classes", abstract)
    _add(result, "functional", "fp.immutable-types", "types whose instance state cannot change", immutable)

    free = [f.id for f in m.functions]
    flow, higher, pure_ids, lambda_owners = [], [], [], []
    for f in module_functions(m):
        if has_control_flow(f):
            flow.append(f.id)
        if f.has_body and hof_order(p, f) > 1:
            higher.append(f.id)
        if f in pure:
            pure_ids.append(f.id)
        for n in walk_body(f):
            if isinstance(n, ast.Call):
                for argument in list(n.args) + [k.value for k in n.keywords]:
                    if isinstance(argument, ast.Lambda):
                        lambda_owners.append(f.id)
    shared = [g.id for g in m.globals] + [f"{t.id}.{x.name}" for t in m.types for x in t.members if x.is_static and x.mutable]
    _add(result, "structural", "str.free-functions", "functions outside types", free)
    _add(result, "structural", "str.control-flow", "functions with branches or loops", flow)
    _add(result, "structural", "str.global-state", "module-level variables and class attributes assigned through the class", shared)
    _add(result, "functional", "fp.lambdas", "lambdas passed as arguments", lambda_owners, len(lambda_owners))
    _add(result, "functional", "fp.higher-order", "functions taking or returning functions", higher)
    _add(result, "functional", "fp.pure-functions", "functions that provably have no effects (conservative)", pure_ids)
    return sorted(result, key=lambda e: e["kind"])


def pure_functions(p: Project) -> set:
    """The conservative definition of spec/paradigms.md as a greatest fixed point."""
    pure = {f for f in p.functions.values() if f.has_body and f.kind in ("function", "method") and _locally_pure(p, f)}
    changed = True
    while changed:
        changed = False
        for f in sorted(pure, key=lambda x: x.id):
            if not _calls_only_pure(p, f, pure):
                pure.discard(f)
                changed = True
    return pure


PURE_BUILTINS = {"len", "abs", "min", "max", "round", "divmod", "pow", "int", "float", "str", "bool", "isinstance", "issubclass"}
FORBIDDEN = (ast.Lambda, ast.Global, ast.Nonlocal, ast.Await, ast.Yield, ast.YieldFrom, ast.Raise, ast.Delete, ast.With, ast.AsyncWith, ast.Assert,
             ast.ClassDef) + FUNCTION_NODES


def _readable_self(p: Project, f: Fn, node: ast.Attribute) -> bool:
    ref = p.resolver.resolve(node, p.resolver.scope_of(f))
    if isinstance(ref, MemberRef):
        member = ref.member
        if member.kind == "property":
            return not member.mutable
        return member.kind == "literal" or (member.kind == "field" and member.owner.frozen)
    return isinstance(ref, FnRef)


def _locally_pure(p: Project, f: Fn) -> bool:
    r = p.resolver
    scope = r.scope_of(f)
    for n in walk_body(f):
        if isinstance(n, FORBIDDEN):
            return False
        if isinstance(n, (ast.Assign, ast.AugAssign, ast.AnnAssign)):
            targets = n.targets if isinstance(n, ast.Assign) else [n.target]
            for target in targets:
                for part in ast.walk(target):
                    if isinstance(part, (ast.Attribute, ast.Subscript)) and isinstance(part.ctx, ast.Store):
                        return False
        if isinstance(n, (ast.For, ast.AsyncFor)):
            if any(isinstance(part, (ast.Attribute, ast.Subscript)) for part in ast.walk(n.target)):
                return False
        if isinstance(n, ast.Name) and isinstance(n.ctx, ast.Load):
            if n.id == scope.self_name or n.id == scope.cls_name or n.id in scope.locals:
                continue
            binding = f.module.bindings.get(n.id)
            if binding is None:
                if r.is_builtin(n.id, scope):
                    continue  # a builtin name; calls of it are checked below
                return False
            if binding.kind in ("type", "fn"):
                continue
            if _is_math(binding, True) or _is_math(binding, False):
                continue
            if binding.kind == "variable" and CONSTANT_NAME.match(n.id):
                continue
            return False
        if isinstance(n, ast.Attribute) and isinstance(n.value, ast.Name) and n.value.id == scope.self_name and isinstance(n.ctx, ast.Load):
            if not _readable_self(p, f, n):
                return False
        if isinstance(n, ast.Call):
            ref = r.resolve(n.func, scope)
            if isinstance(ref, TypeRef):
                t = ref.type
                if t.kind != "class" or any(x.kind == "constructor" for x in t.methods):
                    return False
    return True


def _is_str(p: Project, f: Fn, node: ast.AST) -> bool:
    if isinstance(node, (ast.Constant, ast.JoinedStr)) and (isinstance(node, ast.JoinedStr) or isinstance(node.value, str)):
        return True
    if isinstance(node, ast.Name):
        for a in f.args.posonlyargs + f.args.args + f.args.kwonlyargs:
            if a.arg == node.id and isinstance(a.annotation, ast.Name) and a.annotation.id == "str":
                return True
    return False


def _calls_only_pure(p: Project, f: Fn, pure: set) -> bool:
    r = p.resolver
    scope = r.scope_of(f)
    for n in walk_body(f):
        if not isinstance(n, ast.Call):
            continue
        func = n.func
        if isinstance(func, ast.Attribute):
            root = func.value
            if isinstance(root, ast.Name) and root.id not in scope.locals and _is_math(f.module.bindings.get(root.id), module=True):
                continue
            if _is_str(p, f, root):
                continue
        if isinstance(func, ast.Name):
            if func.id in PURE_BUILTINS and r.is_builtin(func.id, scope):
                continue
            if func.id not in scope.locals and _is_math(f.module.bindings.get(func.id), module=False):
                continue
        ref = r.resolve(func, scope)
        if isinstance(ref, TypeRef):
            continue  # creation of a project class without a constructor, checked above
        if isinstance(ref, FnRef) and ref.fn in pure:
            continue
        return False
    return True


def _is_math(binding, module: bool) -> bool:
    """`import math` (module) or `from math import sqrt`: the stand-in of System.Math."""
    if binding is None:
        return False
    if module:
        return binding.kind == "module" and binding.target == "math"
    return binding.kind == "from" and binding.target[0] == "math"
