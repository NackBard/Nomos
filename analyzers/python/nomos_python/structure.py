"""Structure of types and functions for facts 1.3.0, as spec/structure.md defines it for Python."""
from __future__ import annotations

import ast
import re

from .metrics import declared_parameters
from .project import Fn, Member, Project, TypeUnit, Value


def type_text(f_info, node: ast.AST | None):
    """An annotation as written, line breaks and runs of spaces collapsed; a string annotation without its quotes."""
    if node is None:
        return None
    if isinstance(node, ast.Constant) and isinstance(node.value, str):
        text = node.value
    else:
        text = ast.get_source_segment(f_info.text, node) or ast.unparse(node)
    text = re.sub(r"\s+", " ", text).strip()
    return text or None


def _target(p: Project, scope, annotation) -> tuple:
    value = p.resolver.annotation_value(annotation, scope)
    if value is None:
        return None, False
    if value.builtin is not None and value.builtin != "str":
        element = value.element
        if value.builtin == "tuple" and element is None:
            return None, False
        return (element.type.id if element is not None and element.type is not None else None), True
    return (value.type.id if value.type is not None else None), False


def members(p: Project, t: TypeUnit):
    if not t.members:
        return None
    result = []
    for m in t.members:
        entry = {"name": m.name, "kind": m.kind, "visibility": m.visibility}
        if m.kind != "literal":
            name = type_text(t.module.file, m.annotation)
            if name:
                entry["typeName"] = name
            if m.annotation is not None:
                scope = p.resolver.scope_of(m.value_fn) if m.value_fn else p.resolver.module_scope(t.module)
                target, collection = _target(p, scope, m.annotation)
                if target:
                    entry["type"] = target
                if collection:
                    entry["isCollection"] = True
            if m.is_static:
                entry["isStatic"] = True
        result.append(entry)
    return result


def parameters(f: Fn) -> list:
    result = []
    arguments = f.args
    for a in declared_parameters(f):
        name = a.arg
        if a is arguments.vararg:
            name = "*" + name
        elif a is arguments.kwarg:
            name = "**" + name
        entry = {"name": name}
        text = type_text(f.file, a.annotation)
        if text:
            entry["typeName"] = text
        result.append(entry)
    return result


def return_type_name(f: Fn):
    returns = getattr(f.node, "returns", None)
    if f.kind == "constructor" or returns is None:
        return None
    if isinstance(returns, ast.Constant) and returns.value is None:
        return None
    return type_text(f.file, returns)


def _names(t: TypeUnit, seen=None) -> set:
    seen = seen or set()
    if t in seen:
        return set()
    seen.add(t)
    own = {m.name for m in t.members} | {f.name for f in t.methods}
    for base in t.project_bases:
        own |= _names(base, seen)
    return own


def _named(t: TypeUnit, seen=None) -> set:
    seen = seen or set()
    if t in seen:
        return set()
    seen.add(t)
    result = set()
    for base in t.project_bases:
        result.add(base.id)
        result |= _named(base, seen)
    return result


def satisfies(p: Project, t: TypeUnit, all_types: list):
    """Project protocols a class matches by member names without naming them (spec/structure.md, Python)."""
    if t.kind != "class" or t.type_parameters:
        return None
    have = _names(t)
    named = _named(t)
    found = []
    for candidate in all_types:
        if candidate.kind != "protocol" or candidate.type_parameters or candidate.id in named:
            continue
        wanted = {m.name for m in candidate.members} | {f.name for f in candidate.methods}
        if wanted and wanted <= have:
            found.append(candidate.id)
    return sorted(found) or None
